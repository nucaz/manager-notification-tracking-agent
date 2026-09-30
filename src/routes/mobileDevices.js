const express = require('express');
const ExcelJS = require('exceljs');
const QRCode = require('qrcode');
const pool = require('../db/pool');
const { requireAuth, canWrite } = require('../middleware/auth');
const { moduleRequired } = require('../middleware/modules');
const { verifyCsrfToken } = require('../middleware/csrf');
const importService = require('../services/importService');
const { importUploader } = require('../services/uploadService');
const catalogService = require('../services/catalogService');
const employeeService = require('../services/employeeService');
const settingsService = require('../services/settingsService');
const mobileDeviceService = require('../services/mobileDeviceService');
const mobileLineService = require('../services/mobileLineService');
const { DECOMISO_MOTIVO } = require('../config/mobileLabels');

const auditService = require('../services/auditService');

const { validateDeviceData, imeiTaken, touchDevice, describeDeviceChanges } = mobileDeviceService;

const INCIDENT_TIPOS = ['reparacion', 'accidente', 'decomiso', 'baja'];
// Estados en los que el equipo no se puede asignar: primero se resuelve.
const NO_ASIGNABLE = { en_decomiso: 'está en decomiso (resuélvalo primero)', de_baja: 'está dado de baja' };

// 'YYYY-MM' -> { desde: 'YYYY-MM-01', hasta: 'YYYY-MM-<ultimo dia>' }.
// Sin mes (o invalido) cae al mes actual - el reporte de inventario nunca
// queda sin rango.
function monthRange(mes) {
  const match = /^(\d{4})-(\d{2})$/.exec(mes || '');
  const now = new Date();
  const year = match ? Number(match[1]) : now.getFullYear();
  const month = match ? Number(match[2]) : now.getMonth() + 1; // 1-12
  const desde = `${year}-${String(month).padStart(2, '0')}-01`;
  const ultimoDia = new Date(year, month, 0).getDate(); // dia 0 del mes siguiente = ultimo del actual
  const hasta = `${year}-${String(month).padStart(2, '0')}-${String(ultimoDia).padStart(2, '0')}`;
  const mesNormalizado = `${year}-${String(month).padStart(2, '0')}`;
  return { desde, hasta, mes: mesNormalizado };
}

const router = express.Router();
// verifyCsrfToken NO va aca a nivel de router: /importar es multipart y
// necesita que multer parsee el body antes de verificar el token (ver
// src/routes/attachments.js). Se aplica explicito en cada ruta POST.
router.use(requireAuth, moduleRequired('celulares'));

const FIELDS = [
  'imei', 'phone_country_code_id', 'phone_number', 'has_chip', 'asset_code', 'brand', 'model',
  'operadora', 'condicion', 'purchase_date', 'area', 'sede', 'status', 'notes',
];

async function loadCatalogOptions() {
  const [sedes, areas, marcas, modelos, operadoras, countries] = await Promise.all([
    catalogService.getActive('sede'),
    catalogService.getActive('area'),
    catalogService.getActive('marca'),
    catalogService.getActive('modelo'),
    catalogService.getActive('operadora'),
    catalogService.getActiveCountries(),
  ]);
  return { sedes, areas, marcas, modelos, operadoras, countries };
}

// Sugiere el siguiente codigo de activo disponible (prefijo + correlativo
// configurables desde Configuracion). Busca el correlativo mas alto ya
// usado CON ese prefijo (no un contador aparte en settings, que se
// desincroniza si se borra un celular o se carga uno con codigo manual)
// y le suma 1. Sigue siendo editable a mano en el formulario - esto es
// solo una sugerencia, no un valor forzado.
async function computeNextAssetCode() {
  const [prefix, digitsRaw] = await Promise.all([
    settingsService.get('mobile_asset_code_prefix'),
    settingsService.get('mobile_asset_code_digits'),
  ]);
  const digits = parseInt(digitsRaw, 10) || 5;
  const [rows] = await pool.query(
    'SELECT asset_code FROM mobile_devices WHERE asset_code LIKE ?',
    [`${prefix}%`]
  );
  let max = 0;
  for (const row of rows) {
    const suffix = row.asset_code.slice(prefix.length);
    if (/^\d+$/.test(suffix)) {
      max = Math.max(max, parseInt(suffix, 10));
    }
  }
  return prefix + String(max + 1).padStart(digits, '0');
}

// Columnas de la importacion masiva. Estado y Operadora son opcionales:
// sin Estado, un equipo con usuario queda "asignado" y sin usuario "en_stock".
// Con Estado = en_reparacion se registra ademas su incidente de reparacion.
const IMPORT_COLUMNS = [
  { header: 'IMEI', field: 'imei', required: true },
  { header: 'Número', field: 'phone_number' },
  { header: 'Tiene chip', field: 'has_chip', type: 'bool' },
  { header: 'Código', field: 'asset_code' },
  { header: 'Marca', field: 'brand' },
  { header: 'Modelo', field: 'model' },
  { header: 'Fecha de compra', field: 'purchase_date', type: 'date' },
  { header: 'Condición', field: 'condicion' },
  { header: 'Área', field: 'area', required: true },
  { header: 'Sede', field: 'sede' },
  { header: 'Usuario asignado', field: 'holder_name' },
  { header: 'Cargo', field: 'cargo' },
  { header: 'Turno', field: 'turno' },
  { header: 'Fecha de entrega', field: 'assigned_date', type: 'date' },
  { header: 'Observación', field: 'observacion' },
  { header: 'Estado', field: 'status' },
  { header: 'Operadora', field: 'operadora' },
];

