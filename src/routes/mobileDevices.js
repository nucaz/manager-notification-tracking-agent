const express = require('express');
const ExcelJS = require('exceljs');
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

const { validateDeviceData } = mobileDeviceService;

const INCIDENT_TIPOS = ['reparacion', 'accidente', 'baja'];

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
  'operadora', 'area', 'sede', 'status', 'notes',
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
    const widths = [18, 12, 10, 10, 12, 14, 26, 16, 34, 24, 14, 14, 40, 14, 12, 10, 8, 30, 10, 20];
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
    if (errors.length > 0) {
      errors.forEach((e) => req.flash('error', e));
      return res.redirect('/celulares/nuevo');
    }
    const cols = Object.keys(data);
    const values = Object.values(data);
    const placeholders = cols.map(() => '?').join(', ');
    await pool.query(
      `INSERT INTO mobile_devices (${cols.join(', ')}, created_by) VALUES (${placeholders}, ?)`,
      [...values, req.session.user.id]
    );
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
    const errors = await validateDeviceData(data);
    if (errors.length > 0) {
      errors.forEach((e) => req.flash('error', e));
      return res.redirect(`/celulares/${req.params.id}/editar`);
    }
    const cols = Object.keys(data);
    const values = Object.values(data);
    const setClause = cols.map((c) => `${c} = ?`).join(', ');
    await pool.query(`UPDATE mobile_devices SET ${setClause} WHERE id = ?`, [...values, req.params.id]);
    req.flash('success', 'Celular actualizado correctamente.');
    res.redirect('/celulares');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/eliminar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM mobile_devices WHERE id = ?', [req.params.id]);
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
    const [result] = await pool.query('DELETE FROM mobile_devices WHERE id IN (?)', [ids]);
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
    await pool.query('UPDATE mobile_devices SET status = "asignado", area = ?, sede = ? WHERE id = ?', [
      area,
      sede || null,
      req.params.id,
    ]);
    req.flash('success', 'Celular asignado correctamente.');
    res.redirect(`/celulares/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// Cierra la asignacion activa sin crear una nueva (vuelve a stock).
router.post('/:id/devolver', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE mobile_device_assignments SET returned_date = CURDATE() WHERE device_id = ? AND returned_date IS NULL',
      [req.params.id]
    );
    await pool.query('UPDATE mobile_devices SET status = "en_stock" WHERE id = ?', [req.params.id]);
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
    const redirectTo = safeReturnTo(req.body.returnTo, `/celulares/${req.params.id}`);
    if (!INCIDENT_TIPOS.includes(tipo) || !fecha) {
      req.flash('error', 'El tipo y la fecha del incidente son obligatorios.');
      return res.redirect(redirectTo);
    }
    await pool.query(
      `INSERT INTO mobile_device_incidents (device_id, tipo, fecha, descripcion, costo, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.params.id, tipo, fecha, descripcion || null, costo || null, req.session.user.id]
    );
    if (tipo === 'reparacion') {
      await pool.query('UPDATE mobile_devices SET status = "en_reparacion" WHERE id = ?', [req.params.id]);
    } else if (tipo === 'baja') {
      await pool.query('UPDATE mobile_devices SET status = "de_baja" WHERE id = ?', [req.params.id]);
    }
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
    const [result] = await pool.query(
      `UPDATE mobile_device_incidents SET fecha_resolucion = CURDATE()
       WHERE id = ? AND device_id = ? AND tipo = 'reparacion' AND fecha_resolucion IS NULL`,
      [req.params.incidentId, req.params.id]
    );
    if (result.affectedRows === 0) {
      req.flash('error', 'No se encontró una reparación pendiente con ese id.');
      return res.redirect(`/celulares/${req.params.id}`);
    }
    const [[activeAssignment]] = await pool.query(
      'SELECT id FROM mobile_device_assignments WHERE device_id = ? AND returned_date IS NULL',
      [req.params.id]
    );
    await pool.query('UPDATE mobile_devices SET status = ? WHERE id = ?', [
      activeAssignment ? 'asignado' : 'en_stock',
      req.params.id,
    ]);
    req.flash('success', 'Reparación marcada como resuelta.');
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
      `SELECT a.*, e.dni
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
