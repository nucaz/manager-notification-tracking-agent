// Solicitudes de todos los modulos: quien pidio que, para quien, cuando y
// en que quedo. Las de Microsoft 365 tienen flujo (aprobar, pasos con
// evidencia, completar); las de celulares y Clinic se registran cumplidas.
const express = require('express');
const ExcelJS = require('exceljs');
const { requireAuth, canWrite } = require('../middleware/auth');
const { moduleRequired, moduleEnabled } = require('../middleware/modules');
const { verifyCsrfToken } = require('../middleware/csrf');
const requestService = require('../services/requestService');
const m365Service = require('../services/m365Service');
const auditService = require('../services/auditService');

const router = express.Router();
router.use(requireAuth, moduleRequired('solicitudes'), verifyCsrfToken);

const TYPE_LABELS = { ...m365Service.REQUEST_TYPES, asignacion: 'Asignación de celular', reactivacion: 'Reactivación' };
const ENTITY_URL = { celular: '/celulares/', m365: '/m365/cuentas/', clinic: '/clinic/' };

function filtersOf(req) {
  return { module: req.query.modulo || '', status: req.query.estado || '', q: req.query.q || '' };
}

router.get('/', async (req, res, next) => {
  try {
    const filters = filtersOf(req);
    const items = await requestService.list(filters);
    res.render('requests/list', { title: 'Solicitudes', items, filters, MODULES: requestService.MODULES, STATUS: requestService.STATUS,
      TYPE_LABELS, ENTITY_URL });
  } catch (err) {
    next(err);
  }
});

router.get('/exportar.xlsx', async (req, res, next) => {
  try {
    const items = await requestService.list({ ...filtersOf(req), limit: 20000 });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Solicitudes');
    ws.addRow(['N.º', 'Fecha', 'Módulo', 'Tipo', 'Solicitado por', 'Cargo', 'Área', 'Referencia', 'Para', 'Estado', 'Pasos', 'Completada']);
    for (const r of items) {
      ws.addRow([r.id, String(r.request_date).slice(0, 10), requestService.MODULES[r.module], TYPE_LABELS[r.request_type] || r.request_type,
        r.requested_by_name, r.requested_by_cargo || '', r.requested_by_area || '', r.request_ref || '', r.beneficiary_name || '',
        (requestService.STATUS[r.status] || {}).label || r.status, r.tasks_total ? `${r.tasks_done}/${r.tasks_total}` : '', r.completed_at || '']);
    }
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((c) => { c.width = 20; });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="solicitudes.xlsx"');
    res.send(await wb.xlsx.writeBuffer());
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const r = await requestService.get(req.params.id);
    if (!r) {
      req.flash('error', 'Solicitud no encontrada.');
      return res.redirect('/solicitudes');
    }
    const canAct = r.module === 'm365' && req.session.user.role !== 'lector' && await moduleEnabled(req.session.user.role, 'm365');
    res.render('requests/detail', { title: `Solicitud #${r.id}`, r, canAct, MODULES: requestService.MODULES, STATUS: requestService.STATUS,
      TYPE_LABELS, ENTITY_URL, pending: requestService.pendingRequired(r),
      requesterOptions: canAct && r.tasks.some((t) => ['reasignar', 'onedrive'].includes(t.task_key)) ? await requestService.pickerOptions() : [] });
  } catch (err) {
    next(err);
  }
});

// Acciones: solo solicitudes de Microsoft 365 y con el modulo habilitado.
async function m365Request(req, res) {
  const r = await requestService.get(req.params.id);
  if (!r || r.module !== 'm365' || !(await moduleEnabled(req.session.user.role, 'm365'))) {
    req.flash('error', 'Solicitud no encontrada o sin acceso.');
    res.redirect('/solicitudes');
    return null;
  }
  return r;
}

router.post('/:id/aprobar', canWrite, async (req, res, next) => {
  try {
    const r = await m365Request(req, res);
    if (!r) return;
    const approve = req.body.decision === 'aprobar';
    await requestService.decide(r.id, approve, req.session.user, req.body.reason);
    await auditService.log(req, { user: req.session.user, action: approve ? 'solicitud_aprobada' : 'solicitud_rechazada', target: `Solicitud #${r.id}`,
      detail: approve ? `${TYPE_LABELS[r.request_type]} para ${r.beneficiary_name}` : `Motivo: ${req.body.reason}` });
    req.flash('success', approve ? 'Solicitud aprobada: ya se pueden marcar los pasos.' : 'Solicitud rechazada.');
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect(`/solicitudes/${req.params.id}`);
});

router.post('/:id/cancelar', canWrite, async (req, res) => {
  try {
    const r = await m365Request(req, res);
    if (!r) return;
    await requestService.cancel(r.id, req.session.user, req.body.reason);
    await auditService.log(req, { user: req.session.user, action: 'solicitud_cancelada', target: `Solicitud #${r.id}`, detail: req.body.reason || '' });
    req.flash('success', 'Solicitud cancelada.');
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect(`/solicitudes/${req.params.id}`);
});

router.post('/:id/pasos/:taskId', canWrite, async (req, res) => {
  try {
    const r = await m365Request(req, res);
    if (!r) return;
    const { task } = await requestService.completeTask(r.id, req.params.taskId, req.body.evidence, req.session.user);
    await auditService.log(req, { user: req.session.user, action: 'solicitud_paso', target: `Solicitud #${r.id}`,
      detail: `${task.label}${task.evidence ? `: ${task.evidence}` : ''}` });
    req.flash('success', `Paso registrado: ${task.label}.`);
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect(`/solicitudes/${req.params.id}#pasos`);
});

router.post('/:id/completar', canWrite, async (req, res) => {
  try {
    const r = await m365Request(req, res);
    if (!r) return;
    const out = await m365Service.applyCompleted(r.id, req.session.user);
    await auditService.log(req, { user: req.session.user, action: 'solicitud_completada', target: `Solicitud #${r.id}`,
      detail: `${TYPE_LABELS[r.request_type]} - cuenta #${out.accountId}` });
    req.flash('success', 'Solicitud completada: la cuenta quedó actualizada con la constancia de cada cambio.');
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect(`/solicitudes/${req.params.id}`);
});

module.exports = router;
