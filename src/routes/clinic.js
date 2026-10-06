// Inventario de usuarios de Clinic (ver src/services/clinicService.js e
// importacion en clinicImportService.js). La contrasena de Clinic NO se
// registra aqui: vive solo en Clinic.
const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { requireAuth, canWrite } = require('../middleware/auth');
const { moduleRequired } = require('../middleware/modules');
const { verifyCsrfToken } = require('../middleware/csrf');
const clinicService = require('../services/clinicService');
const clinicImportService = require('../services/clinicImportService');
const requestService = require('../services/requestService');
const auditService = require('../services/auditService');
const { clinicImportUploader } = require('../services/uploadService');

const router = express.Router();
// verifyCsrfToken va por ruta: /importar es multipart (multer primero).
router.use(requireAuth, moduleRequired('clinic'));

const VIEW = { STATUS: clinicService.STATUS, APPROVAL: clinicService.APPROVAL, EVENTS: clinicService.EVENTS, ALERTS: clinicService.ALERTS,
  IDLE_DAYS: clinicService.IDLE_DAYS };

async function formOptions(id = null) {
  const [profiles, sedes, areas, requesterOptions, supervisors] = await Promise.all([
    clinicService.profiles(), clinicService.sedes(), clinicService.areas(), requestService.pickerOptions(), clinicService.supervisorOptions(id),
  ]);
  return { profiles, sedes, areas, requesterOptions, supervisors };
}

// El formulario muestra el supervisor como "USUARIO · Nombre".
const supervisorLabel = (item) => (item.supervisor_username ? `${item.supervisor_username} · ${item.supervisor_name || ''}`.trim() : '');

router.get('/', async (req, res, next) => {
  try {
    const filters = clinicService.filtersOf(req.query);
    const [result, counts, bySede, profiles, sedes, areas] = await Promise.all([
      clinicService.list(filters, { page: req.query.pagina }), clinicService.counts(), clinicService.bySede(),
      clinicService.profiles(), clinicService.sedes(), clinicService.areas(),
    ]);
    let supervisor = null;
    if (filters.supervisor) supervisor = await clinicService.get(filters.supervisor);
    res.render('clinic/list', { title: 'Usuarios de Clinic', ...result, counts, bySede, filters, profiles, sedes, areas, supervisor,
      SORTS: clinicService.SORTS, ...VIEW });
  } catch (err) {
    next(err);
  }
});

router.get('/nuevo', canWrite, async (req, res, next) => {
  try {
    res.render('clinic/form', { title: 'Nuevo usuario de Clinic', item: { status: 'activo', approved: 1 }, errors: [], isNew: true, requester: {},
      ...VIEW, ...(await formOptions()) });
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
        ...VIEW, ...(await formOptions()) });
    }
    const [[names]] = await pool.query(
      `SELECT (SELECT name FROM clinic_profiles WHERE id = ?) AS perfil, (SELECT name FROM clinic_sedes WHERE id = ?) AS sede,
              (SELECT value FROM catalog_items WHERE id = ?) AS area`, [data.profile_id, data.sede_id, data.area_item_id || 0]
    );
    const requestId = await requestService.create({ module: 'clinic', type: 'alta', status: 'completada', requester,
      beneficiary: data.full_name, details: { username: data.username, perfil: names.perfil, sede: names.sede, area: names.area || '' } }, req.session.user);
    const id = await clinicService.create(data, req.session.user, requestId);
    await pool.query('UPDATE service_requests SET entity_id = ? WHERE id = ?', [id, requestId]);
    await auditService.log(req, { user: req.session.user, action: 'clinic_usuario_creado', target: `Clinic ${data.username}`,
      detail: `${data.full_name}, perfil ${names.perfil}, sede ${names.sede}${names.area ? `, área ${names.area}` : ''}. Solicitado por ${requestService.describe(requester)}` });
    req.flash('success', `Usuario ${data.username} registrado. Recuerde crearlo en Clinic con el mismo usuario.`);
    res.redirect(`/clinic/${id}`);
  } catch (err) {
    next(err);
  }
});

// ------------------------------- importar -------------------------------
async function importView(results = null) {
  return { title: 'Importar usuarios de Clinic', results, imports: await clinicService.imports(20), columns: clinicImportService.IMPORT_COLUMNS };
}

router.get('/importar', canWrite, async (req, res, next) => {
  try {
    res.render('clinic/import', await importView());
  } catch (err) {
    next(err);
  }
});