function readForm(body) {
  const out = {};
  for (const f of FIELDS) {
    let v = body[f];
    if (v === '') v = null;
    if (f === 'has_chip') v = v ? 1 : 0;
    out[f] = v;
  }
  return out;
}

router.get('/', async (req, res, next) => {
  try {
    const { q, area, sede, status } = req.query;
    let sql = `
      SELECT d.*, a.holder_name, a.cargo, a.turno, a.assigned_date
      FROM mobile_devices d
      LEFT JOIN mobile_device_assignments a ON a.device_id = d.id AND a.returned_date IS NULL
      WHERE 1=1`;
    const params = [];
    if (q) {
      sql += ' AND (d.imei LIKE ? OR d.asset_code LIKE ? OR d.phone_number LIKE ? OR a.holder_name LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (area) {
      sql += ' AND d.area = ?';
      params.push(area);
    }
    if (sede) {
      sql += ' AND d.sede = ?';
      params.push(sede);
    }
    if (status) {
      sql += ' AND d.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY d.area, d.id';
    const [rows] = await pool.query(sql, params);
    const [areaRows] = await pool.query('SELECT DISTINCT area FROM mobile_devices ORDER BY area');
    const [sedeRows] = await pool.query(
      'SELECT DISTINCT sede FROM mobile_devices WHERE sede IS NOT NULL AND sede <> "" ORDER BY sede'
    );
    res.render('mobileDevices/list', {
      title: 'Celulares',
      items: rows,
      areas: areaRows.map((r) => r.area),
      sedes: sedeRows.map((r) => r.sede),
      q: q || '',
      area: area || '',
      sede: sede || '',
      status: status || '',
      // Los botones de exportar respetan los filtros activos (sin filtros = todo).
      exportQuery: exportQueryString(req.query),
    });
  } catch (err) {
    next(err);
  }
});

function exportQueryString({ q, area, sede, status }) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ q, area, sede, status })) {
    if (v) params.set(k, v);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

// Texto que Excel podria interpretar como formula al abrir el CSV (=, +, -,
// @) se antepone con una comilla simple, y se entrecomilla si hace falta.
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Exporta TODOS los celulares (o los que cumplan los filtros de la URL) con
// todos sus datos. Van antes de /:id a proposito (mismo motivo que /resumen).
router.get('/exportar.csv', async (req, res, next) => {
  try {
    const rows = await mobileDeviceService.fetchDevicesForExport(req.query);
    const lines = [mobileDeviceService.EXPORT_HEADERS, ...rows].map((r) => r.map(csvCell).join(','));
    const fecha = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="celulares_${fecha}.csv"`);
    res.send('﻿' + lines.join('\r\n') + '\r\n'); // BOM: Excel abre bien los acentos
  } catch (err) {
    next(err);
  }
});

router.get('/exportar.xlsx', async (req, res, next) => {
  try {
    const rows = await mobileDeviceService.fetchDevicesForExport(req.query);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Celulares');
    sheet.addRow(mobileDeviceService.EXPORT_HEADERS);
    // Todo como texto: IMEI, numeros y codigos no deben verse en notacion
    // cientifica ni perder ceros. Los textos que empiezan con "=" se guardan
    // como texto (ExcelJS no los evalua), no como formula.
    rows.forEach((r) => sheet.addRow(r.map((v) => (typeof v === 'number' ? v : String(v)))));
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: mobileDeviceService.EXPORT_HEADERS.length } };
    const widths = [18, 12, 10, 10, 12, 14, 14, 10, 26, 16, 34, 24, 14, 14, 40, 14, 12, 10, 8, 30, 10, 20, 20];
    widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });

    const buffer = await workbook.xlsx.writeBuffer();
    const fecha = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="celulares_${fecha}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.get('/nuevo', canWrite, async (req, res, next) => {
  try {
    const [catalogs, suggestedAssetCode] = await Promise.all([
      loadCatalogOptions(),
      computeNextAssetCode(),
    ]);
    res.render('mobileDevices/form', {
      title: 'Nuevo celular',
      item: { asset_code: suggestedAssetCode },
      errors: [],
      ...catalogs,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/nuevo', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const data = readForm(req.body);
    const errors = await validateDeviceData(data);
    if (data.imei && (await imeiTaken(data.imei))) {
      errors.push('Ya existe un celular registrado con ese IMEI.');
    }
    if (data.status === 'en_decomiso') {
      errors.push('El decomiso se registra desde el detalle del celular (con fecha y motivo).');
    }
    const chipConflict = data.has_chip ? await mobileLineService.deviceChipConflict(data.phone_number, null) : null;
    if (chipConflict) errors.push(chipConflict);
    if (errors.length > 0) {
      errors.forEach((e) => req.flash('error', e));
      return res.redirect('/celulares/nuevo');
    }
    const cols = Object.keys(data);
    const values = Object.values(data);
    const placeholders = cols.map(() => '?').join(', ');
    const [ins] = await pool.query(
      `INSERT INTO mobile_devices (${cols.join(', ')}, created_by) VALUES (${placeholders}, ?)`,
      [...values, req.session.user.id]
    );
    await mobileLineService.syncDeviceChip(ins.insertId, null, req.session.user.id);
    await auditService.log(req, {
      user: req.session.user,
      action: 'celular_creado',
      target: `Celular ${data.imei}`,
      detail: `Código ${data.asset_code || '—'}, área ${data.area}, sede ${data.sede || '—'}`,
    });
    req.flash('success', 'Celular registrado correctamente.');
    res.redirect('/celulares');
  } catch (err) {
    next(err);
  }
});

router.get('/:id/editar', canWrite, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM mobile_devices WHERE id = ?', [req.params.id]);
    if (!rows[0]) {
      req.flash('error', 'Celular no encontrado.');
      return res.redirect('/celulares');
    }
    const catalogs = await loadCatalogOptions();
    res.render('mobileDevices/form', { title: 'Editar celular', item: rows[0], errors: [], ...catalogs });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/editar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const data = readForm(req.body);
    const [[oldRow]] = await pool.query('SELECT * FROM mobile_devices WHERE id = ?', [req.params.id]);
    if (!oldRow) {
      req.flash('error', 'Celular no encontrado.');
      return res.redirect('/celulares');
    }
    const errors = await validateDeviceData(data);
    if (data.imei && (await imeiTaken(data.imei, oldRow.id))) {
      errors.push('Otro celular ya usa ese IMEI.');
    }
    if (data.status === 'en_decomiso' && oldRow.status !== 'en_decomiso') {
      errors.push('El decomiso se registra desde el detalle del celular (con fecha y motivo).');
    } else if (oldRow.status === 'en_decomiso' && data.status !== 'en_decomiso') {
      errors.push('El equipo está en decomiso: use "Resolver decomiso" en su detalle para devolverlo a stock.');
    }
    const chipConflict = data.has_chip ? await mobileLineService.deviceChipConflict(data.phone_number, oldRow.id) : null;
    if (chipConflict) errors.push(chipConflict);
    if (errors.length > 0) {
      errors.forEach((e) => req.flash('error', e));
      return res.redirect(`/celulares/${req.params.id}/editar`);
    }
    const changes = await describeDeviceChanges(oldRow, data);
    const cols = Object.keys(data);
    const values = Object.values(data);
    const setClause = cols.map((c) => `${c} = ?`).join(', ');
    await pool.query(`UPDATE mobile_devices SET ${setClause} WHERE id = ?`, [...values, req.params.id]);
    await mobileLineService.syncDeviceChip(oldRow.id, oldRow.has_chip ? oldRow.phone_number : null, req.session.user.id);
    if (changes) {
      await auditService.log(req, {
        user: req.session.user,
        action: 'celular_editado',
        target: `Celular ${oldRow.imei}`,
        detail: changes,
      });
    }
    req.flash('success', changes ? 'Celular actualizado correctamente.' : 'No había cambios que guardar.');
    res.redirect(`/celulares/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/eliminar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const [[device]] = await pool.query(
      'SELECT imei, asset_code, area, sede, status FROM mobile_devices WHERE id = ?',
      [req.params.id]
    );
    if (!device) {
      req.flash('error', 'Celular no encontrado.');
      return res.redirect('/celulares');
    }
    await pool.query('DELETE FROM mobile_devices WHERE id = ?', [req.params.id]);
    await auditService.log(req, {
      user: req.session.user,
      action: 'celular_eliminado',
      target: `Celular ${device.imei}`,
      detail: `Código ${device.asset_code || '—'}, área ${device.area}, sede ${device.sede || '—'}, estado ${device.status}`,
    });
    req.flash('success', 'Celular eliminado.');
    res.redirect('/celulares');
  } catch (err) {
    next(err);
  }
});

router.post('/eliminar-multiple', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const ids = [].concat(req.body.ids || []).map((id) => parseInt(id, 10)).filter(Number.isInteger);
    if (ids.length === 0) {
      req.flash('error', 'No seleccionaste ningún celular para eliminar.');
      return res.redirect('/celulares');
    }
    const [devices] = await pool.query('SELECT imei FROM mobile_devices WHERE id IN (?)', [ids]);
    const [result] = await pool.query('DELETE FROM mobile_devices WHERE id IN (?)', [ids]);
    const imeis = devices.map((d) => d.imei);
    const listado = imeis.length > 20 ? `${imeis.slice(0, 20).join(', ')}... y ${imeis.length - 20} más` : imeis.join(', ');
    await auditService.log(req, {
      user: req.session.user,
      action: 'celular_eliminado_multiple',
      target: `${result.affectedRows} celular(es)`,
      detail: `IMEI: ${listado}`,
    });
    req.flash('success', `${result.affectedRows} celular(es) eliminado(s).`);
    res.redirect('/celulares');
  } catch (err) {
    next(err);
  }
});

