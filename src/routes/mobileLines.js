// Chips (lineas) del modulo Celulares: /celulares/chips. Mismo permiso de
// modulo que Celulares. La logica (y la sincronizacion con el numero del
// celular) vive en src/services/mobileLineService.js.
const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { requireAuth, canWrite } = require('../middleware/auth');
const { moduleRequired } = require('../middleware/modules');
const { verifyCsrfToken } = require('../middleware/csrf');
const catalogService = require('../services/catalogService');
const employeeService = require('../services/employeeService');
const auditService = require('../services/auditService');
const lineService = require('../services/mobileLineService');
const labels = require('../config/mobileLabels');

const router = express.Router();
router.use(requireAuth, moduleRequired('celulares'));

const FILTERS = ['q', 'estado', 'ubicacion', 'operadora', 'area', 'sede', 'costo'];

function readFilters(query) {
  const out = {};
  for (const k of FILTERS) out[k] = typeof query[k] === 'string' ? query[k].trim() : '';
  return out;
}

function queryString(filters) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  const s = params.toString();
  return s ? `?${s}` : '';
}

function readForm(body) {
  const clean = (v) => {
    const s = v === undefined || v === null ? '' : String(v).trim();
    return s === '' ? null : s;
  };
  return {
    phone_country_code_id: clean(body.phone_country_code_id),
    phone_number: clean(body.phone_number),
    iccid: clean(body.iccid),
    operadora: clean(body.operadora),
    plan: clean(body.plan),
    costo_plan: clean(body.costo_plan),
    descuento_plan: clean(body.descuento_plan),
    descuento_nota: clean(body.descuento_nota),
    estado: clean(body.estado) || 'activo',
    notes: clean(body.notes),
  };
}

async function formOptions() {
  const [operadoras, countries, areas, sedes] = await Promise.all([
    catalogService.getActive('operadora'),
    catalogService.getActiveCountries(),
    catalogService.getActive('area'),
    catalogService.getActive('sede'),
  ]);
  return { operadoras, countries, areas, sedes };
}

function lineLabel(line) {
  return `Chip ${line.phone_number}`;
}