router.get('/importar/plantilla', canWrite, async (req, res, next) => {
  try {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('USUARIOS').addRow(['IdUsuario', 'Nombre', 'Usuario', 'IdEstado', 'IdPerfil', 'IdSede', 'UltimaConexion', 'UsuarioRegistra',
      'FechaRegistra', 'UsuarioEdita', 'FechaEdita', 'CorreoElectronico', 'NumeroCelular', 'DNI', 'IdSupervisor', 'Aprobado']);
    wb.addWorksheet('SEDES').addRow(['ID', 'NOMBRE', 'ESTADO', 'DIRECCIÓN', 'HORA INICIO', 'HORA FIN']);
    wb.addWorksheet('PERFILES').addRow(['ID', 'PERFIL']);
    wb.worksheets.forEach((ws) => { ws.getRow(1).font = { bold: true }; ws.columns.forEach((c) => { c.width = 18; }); });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_usuarios_clinic.xlsx"');
    res.send(await wb.xlsx.writeBuffer());
  } catch (err) {
    next(err);
  }
});

router.post('/importar', canWrite, clinicImportUploader.single('file'), verifyCsrfToken, async (req, res, next) => {
  try {
    if (!req.file) {
      req.flash('error', 'Debes seleccionar un archivo.');
      return res.redirect('/clinic/importar');
    }
    let book;
    try {
      book = clinicImportService.readWorkbook(req.file.buffer, req.file.originalname);
    } catch (err) {
      req.flash('error', `No se pudo leer el archivo: ${err.message}`);
      return res.redirect('/clinic/importar');
    }
    const results = await clinicImportService.importWorkbook(book, req.file.originalname, req.session.user);
    await auditService.log(req, { user: req.session.user, action: 'clinic_importado', target: req.file.originalname,
      detail: `${results.created} nuevo(s), ${results.updated} con cambios, ${results.unchanged} sin cambios, ${results.errors.length} con error` });
    res.render('clinic/import', await importView(results));
  } catch (err) {
    next(err);
  }
});

router.get('/importaciones/:id', async (req, res, next) => {
  try {
    const imp = await clinicService.getImport(req.params.id);
    if (!imp) {
      req.flash('error', 'Importación no encontrada.');
      return res.redirect('/clinic/importar');
    }
    res.render('clinic/import', { ...(await importView({ ...imp.summary.stats, importId: imp.id, errors: imp.summary.errors || [],
      notes: imp.summary.notes || [], past: imp })) });
  } catch (err) {
    next(err);
  }
});

router.get('/exportar.xlsx', async (req, res, next) => {
  try {
    const { items } = await clinicService.list(clinicService.filtersOf(req.query), { all: true });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Usuarios de Clinic');
    ws.addRow(['IdUsuario', 'Usuario', 'Nombre', 'DNI', 'Correo', 'Celular', 'Estado', 'Perfil', 'Sede', 'Área', 'Supervisor', 'Aprobado',
      'Última conexión', 'Creado en Clinic por', 'Fecha de creación', 'Solicitado por', 'Fecha de baja', 'Motivo de baja']);
    for (const c of items) {
      ws.addRow([c.clinic_id, c.username, c.full_name, c.dni || '', c.email || '', c.phone || '', clinicService.STATUS[c.status].label,
        c.profile_name || '', c.sede_name || '', c.area_name || '', c.supervisor_username || '', (clinicService.APPROVAL[c.approved] || {}).label || c.approved,
        c.last_login_at || '', c.registered_by || '', c.registered_at || '', c.requested_by_name || '', c.baja_date || '', c.baja_reason || '']);
    }
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((col) => { col.width = 18; });
    ws.autoFilter = { from: 'A1', to: 'R1' };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="usuarios_clinic.xlsx"');
    res.send(await wb.xlsx.writeBuffer());
  } catch (err) {
    next(err);
  }
});

// ------------------------- catalogo: perfiles y sedes -------------------------
router.get('/catalogo', async (req, res, next) => {
  try {
    const [profiles, sedes, areas, generalSedes] = await Promise.all([
      clinicService.profiles({ withCounts: true }), clinicService.sedes({ withCounts: true }), clinicService.areas(), clinicService.generalSedes(),
    ]);
    res.render('clinic/catalog', { title: 'Perfiles y sedes de Clinic', profiles, sedes, areas, generalSedes });
  } catch (err) {
    next(err);
  }
});

