// Inventario de usuarios de Clinic (ver src/services/clinicService.js).
// La contrasena de Clinic NO se registra aqui: vive solo en Clinic.
const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { requireAuth, canWrite } = require('../middleware/auth');
const { moduleRequired } = require('../middleware/modules');
const { verifyCsrfToken } = require('../middleware/csrf');
const catalogService = require('../services/catalogService');
const clinicService = require('../services/clinicService');
const requestService = require('../services/requestService');
const importService = require('../services/importService');
const auditService = require('../services/auditService');
const { importUploader } = require('../services/uploadService');

const router = express.Router();
// verifyCsrfToken va por ruta: /importar es multipart (multer primero).
router.use(requireAuth, moduleRequired('clinic'));

async function formOptions(id = null) {
  const [perfiles, sedes, areas, requesterOptions, [supervisors]] = await Promise.all([
    catalogService.getActive('perfil_clinic'), catalogService.getActive('sede'), catalogService.getActive('area'),
    requestService.pickerOptions(),
    pool.query("SELECT id, full_name, username FROM clinic_users WHERE status <> 'baja' AND id <> ? ORDER BY full_name", [id || 0]),
  ]);
  return { perfiles, sedes, areas, requesterOptions, supervisors };
}

router.get('/', async (req, res, next) => {
  try {
    const filters = { q: req.query.q || '', status: req.query.estado || '', perfil: req.query.perfil || '', sede: req.query.sede || '', area: req.query.area || '' };
    const [items, counts, opts] = await Promise.all([clinicService.list(filters), clinicService.counts(), formOptions()]);
    res.render('clinic/list', { title: 'Usuarios de Clinic', items, counts, filters, STATUS: clinicService.STATUS, ...opts });
  } catch (err) {
    next(err);
  }
});

router.get('/nuevo', canWrite, async (req, res, next) => {
  try {
    res.render('clinic/form', { title: 'Nuevo usuario de Clinic', item: { status: 'activo', approved: 0 }, errors: [], isNew: true, requester: {}, ...(await formOptions()) });
  } catch (err) {
    next(err);
  }
});

router.post('/nuevo', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const { data, errors } = await clinicService.validate(req.body);
    const requester = await requestService.parseRequester(req.body);
    if (!requester) errors.push('Indique quién solicitó el usuario (jefe o gerente).');
    if (errors.length) {
      return res.status(422).render('clinic/form', { title: 'Nuevo usuario de Clinic', item: { ...req.body, ...data }, errors, isNew: true,
        requester: { name: req.body.req_name, cargo: req.body.req_cargo, area: req.body.req_area, date: req.body.req_date, ref: req.body.req_ref },
        ...(await formOptions()) });
    }
    const requestId = await requestService.create({ module: 'clinic', type: 'alta', status: 'completada', requester,
      beneficiary: data.full_name, details: { username: data.username, perfil: data.perfil, sede: data.sede, area: data.area } }, req.session.user);
    const id = await clinicService.create(data, req.session.user, requestId);
    await pool.query('UPDATE service_requests SET entity_id = ? WHERE id = ?', [id, requestId]);
    await auditService.log(req, { user: req.session.user, action: 'clinic_usuario_creado', target: `Clinic ${data.username}`,
      detail: `${data.full_name}, perfil ${data.perfil}, sede ${data.sede}${data.area ? `, área ${data.area}` : ''}. Solicitado por ${requestService.describe(requester)}` });
    req.flash('success', `Usuario ${data.username} registrado.`);
    res.redirect(`/clinic/${id}`);
  } catch (err) {
    next(err);
  }
});

const IMPORT_VIEW = {
  title: 'Importar usuarios de Clinic', listUrl: '/clinic', actionUrl: '/clinic/importar', templateUrl: '/clinic/importar/plantilla',
  columns: clinicService.IMPORT_COLUMNS,
  note: 'Exporte el listado de usuarios desde Clinic y súbalo tal cual: se actualiza por USUARIO (los nuevos se crean). '
    + 'Los perfiles que no estén en el catálogo se agregan; una baja registrada aquí no se revierte (se avisa si Clinic lo muestra activo).',
};

router.get('/importar', canWrite, (req, res) => {
  res.render('import', { ...IMPORT_VIEW, results: null });
});

router.get('/importar/plantilla', canWrite, async (req, res, next) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Usuarios');
    ws.addRow(['NOMBRE', 'USUARIO', 'ESTADO', 'PERFIL', 'SEDE', 'ÁREA', 'REGISTRADO POR', 'FECHA REGISTRO', 'SUPERVISOR', 'APROBADO']);
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((c) => { c.width = 20; });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_usuarios_clinic.xlsx"');
    res.send(await wb.xlsx.writeBuffer());
  } catch (err) {
    next(err);
  }
});

router.post('/importar', canWrite, importUploader.single('file'), verifyCsrfToken, async (req, res, next) => {
  try {
    if (!req.file) {
      req.flash('error', 'Debes seleccionar un archivo.');
      return res.redirect('/clinic/importar');
    }
    const rows = await importService.parseSpreadsheet(req.file.buffer, req.file.originalname);
    const results = await clinicService.importRows(rows, req.session.user);
    await auditService.log(req, { user: req.session.user, action: 'clinic_importado', target: req.file.originalname,
      detail: `${results.created} nuevo(s), ${results.updated} actualizado(s), ${results.errors.length} con error` });
    res.render('import', { ...IMPORT_VIEW, results, note: `${results.created} nuevo(s) y ${results.updated} actualizado(s). ${IMPORT_VIEW.note}` });
  } catch (err) {
    next(err);
  }
});