router.get('/', async (req, res, next) => {
  try {
    const filters = readFilters(req.query);
    const rows = await lineService.listLines(filters);
    const summary = lineService.summarize(rows);
    const [opRows] = await pool.query("SELECT DISTINCT operadora FROM mobile_lines WHERE operadora IS NOT NULL AND operadora <> '' ORDER BY operadora");
    const [areaRows] = await pool.query(
      `SELECT DISTINCT area FROM (
         SELECT d.area FROM mobile_lines l JOIN mobile_devices d ON d.id = l.device_id
         UNION SELECT e.area FROM mobile_line_assignments a JOIN employees e ON e.id = a.employee_id WHERE a.returned_date IS NULL
       ) x WHERE area IS NOT NULL AND area <> '' ORDER BY area`
    );
    const [sedeRows] = await pool.query(
      `SELECT DISTINCT sede FROM (
         SELECT d.sede FROM mobile_lines l JOIN mobile_devices d ON d.id = l.device_id
         UNION SELECT e.sede FROM mobile_line_assignments a JOIN employees e ON e.id = a.employee_id WHERE a.returned_date IS NULL
       ) x WHERE sede IS NOT NULL AND sede <> '' ORDER BY sede`
    );
    res.render('mobileLines/list', {
      title: 'Chips',
      items: rows,
      summary,
      filters,
      filterQuery: queryString(filters),
      operadoras: opRows.map((r) => r.operadora),
      areas: areaRows.map((r) => r.area),
      sedes: sedeRows.map((r) => r.sede),
      activeFilters: FILTERS.filter((k) => filters[k]).length,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/exportar.xlsx', async (req, res, next) => {
  try {
    const rows = await lineService.listLines(readFilters(req.query));
    const summary = lineService.summarize(rows);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Chips');
    const headers = ['Número', 'Código de país', 'ICCID', 'Operadora', 'Plan', 'Costo sin descuento (S/)', 'Descuento (S/)',
      'Costo con descuento (S/)', 'Detalle del descuento', 'Estado', 'Ubicación',
      'Usuario', 'Área', 'Sede', 'IMEI del celular', 'Código de activo', 'Notas'];
    sheet.addRow(headers);
    rows.forEach((r) => sheet.addRow([
      String(r.phone_number), r.calling_code ? `+${r.calling_code}` : '', r.iccid ? String(r.iccid) : '', r.operadora || '',
      r.plan || '', r.costo_plan === null ? '' : Number(r.costo_plan), r.costo_plan === null ? '' : Number(r.descuento_plan) || 0,
      r.costo_plan === null ? '' : lineService.netCost(r), r.descuento_nota || '', labels.lineEstado(r.estado).label,
      labels.lineUbicacion(r.ubicacion).label, r.holder || '', r.area || '', r.sede || '', r.imei ? String(r.imei) : '',
      r.asset_code || '', r.notes || '',
    ]));
    sheet.addRow([]);
    const total = sheet.addRow(['TOTAL', '', '', '', `${summary.total} chip(s)`, summary.costoTotal, summary.descuentoTotal, summary.netoTotal]);
    total.font = { bold: true };
    sheet.getRow(1).font = { bold: true };
    [6, 7, 8].forEach((c) => { sheet.getColumn(c).numFmt = '#,##0.00'; });
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
    [14, 10, 22, 12, 18, 16, 14, 16, 34, 16, 20, 22, 32, 24, 16, 18, 14, 30].forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
    const buffer = await workbook.xlsx.writeBuffer();
    const fecha = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="chips_${fecha}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.get('/nuevo', canWrite, async (req, res, next) => {
  try {
    res.render('mobileLines/form', { title: 'Nuevo chip', item: { estado: 'activo' }, ...(await formOptions()) });
  } catch (err) {
    next(err);
  }
});

router.post('/nuevo', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const data = readForm(req.body);
    const errors = await lineService.validateLineData(data);
    if (data.phone_number && (await lineService.numberTaken(data.phone_number))) {
      errors.push(`Ya existe un chip con el número ${data.phone_number}.`);
    } else if (data.phone_number) {
      const conflict = await lineService.deviceChipConflict(data.phone_number, null);
      if (conflict) errors.push(conflict);
    }
    if (data.estado === 'de_baja') errors.push('Un chip nuevo no puede registrarse de baja.');
    if (errors.length) {
      errors.forEach((e) => req.flash('error', e));
      return res.redirect('/celulares/chips/nuevo');
    }
    const id = await lineService.saveLine(null, data, req.session.user.id);
    await auditService.log(req, {
      user: req.session.user, action: 'chip_creado', target: lineLabel(data),
      detail: `Operadora ${data.operadora || '—'}, plan ${data.plan || '—'}, costo ${data.costo_plan || '—'}, descuento ${data.descuento_plan || '—'}`,
    });
    req.flash('success', 'Chip registrado. Desde aquí puede ponerlo en un celular o asignarlo a una persona.');
    res.redirect(`/celulares/chips/${id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/editar', canWrite, async (req, res, next) => {
  try {
    const item = await lineService.getLine(req.params.id);
    if (!item) {
      req.flash('error', 'Chip no encontrado.');
      return res.redirect('/celulares/chips');
    }
    res.render('mobileLines/form', { title: `Editar chip ${item.phone_number}`, item, ...(await formOptions()) });
  } catch (err) {
    next(err);
  }
});

const FIELD_LABELS = {
  phone_number: 'Número', phone_country_code_id: 'País', iccid: 'ICCID', operadora: 'Operadora', plan: 'Plan',
  costo_plan: 'Costo mensual', descuento_plan: 'Descuento mensual', descuento_nota: 'Detalle del descuento', estado: 'Estado', notes: 'Notas',
};

router.post('/:id/editar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const old = await lineService.getLine(req.params.id);
    if (!old) {
      req.flash('error', 'Chip no encontrado.');
      return res.redirect('/celulares/chips');
    }
    const data = readForm(req.body);
    const errors = await lineService.validateLineData(data);
    if (data.phone_number && (await lineService.numberTaken(data.phone_number, old.id))) {
      errors.push(`Otro chip ya tiene el número ${data.phone_number}.`);
    }
    if (errors.length) {
      errors.forEach((e) => req.flash('error', e));
      return res.redirect(`/celulares/chips/${old.id}/editar`);
    }
    const norm = (v) => (v === null || v === undefined ? '' : String(v));
    const changes = Object.keys(FIELD_LABELS)
      .filter((k) => (k === 'costo_plan' || k === 'descuento_plan' ? norm(old[k] === null ? '' : Number(old[k])) !== norm(data[k] === null ? '' : Number(data[k])) : norm(old[k]) !== norm(data[k])))
      .map((k) => `${FIELD_LABELS[k]}: "${norm(old[k]) || '—'}" → "${norm(data[k]) || '—'}"`);
    await lineService.saveLine(old.id, data, req.session.user.id);
    if (changes.length) {
      await auditService.log(req, { user: req.session.user, action: 'chip_editado', target: lineLabel(old), detail: changes.join('; ') });
    }
    req.flash('success', changes.length ? 'Chip actualizado.' : 'No había cambios que guardar.');
    res.redirect(`/celulares/chips/${old.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/eliminar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const line = await lineService.deleteLine(req.params.id);
    if (!line) {
      req.flash('error', 'Chip no encontrado.');
      return res.redirect('/celulares/chips');
    }
    await auditService.log(req, {
      user: req.session.user, action: 'chip_eliminado', target: lineLabel(line),
      detail: `Operadora ${line.operadora || '—'}${line.device_id ? ', estaba en un celular (se quitó su número)' : ''}`,
    });
    req.flash('success', `Chip ${line.phone_number} eliminado.`);
    res.redirect('/celulares/chips');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/poner', canWrite, verifyCsrfToken, async (req, res, next) => {
  const back = `/celulares/chips/${req.params.id}`;
  try {
    const line = await lineService.getLine(req.params.id);
    const r = await lineService.placeInDevice(req.params.id, req.body.device);
    await auditService.log(req, {
      user: req.session.user, action: 'chip_puesto_en_celular', target: lineLabel(line),
      detail: `En el celular IMEI ${r.device.imei}${r.principal ? ' (chip principal)' : ' (segundo chip)'}`
        + (r.previous ? `; retirado del celular IMEI ${r.previous.imei}` : '')
        + (r.assignment ? `; se cerró su asignación a ${r.assignment.holder_name}` : ''),
    });
    req.flash('success', `Chip puesto en el celular ${r.device.imei}${r.principal ? ' como su número principal' : ' como segundo chip'}.`);
    res.redirect(back);
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', err.message);
    res.redirect(back);
  }
});

router.post('/:id/retirar', canWrite, verifyCsrfToken, async (req, res, next) => {
  const back = `/celulares/chips/${req.params.id}`;
  try {
    const line = await lineService.getLine(req.params.id);
    const device = await lineService.removeFromDevice(req.params.id);
    await auditService.log(req, {
      user: req.session.user, action: 'chip_retirado_de_celular', target: lineLabel(line),
      detail: `Retirado del celular IMEI ${device ? device.imei : '—'}; queda en stock`,
    });
    req.flash('success', 'Chip retirado del celular: queda en stock.');
    res.redirect(back);
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', err.message);
    res.redirect(back);
  }
});

router.post('/:id/asignar', canWrite, verifyCsrfToken, async (req, res, next) => {
  const back = `/celulares/chips/${req.params.id}`;
  try {
    const line = await lineService.getLine(req.params.id);
    const r = await lineService.assignLine(req.params.id, req.body, req.session.user.id);
    const uso = req.body.uso === 'emergencia' ? 'número de emergencia' : 'uso sin celular';
    await auditService.log(req, {
      user: req.session.user, action: 'chip_asignado', target: lineLabel(line),
      detail: `Asignado a ${r.holderName} (DNI ${req.body.dni}) como ${uso}${r.previous ? `; antes lo tenía ${r.previous.holder_name}` : ''}`,
    });
    req.flash('success', `Chip asignado a ${r.holderName} (${uso}).`);
    res.redirect(back);
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', err.message);
    res.redirect(back);
  }
});

router.post('/:id/devolver', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const line = await lineService.getLine(req.params.id);
    if (!line) {
      req.flash('error', 'Chip no encontrado.');
      return res.redirect('/celulares/chips');
    }
    const closed = await lineService.closeAssignment(line.id, 'Devuelto a stock');
    if (closed) {
      await auditService.log(req, {
        user: req.session.user, action: 'chip_devuelto_stock', target: lineLabel(line), detail: `Devuelto por ${closed.holder_name}`,
      });
    }
    req.flash('success', closed ? 'Chip devuelto a stock.' : 'El chip no tenía una asignación activa.');
    res.redirect(`/celulares/chips/${line.id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const detail = await lineService.getLineDetail(req.params.id);
    if (!detail) {
      req.flash('error', 'Chip no encontrado.');
      return res.redirect('/celulares/chips');
    }
    let foundEmployee = null;
    const dniQuery = (req.query.dni || '').trim();
    if (dniQuery) {
      foundEmployee = await employeeService.findByDni(dniQuery);
      if (!foundEmployee) req.flash('error', `No se encontró ningún empleado con DNI "${dniQuery}". Completa los datos para crearlo.`);
    }
    res.render('mobileLines/detail', {
      title: `Chip ${detail.line.phone_number}`,
      item: detail.line,
      history: detail.history,
      dniQuery,
      foundEmployee,
      ...(await formOptions()),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