router.post('/catalogo/:kind(perfiles|sedes)/:id(\\d+)?', canWrite, verifyCsrfToken, async (req, res) => {
  const kind = req.params.kind === 'perfiles' ? 'perfil' : 'sede';
  try {
    const id = await clinicService.saveCatalog(kind, req.params.id || null, req.body);
    await auditService.log(req, { user: req.session.user, action: req.params.id ? `clinic_${kind}_editado` : `clinic_${kind}_creado`,
      target: `Clinic ${kind} #${id}`, detail: String(req.body.name || '').slice(0, 100) });
    req.flash('success', req.params.id ? 'Cambios guardados.' : `${kind === 'perfil' ? 'Perfil agregado' : 'Sede agregada'}.`);
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect(`/clinic/catalogo#${req.params.kind}`);
});

// ------------------------------- ficha -------------------------------
router.get('/:id(\\d+)', async (req, res, next) => {
  try {
    const item = await clinicService.get(req.params.id);
    if (!item) {
      req.flash('error', 'Usuario no encontrado.');
      return res.redirect('/clinic');
    }
    const [requests, [team], events, requesterOptions, [sameDni]] = await Promise.all([
      requestService.ofEntity('clinic', item.id),
      pool.query('SELECT id, full_name, username, status FROM clinic_users WHERE supervisor_id = ? ORDER BY status, full_name', [item.id]),
      clinicService.events(item.id),
      requestService.pickerOptions(),
      item.dni ? pool.query('SELECT id, username, status FROM clinic_users WHERE dni = ? AND id <> ? ORDER BY id', [item.dni, item.id]) : [[]],
    ]);
    res.render('clinic/detail', { title: `Clinic: ${item.username}`, item, requests, team, events, requesterOptions, sameDni,
      RSTATUS: requestService.STATUS, ...VIEW });
  } catch (err) {
    next(err);
  }
});

router.get('/:id(\\d+)/editar', canWrite, async (req, res, next) => {
  try {
    const item = await clinicService.get(req.params.id);
    if (!item) return res.redirect('/clinic');
    res.render('clinic/form', { title: `Editar ${item.username}`, item: { ...item, supervisor: supervisorLabel(item) }, errors: [], isNew: false,
      requester: {}, ...VIEW, ...(await formOptions(item.id)) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/editar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const before = await clinicService.get(req.params.id);
    if (!before) return res.redirect('/clinic');
    const { data, errors } = await clinicService.validate(req.body, before.id);
    if (errors.length) {
      return res.status(422).render('clinic/form', { title: `Editar ${before.username}`, item: { ...before, ...req.body, ...data }, errors,
        isNew: false, requester: {}, ...VIEW, ...(await formOptions(before.id)) });
    }
    const changes = await clinicService.update(before.id, data, before, req.session.user);
    if (changes.length) {
      await auditService.log(req, { user: req.session.user, action: 'clinic_usuario_editado', target: `Clinic ${before.username}`, detail: changes.join('; ') });
    }
    req.flash('success', changes.length ? 'Cambios guardados (quedan en el historial).' : 'No había cambios.');
    res.redirect(`/clinic/${before.id}`);
  } catch (err) {
    next(err);
  }
});

// Baja: queda la fecha, el motivo y quien la pidio (solicitud cumplida).
router.post('/:id(\\d+)/baja', canWrite, verifyCsrfToken, async (req, res, next) => {
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
    const requestId = await requestService.create({ module: 'clinic', type: 'baja', status: 'completada', entityId: item.id, requester,
      beneficiary: item.full_name, details: { username: item.username, motivo: reason, fecha: date } }, req.session.user);
    await clinicService.setBaja(item.id, { date, reason, requestId }, req.session.user);
    await auditService.log(req, { user: req.session.user, action: 'clinic_usuario_baja', target: `Clinic ${item.username}`,
      detail: `Baja el ${date}: ${reason}. Solicitado por ${requestService.describe(requester)}` });
    req.flash('success', `Baja registrada. Recuerde desactivar el usuario ${item.username} en Clinic.`);
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/reactivar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const item = await clinicService.get(req.params.id);
    if (!item) return res.redirect('/clinic');
    const requester = await requestService.parseRequester(req.body);
    if (!requester) {
      req.flash('error', 'Indique quién solicita reactivar el usuario.');
      return res.redirect(`/clinic/${item.id}`);
    }
    const requestId = await requestService.create({ module: 'clinic', type: 'reactivacion', status: 'completada', entityId: item.id, requester,
      beneficiary: item.full_name, details: { username: item.username } }, req.session.user);
    await clinicService.reactivate(item.id, { requestId }, req.session.user);
    await auditService.log(req, { user: req.session.user, action: 'clinic_usuario_reactivado', target: `Clinic ${item.username}`,
      detail: `Solicitado por ${requestService.describe(requester)}` });
    req.flash('success', 'Usuario reactivado.');
    res.redirect(`/clinic/${item.id}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