router.get('/exportar.xlsx', async (req, res, next) => {
  try {
    const items = await clinicService.list({ q: req.query.q, status: req.query.estado, perfil: req.query.perfil, sede: req.query.sede, area: req.query.area });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Usuarios de Clinic');
    ws.addRow(['Nombre', 'Usuario', 'Estado', 'Perfil', 'Sede', 'Área', 'Supervisor', 'Aprobado', 'Solicitado por', 'Registrado en Clinic por',
      'Fecha registro', 'Fecha de baja', 'Motivo de baja']);
    for (const c of items) {
      ws.addRow([c.full_name, c.username, clinicService.STATUS[c.status].label, c.perfil || '', c.sede || '', c.area || '',
        c.supervisor_name || '', c.approved ? 'Sí' : 'No', c.requested_by_name || '', c.clinic_registered_by || '',
        c.clinic_registered_at || '', c.baja_date || '', c.baja_reason || '']);
    }
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((col) => { col.width = 20; });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="usuarios_clinic.xlsx"');
    res.send(await wb.xlsx.writeBuffer());
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const item = await clinicService.get(req.params.id);
    if (!item) {
      req.flash('error', 'Usuario no encontrado.');
      return res.redirect('/clinic');
    }
    const [requests, [team], requesterOptions] = await Promise.all([
      requestService.ofEntity('clinic', item.id),
      pool.query('SELECT id, full_name, username, status FROM clinic_users WHERE supervisor_id = ? ORDER BY full_name', [item.id]),
      requestService.pickerOptions(),
    ]);
    res.render('clinic/detail', { title: `Clinic: ${item.username}`, item, requests, team, requesterOptions,
      STATUS: clinicService.STATUS, RSTATUS: requestService.STATUS });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/editar', canWrite, async (req, res, next) => {
  try {
    const item = await clinicService.get(req.params.id);
    if (!item) return res.redirect('/clinic');
    res.render('clinic/form', { title: `Editar ${item.username}`, item: { ...item, dni: item.employee_dni }, errors: [], isNew: false, requester: {},
      ...(await formOptions(item.id)) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/editar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const before = await clinicService.get(req.params.id);
    if (!before) return res.redirect('/clinic');
    const { data, errors } = await clinicService.validate(req.body, before.id);
    if (errors.length) {
      return res.status(422).render('clinic/form', { title: `Editar ${before.username}`, item: { ...before, ...req.body, ...data }, errors,
        isNew: false, requester: {}, ...(await formOptions(before.id)) });
    }
    await clinicService.update(before.id, data);
    const changes = ['full_name', 'username', 'perfil', 'sede', 'area', 'status', 'approved']
      .filter((k) => String(before[k] ?? '') !== String(data[k] ?? '') && !(k === 'status' && before.status === 'baja'))
      .map((k) => `${k}: "${before[k] ?? ''}" → "${data[k] ?? ''}"`);
    if (changes.length) {
      await auditService.log(req, { user: req.session.user, action: 'clinic_usuario_editado', target: `Clinic ${before.username}`, detail: changes.join('; ') });
    }
    req.flash('success', changes.length ? 'Cambios guardados.' : 'No había cambios.');
    res.redirect(`/clinic/${before.id}`);
  } catch (err) {
    next(err);
  }
});

// Baja: queda la fecha, el motivo y quien la pidio (solicitud cumplida).
router.post('/:id/baja', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const item = await clinicService.get(req.params.id);
    if (!item) return res.redirect('/clinic');
    const back = `/clinic/${item.id}`;
    if (item.status === 'baja') {
      req.flash('error', 'Ya está de baja.');
      return res.redirect(back);
    }
    const requester = await requestService.parseRequester(req.body);
    const reason = String(req.body.baja_reason || '').trim().slice(0, 255);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.baja_date || '') ? req.body.baja_date : new Date().toISOString().slice(0, 10);
    if (!requester || !reason) {
      req.flash('error', 'Indique quién solicita la baja y el motivo.');
      return res.redirect(back);
    }
    await requestService.create({ module: 'clinic', type: 'baja', status: 'completada', entityId: item.id, requester,
      beneficiary: item.full_name, details: { username: item.username, motivo: reason, fecha: date } }, req.session.user);
    await pool.query("UPDATE clinic_users SET status = 'baja', baja_date = ?, baja_reason = ? WHERE id = ?", [date, reason, item.id]);
    await auditService.log(req, { user: req.session.user, action: 'clinic_usuario_baja', target: `Clinic ${item.username}`,
      detail: `Baja el ${date}: ${reason}. Solicitado por ${requestService.describe(requester)}` });
    req.flash('success', `Baja registrada. Recuerde desactivar el usuario ${item.username} en Clinic.`);
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/reactivar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const item = await clinicService.get(req.params.id);
    if (!item) return res.redirect('/clinic');
    const requester = await requestService.parseRequester(req.body);
    if (!requester) {
      req.flash('error', 'Indique quién solicita reactivar el usuario.');
      return res.redirect(`/clinic/${item.id}`);
    }
    await requestService.create({ module: 'clinic', type: 'reactivacion', status: 'completada', entityId: item.id, requester,
      beneficiary: item.full_name, details: { username: item.username } }, req.session.user);
    await pool.query("UPDATE clinic_users SET status = 'activo', baja_date = NULL, baja_reason = NULL WHERE id = ?", [item.id]);
    await auditService.log(req, { user: req.session.user, action: 'clinic_usuario_reactivado', target: `Clinic ${item.username}`,
      detail: `Solicitado por ${requestService.describe(requester)}` });
    req.flash('success', 'Usuario reactivado.');
    res.redirect(`/clinic/${item.id}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