// Asigna (o reasigna, si ya habia una asignacion activa) el celular a una
// persona. La persona se identifica por DNI: si ya existe en el
// directorio de empleados se actualiza (por si cambio de area/sede/cargo),
// si no existe se crea. El area/sede del equipo se actualizan tambien,
// para reflejar donde esta realmente hoy.
router.post('/:id/asignar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const { dni, first_name, last_name, area, sede, cargo, turno, assigned_date, observacion } = req.body;
    if (!dni || !first_name || !last_name || !area) {
      req.flash('error', 'DNI, nombres, apellidos y área son obligatorios.');
      return res.redirect(`/celulares/${req.params.id}`);
    }
    if (!/^\d{8}$/.test(dni)) {
      req.flash('error', 'El DNI debe tener exactamente 8 dígitos numéricos.');
      return res.redirect(`/celulares/${req.params.id}`);
    }
    const [[deviceBefore]] = await pool.query('SELECT imei, status FROM mobile_devices WHERE id = ?', [req.params.id]);
    if (!deviceBefore) {
      req.flash('error', 'Celular no encontrado.');
      return res.redirect('/celulares');
    }
    if (NO_ASIGNABLE[deviceBefore.status]) {
      req.flash('error', `No se puede asignar: el celular ${NO_ASIGNABLE[deviceBefore.status]}.`);
      return res.redirect(`/celulares/${req.params.id}`);
    }
    const employeeId = await employeeService.upsert(
      { dni, first_name, last_name, area, sede, cargo },
      req.session.user.id
    );
    const holderName = `${first_name} ${last_name}`;

    await pool.query(
      'UPDATE mobile_device_assignments SET returned_date = CURDATE() WHERE device_id = ? AND returned_date IS NULL',
      [req.params.id]
    );
    await pool.query(
      `INSERT INTO mobile_device_assignments
        (device_id, employee_id, holder_name, cargo, turno, assigned_date, observacion, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.params.id,
        employeeId,
        holderName,
        cargo || null,
        turno || null,
        assigned_date || null,
        observacion || null,
        req.session.user.id,
      ]
    );
    await pool.query('UPDATE mobile_devices SET status = "asignado", area = ?, sede = ?, updated_at = NOW() WHERE id = ?', [
      area,
      sede || null,
      req.params.id,
    ]);
    await auditService.log(req, {
      user: req.session.user,
      action: 'celular_asignado',
      target: `Celular ${deviceBefore.imei}`,
      detail: `Asignado a ${holderName} (DNI ${dni}), ${cargo || 'sin cargo'}, área ${area}${sede ? `, sede ${sede}` : ''}`,
    });
    req.flash('success', 'Celular asignado correctamente.');
    res.redirect(`/celulares/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// Corrige los datos de la persona a la que esta asignado el equipo HOY (DNI,
// nombres, apellidos, cargo, turno, fecha de entrega, observacion), sin
// cerrar la asignacion ni crear una nueva - para un error de tipeo, no para
// un cambio de persona (eso es Reasignar). Cada cambio queda en Auditoria.
router.post('/:id/usuario', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const back = `/celulares/${req.params.id}`;
    const clean = (v) => String(v === undefined || v === null ? '' : v).trim();
    const dni = clean(req.body.dni);
    const first = clean(req.body.first_name);
    const last = clean(req.body.last_name);
    const cargo = clean(req.body.cargo);
    const turno = clean(req.body.turno);
    const fecha = clean(req.body.assigned_date);
    const obs = clean(req.body.observacion);

    const [[device]] = await pool.query('SELECT id, imei, area, sede FROM mobile_devices WHERE id = ?', [req.params.id]);
    if (!device) {
      req.flash('error', 'Celular no encontrado.');
      return res.redirect('/celulares');
    }
    const [[current]] = await pool.query(
      `SELECT a.*, e.dni AS emp_dni, e.first_name AS emp_first, e.last_name AS emp_last
       FROM mobile_device_assignments a
       LEFT JOIN employees e ON e.id = a.employee_id
       WHERE a.device_id = ? AND a.returned_date IS NULL`,
      [device.id]
    );
    if (!current) {
      req.flash('error', 'Este celular no tiene una asignación activa que editar.');
      return res.redirect(back);
    }

    const errors = [];
    if (!/^\d{8}$/.test(dni)) errors.push('El DNI debe tener exactamente 8 dígitos numéricos.');
    if (!first || !last) errors.push('Nombres y apellidos son obligatorios.');
    if (first.length > 100 || last.length > 100) errors.push('Nombres y apellidos: máximo 100 caracteres cada uno.');
    if (cargo.length > 150) errors.push('El cargo no puede superar los 150 caracteres.');
    if (turno.length > 50) errors.push('El turno no puede superar los 50 caracteres.');
    if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) errors.push('La fecha de entrega no es válida.');
    if (errors.length > 0) {
      errors.forEach((e) => req.flash('error', e));
      return res.redirect(back);
    }

    let employeeId = current.employee_id;
    let linked = '';
    if (employeeId) {
      // Persona ya vinculada al directorio: se corrige su ficha (afecta todas sus asignaciones).
      const [[other]] = await pool.query('SELECT id, first_name, last_name FROM employees WHERE dni = ? AND id <> ?', [dni, employeeId]);
      if (other) {
        req.flash('error', `Ya existe otro empleado con el DNI ${dni} (${other.first_name} ${other.last_name}). Si es otra persona, usa Reasignar.`);
        return res.redirect(back);
      }
      await pool.query(
        'UPDATE employees SET dni = ?, first_name = ?, last_name = ?, cargo = COALESCE(NULLIF(?, ""), cargo) WHERE id = ?',
        [dni, first, last, cargo, employeeId]
      );
    } else {
      // Asignacion importada como texto: se vincula a un empleado del directorio (existente por DNI, o nuevo).
      const existing = await employeeService.findByDni(dni);
      if (existing) {
        employeeId = existing.id;
        linked = `vinculado al empleado existente ${existing.first_name} ${existing.last_name}`;
      } else {
        const [ins] = await pool.query(
          `INSERT INTO employees (dni, first_name, last_name, area, sede, cargo, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [dni, first, last, device.area, device.sede || null, cargo || null, req.session.user.id]
        );
        employeeId = ins.insertId;
        linked = 'creado en el directorio de empleados';
      }
    }

    const before = {
      dni: current.emp_dni || '', nombres: current.emp_first || '', apellidos: current.emp_last || '',
      texto: current.holder_name || '', cargo: current.cargo || '', turno: current.turno || '',
      fecha: current.assigned_date || '', obs: current.observacion || '',
    };
    const holderName = `${first} ${last}`;
    await pool.query(
      `UPDATE mobile_device_assignments
       SET employee_id = ?, holder_name = ?, cargo = ?, turno = ?, assigned_date = ?, observacion = ?
       WHERE id = ?`,
      [employeeId, holderName, cargo || null, turno || null, fecha || null, obs || null, current.id]
    );

    const parts = [];
    const cmp = (label, a, b) => { if (a !== b) parts.push(`${label}: "${a || '—'}" → "${b || '—'}"`); };
    cmp('DNI', before.dni, dni);
    if (before.nombres || before.apellidos) {
      cmp('Nombres', before.nombres, first);
      cmp('Apellidos', before.apellidos, last);
    } else {
      cmp('Usuario (texto importado)', before.texto, holderName);
    }
    cmp('Cargo', before.cargo, cargo);
    cmp('Turno', before.turno, turno);
    cmp('Fecha de entrega', before.fecha, fecha);
    cmp('Observación', before.obs, obs);
    if (linked) parts.push(linked);

    if (parts.length > 0) {
      await touchDevice(device.id);
      await auditService.log(req, {
        user: req.session.user,
        action: 'celular_usuario_editado',
        target: `Celular ${device.imei}`,
        detail: parts.join('; '),
      });
      req.flash('success', 'Datos del usuario actualizados. El cambio quedó registrado en Auditoría.');
    } else {
      req.flash('success', 'No había cambios que guardar.');
    }
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

// Cierra la asignacion activa sin crear una nueva (vuelve a stock).
router.post('/:id/devolver', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const [[device]] = await pool.query('SELECT imei FROM mobile_devices WHERE id = ?', [req.params.id]);
    if (!device) {
      req.flash('error', 'Celular no encontrado.');
      return res.redirect('/celulares');
    }
    const [[activeAssignment]] = await pool.query(
      'SELECT holder_name FROM mobile_device_assignments WHERE device_id = ? AND returned_date IS NULL',
      [req.params.id]
    );
    await pool.query(
      'UPDATE mobile_device_assignments SET returned_date = CURDATE() WHERE device_id = ? AND returned_date IS NULL',
      [req.params.id]
    );
    await pool.query('UPDATE mobile_devices SET status = "en_stock", updated_at = NOW() WHERE id = ?', [req.params.id]);
    await auditService.log(req, {
      user: req.session.user,
      action: 'celular_devuelto_stock',
      target: `Celular ${device.imei}`,
      detail: activeAssignment ? `Devuelto por ${activeAssignment.holder_name}` : 'Devuelto a stock',
    });
    req.flash('success', 'Celular devuelto a stock.');
    res.redirect(`/celulares/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// Nota: /importar, /importar/plantilla y /resumen van antes de /:id a
// proposito (ver src/routes/attachments.js) para que Express no confunda
// esos segmentos con un id.
router.get('/importar', canWrite, (req, res) => {
  res.render('import', {
    title: 'Importar celulares',
    listUrl: '/celulares',
    actionUrl: '/celulares/importar',
    templateUrl: '/celulares/importar/plantilla',
    columns: IMPORT_COLUMNS,
    results: null,
  });
});

router.get('/importar/plantilla', canWrite, async (req, res, next) => {
  try {
    const buffer = await importService.buildTemplateBuffer(IMPORT_COLUMNS);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_celulares.xlsx"');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// Importacion propia (no el generico importService.importRows): cada fila
// puede generar varios registros relacionados (equipo, asignacion activa e
// incidente de reparacion). La logica vive en mobileDeviceService para que
// la use tambien el script de linea de comandos (npm run import:celulares).
router.post('/importar', canWrite, importUploader.single('file'), verifyCsrfToken, async (req, res, next) => {
  try {
    if (!req.file) {
      req.flash('error', 'Debes seleccionar un archivo.');
      return res.redirect('/celulares/importar');
    }
    const rows = await importService.parseSpreadsheet(req.file.buffer, req.file.originalname);
    const { imported, errors } = await mobileDeviceService.importDevices(rows, req.session.user.id);
    res.render('import', {
      title: 'Importar celulares',
      listUrl: '/celulares',
      actionUrl: '/celulares/importar',
      templateUrl: '/celulares/importar/plantilla',
      columns: IMPORT_COLUMNS,
      results: { imported, errors },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/resumen', async (req, res, next) => {
  try {
    const [counts] = await pool.query(
      'SELECT area, COUNT(*) AS total, SUM(status = "asignado") AS asignados FROM mobile_devices GROUP BY area ORDER BY area'
    );
    if (counts.length > 0) {
      const placeholders = counts.map(() => '(?)').join(', ');
      await pool.query(
        `INSERT IGNORE INTO mobile_device_area_audits (area) VALUES ${placeholders}`,
        counts.map((c) => c.area)
      );
    }
    const [audits] = await pool.query('SELECT * FROM mobile_device_area_audits ORDER BY area');
    const auditsByArea = Object.fromEntries(audits.map((a) => [a.area, a]));

    const totalEquipos = counts.reduce((sum, c) => sum + c.total, 0);
    const totalAsignados = counts.reduce((sum, c) => sum + Number(c.asignados || 0), 0);

    res.render('mobileDevices/resumen', {
      title: 'Resumen de celulares',
      counts,
      auditsByArea,
      totalEquipos,
      totalAsignados,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/resumen/:area/actualizar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const { estatus, ultima_fecha, observacion } = req.body;
    await pool.query(
      `INSERT INTO mobile_device_area_audits (area, estatus, ultima_fecha, observacion, updated_by)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE estatus = VALUES(estatus), ultima_fecha = VALUES(ultima_fecha),
         observacion = VALUES(observacion), updated_by = VALUES(updated_by)`,
      [req.params.area, estatus || 'pendiente', ultima_fecha || null, observacion || null, req.session.user.id]
    );
    req.flash('success', `Checklist de "${req.params.area}" actualizado.`);
    res.redirect('/celulares/resumen');
  } catch (err) {
    next(err);
  }
});

// Registra un incidente (reparacion/accidente/baja). 'reparacion' y
// 'baja' actualizan el status del equipo; 'accidente' queda como
// registro informativo sin forzar un cambio de estado (el equipo puede
// seguir en uso tras un golpe menor).
// returnTo (opcional): permite registrar el incidente desde otra pantalla
// (ej. el detalle del empleado) y volver ahi en vez del detalle del
// celular. Se valida como ruta relativa propia de la app, nunca una URL
// externa (evita un open redirect).
function safeReturnTo(value, fallback) {
  return typeof value === 'string' && /^\/[a-zA-Z0-9/_-]*$/.test(value) ? value : fallback;
}

router.post('/:id/incidentes', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const { tipo, fecha, descripcion, costo } = req.body;
    const motivo = tipo === 'decomiso' ? req.body.motivo : null;
    const redirectTo = safeReturnTo(req.body.returnTo, `/celulares/${req.params.id}`);
    if (!INCIDENT_TIPOS.includes(tipo) || !fecha) {
      req.flash('error', 'El tipo y la fecha del incidente son obligatorios.');
      return res.redirect(redirectTo);
    }
    if (tipo === 'decomiso' && !DECOMISO_MOTIVO[motivo]) {
      req.flash('error', `Indique el motivo del decomiso (${Object.values(DECOMISO_MOTIVO).join(', ')}).`);
      return res.redirect(redirectTo);
    }
    const [[device]] = await pool.query('SELECT imei, status FROM mobile_devices WHERE id = ?', [req.params.id]);
    if (!device) {
      req.flash('error', 'Celular no encontrado.');
      return res.redirect('/celulares');
    }
    if (tipo === 'decomiso' && ['en_decomiso', 'de_baja'].includes(device.status)) {
      req.flash('error', device.status === 'de_baja' ? 'El celular está dado de baja.' : 'El celular ya está en decomiso.');
      return res.redirect(redirectTo);
    }
    await pool.query(
      `INSERT INTO mobile_device_incidents (device_id, tipo, motivo, fecha, descripcion, costo, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.params.id, tipo, motivo, fecha, descripcion || null, costo || null, req.session.user.id]
    );
    if (tipo === 'decomiso') {
      await pool.query('UPDATE mobile_devices SET status = "en_decomiso" WHERE id = ?', [req.params.id]);
    } else if (tipo === 'baja') {
      // Una baja cierra el decomiso que estuviera abierto: el equipo no vuelve.
      await pool.query(
        "UPDATE mobile_device_incidents SET fecha_resolucion = ? WHERE device_id = ? AND tipo = 'decomiso' AND fecha_resolucion IS NULL",
        [fecha, req.params.id]
      );
    }
    if (tipo === 'reparacion') {
      await pool.query('UPDATE mobile_devices SET status = "en_reparacion" WHERE id = ?', [req.params.id]);
    } else if (tipo === 'baja') {
      await pool.query('UPDATE mobile_devices SET status = "de_baja" WHERE id = ?', [req.params.id]);
    }
    await touchDevice(req.params.id);
    await auditService.log(req, {
      user: req.session.user,
      action: 'celular_incidente_registrado',
      target: `Celular ${device.imei}`,
      detail: `Tipo ${tipo}${motivo ? ` (motivo: ${DECOMISO_MOTIVO[motivo]})` : ''}, fecha ${fecha}${costo ? `, costo ${costo}` : ''}${descripcion ? `: ${descripcion}` : ''}`,
    });
    req.flash('success', 'Incidente registrado correctamente.');
    res.redirect(redirectTo);
  } catch (err) {
    next(err);
  }
});

// Cierra una reparacion (fecha_resolucion) y devuelve el equipo a
// servicio: a "asignado" si tenia una asignacion activa, si no a
// "en_stock" - mismo criterio que /devolver.
router.post('/:id/incidentes/:incidentId/resolver', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const [[incident]] = await pool.query(
      `SELECT id, tipo, motivo FROM mobile_device_incidents
       WHERE id = ? AND device_id = ? AND tipo IN ('reparacion', 'decomiso') AND fecha_resolucion IS NULL`,
      [req.params.incidentId, req.params.id]
    );
    if (!incident) {
      req.flash('error', 'No se encontró una reparación o decomiso pendiente con ese id.');
      return res.redirect(`/celulares/${req.params.id}`);
    }
    await pool.query('UPDATE mobile_device_incidents SET fecha_resolucion = CURDATE() WHERE id = ?', [incident.id]);
    const [[device]] = await pool.query('SELECT imei FROM mobile_devices WHERE id = ?', [req.params.id]);
    const [[activeAssignment]] = await pool.query(
      'SELECT id, holder_name FROM mobile_device_assignments WHERE device_id = ? AND returned_date IS NULL',
      [req.params.id]
    );
    let nuevoEstado;
    let extra = '';
    if (incident.tipo === 'decomiso') {
      // Al terminar un decomiso el equipo vuelve a stock (no a quien lo
      // tenia): su asignacion se cierra con fecha de hoy.
      nuevoEstado = 'en_stock';
      if (activeAssignment) {
        await pool.query(
          `UPDATE mobile_device_assignments SET returned_date = CURDATE(),
             observacion = TRIM(BOTH ' - ' FROM CONCAT_WS(' - ', observacion, 'Cerrada al resolver el decomiso'))
           WHERE id = ?`,
          [activeAssignment.id]
        );
        extra = `; se cerró la asignación de ${activeAssignment.holder_name}`;
      }
    } else {
      nuevoEstado = activeAssignment ? 'asignado' : 'en_stock';
    }
    await pool.query('UPDATE mobile_devices SET status = ? WHERE id = ?', [nuevoEstado, req.params.id]);
    await touchDevice(req.params.id);
    const nombre = incident.tipo === 'decomiso' ? `Decomiso (${DECOMISO_MOTIVO[incident.motivo] || 'sin motivo'})` : 'Reparación';
    await auditService.log(req, {
      user: req.session.user,
      action: 'celular_incidente_resuelto',
      target: `Celular ${device ? device.imei : req.params.id}`,
      detail: `${nombre} #${incident.id} resuelto, equipo vuelve a "${nuevoEstado}"${extra}`,
    });
    req.flash('success', incident.tipo === 'decomiso' ? `Decomiso resuelto: el celular volvió a stock${extra}.` : 'Reparación marcada como resuelta.');
    res.redirect(`/celulares/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// Inventario mensual (por sede/area, incluye incidentes del mes elegido).
// No es exclusivo de septiembre ni de un solo mes: ?mes=AAAA-MM cambia el
// rango; sin parametro cae al mes actual. Va antes de /:id a proposito
// (mismo motivo que /resumen y /importar - ver nota mas arriba).
router.get('/inventario', async (req, res, next) => {
  try {
    const { desde, hasta, mes } = monthRange(req.query.mes);
    const [items] = await pool.query(
      `SELECT d.*, a.holder_name
       FROM mobile_devices d
       LEFT JOIN mobile_device_assignments a ON a.device_id = d.id AND a.returned_date IS NULL
       ORDER BY d.sede, d.area, d.id`
    );
    const [incidents] = await pool.query(
      `SELECT i.*, d.imei, d.asset_code, d.area, d.sede, d.model
       FROM mobile_device_incidents i
       JOIN mobile_devices d ON d.id = i.device_id
       WHERE i.fecha BETWEEN ? AND ?
       ORDER BY i.fecha DESC, i.id DESC`,
      [desde, hasta]
    );
    const summary = {
      total: items.length,
      asignados: items.filter((i) => i.status === 'asignado').length,
      enStock: items.filter((i) => i.status === 'en_stock').length,
      enReparacion: items.filter((i) => i.status === 'en_reparacion').length,
      enDecomiso: items.filter((i) => i.status === 'en_decomiso').length,
      deBaja: items.filter((i) => i.status === 'de_baja').length,
    };
    res.render('mobileDevices/inventario', {
      title: 'Inventario mensual de celulares',
      items,
      incidents,
      summary,
      mes,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/inventario/exportar.xlsx', async (req, res, next) => {
  try {
    const { desde, hasta, mes } = monthRange(req.query.mes);
    const [items] = await pool.query(
      `SELECT d.*, a.holder_name
       FROM mobile_devices d
       LEFT JOIN mobile_device_assignments a ON a.device_id = d.id AND a.returned_date IS NULL
       ORDER BY d.sede, d.area, d.id`
    );
    const [incidents] = await pool.query(
      `SELECT i.*, d.imei, d.asset_code, d.area, d.sede, d.model
       FROM mobile_device_incidents i
       JOIN mobile_devices d ON d.id = i.device_id
       WHERE i.fecha BETWEEN ? AND ?
       ORDER BY i.fecha DESC, i.id DESC`,
      [desde, hasta]
    );

    const workbook = new ExcelJS.Workbook();

    const inventario = workbook.addWorksheet('Inventario');
    inventario.addRow(['Sede', 'Área', 'IMEI', 'Código', 'Marca', 'Modelo', 'Estado', 'Usuario asignado', 'Notas']);
    for (const it of items) {
      inventario.addRow([
        it.sede || '', it.area, it.imei, it.asset_code || '', it.brand || '', it.model || '',
        it.status, it.holder_name || '', it.notes || '',
      ]);
    }
    inventario.getRow(1).font = { bold: true };
    inventario.columns.forEach((c) => { c.width = 18; });

    const hojaIncidentes = workbook.addWorksheet(`Incidentes ${mes}`);
    hojaIncidentes.addRow(['Fecha', 'Tipo', 'Sede', 'Área', 'IMEI', 'Código', 'Descripción', 'Costo', 'Resuelta']);
    for (const inc of incidents) {
      hojaIncidentes.addRow([
        inc.fecha, inc.tipo, inc.sede || '', inc.area, inc.imei, inc.asset_code || '',
        inc.descripcion || '', inc.costo || '',
        inc.tipo === 'reparacion' ? (inc.fecha_resolucion ? `Sí (${inc.fecha_resolucion})` : 'No') : '—',
      ]);
    }
    hojaIncidentes.getRow(1).font = { bold: true };
    hojaIncidentes.columns.forEach((c) => { c.width = 18; });

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="inventario_celulares_${mes}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// Texto plano (no una URL) para que cualquier lector de QR muestre estos 4
// datos de inmediato, sin depender de tener sesión ni conexión a la app -
// pensado para una etiqueta física pegada al equipo.
function buildQrText(d) {
  const numero = d.phone_number ? `${d.calling_code ? '+' + d.calling_code + ' ' : ''}${d.phone_number}` : '—';
  return [
    `IMEI: ${d.imei}`,
    `Número: ${numero}`,
    `Modelo: ${[d.brand, d.model].filter(Boolean).join(' ') || '—'}`,
    `Código: ${d.asset_code || '—'}`,
  ].join('\n');
}

router.get('/:id/qr.png', async (req, res, next) => {
  try {
    const [[device]] = await pool.query(
      `SELECT d.imei, d.phone_number, d.brand, d.model, d.asset_code, c.calling_code
       FROM mobile_devices d
       LEFT JOIN phone_country_codes c ON c.id = d.phone_country_code_id
       WHERE d.id = ?`,
      [req.params.id]
    );
    if (!device) {
      req.flash('error', 'Celular no encontrado.');
      return res.redirect('/celulares');
    }
    const buffer = await QRCode.toBuffer(buildQrText(device), { width: 300, margin: 1 });
    res.setHeader('Content-Type', 'image/png');
    if (req.query.download) {
      const nombre = (device.asset_code || device.imei).replace(/[^A-Za-z0-9-]/g, '');
      res.setHeader('Content-Disposition', `attachment; filename="qr_${nombre}.png"`);
    }
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT d.*, c.country_name, c.calling_code
       FROM mobile_devices d
       LEFT JOIN phone_country_codes c ON c.id = d.phone_country_code_id
       WHERE d.id = ?`,
      [req.params.id]
    );
    if (!rows[0]) {
      req.flash('error', 'Celular no encontrado.');
      return res.redirect('/celulares');
    }
    const [assignments] = await pool.query(
      `SELECT a.*, e.dni, e.first_name AS emp_first_name, e.last_name AS emp_last_name
       FROM mobile_device_assignments a
       LEFT JOIN employees e ON e.id = a.employee_id
       WHERE a.device_id = ? ORDER BY a.created_at DESC`,
      [req.params.id]
    );
    const currentAssignment = assignments.find((a) => !a.returned_date) || null;
    const history = assignments.filter((a) => a.returned_date);
    const [attachments] = await pool.query(
      'SELECT * FROM attachments WHERE entity_type = "mobile_device" AND entity_id = ? ORDER BY uploaded_at DESC',
      [req.params.id]
    );
    const [incidents] = await pool.query(
      'SELECT * FROM mobile_device_incidents WHERE device_id = ? ORDER BY fecha DESC, id DESC',
      [req.params.id]
    );
    const catalogs = await loadCatalogOptions();
    const lines = await mobileLineService.linesOfDevice(rows[0].id);

    // Busqueda de empleado por DNI (recarga de pagina con ?dni=), para
    // precargar el formulario de asignar/reasignar sin retipear.
    let foundEmployee = null;
    const dniQuery = (req.query.dni || '').trim();
    if (dniQuery) {
      foundEmployee = await employeeService.findByDni(dniQuery);
      if (!foundEmployee) {
        req.flash('error', `No se encontró ningún empleado con DNI "${dniQuery}". Completa los datos para crearlo.`);
      }
    }

    res.render('mobileDevices/detail', {
      title: `Celular ${rows[0].imei}`,
      item: rows[0],
      currentAssignment,
      history,
      attachments,
      incidents,
      lines,
      areas: catalogs.areas,
      sedes: catalogs.sedes,
      dniQuery,
      foundEmployee,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
