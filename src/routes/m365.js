// Cuentas de Microsoft 365 (ver src/services/m365Service.js). La app no
// escribe en el tenant: registra solicitudes, pasos y la constancia de
// cada cambio, y lee el tenant (Graph) para mostrar diferencias.
const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { requireAuth, canWrite, isAdmin, isSuperAdmin } = require('../middleware/auth');
const { moduleRequired } = require('../middleware/modules');
const { verifyCsrfToken } = require('../middleware/csrf');
const catalogService = require('../services/catalogService');
const settingsService = require('../services/settingsService');
const requestService = require('../services/requestService');
const m365Service = require('../services/m365Service');
const clinicService = require('../services/clinicService');
const auditService = require('../services/auditService');

const router = express.Router();
router.use(requireAuth, moduleRequired('m365'), verifyCsrfToken);

const clean = (v, max = 255) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

router.get('/', async (req, res, next) => {
  try {
    const filters = { q: req.query.q || '', status: req.query.estado || '', area: req.query.area || '', diff: req.query.diferencias === '1',
      conexion: String(req.query.conexion || '').split(',').filter((k) => clinicService.BUCKETS.some((b) => b.key === k)).join(',') };
    const [items, skus, cfg, areas, [openReq], activityNote] = await Promise.all([
      m365Service.list(filters), m365Service.skuList(), m365Service.config(), catalogService.getActive('area'),
      pool.query("SELECT COUNT(*) AS n FROM service_requests WHERE module = 'm365' AND status IN ('pendiente', 'aprobada', 'en_proceso')"),
      settingsService.get('m365_activity_note'),
    ]);
    res.render('m365/list', {
      title: 'Cuentas de Microsoft 365', items, skus, filters, areas, STATUS: m365Service.STATUS, ACCOUNT_TYPES: m365Service.ACCOUNT_TYPES,
      configured: !!(cfg.tenant && cfg.clientId && cfg.secret), lastSync: cfg.lastSync, lastResult: cfg.lastResult, openRequests: openReq[0].n,
      diffCount: filters.diff ? items.length : items.filter((a) => a.diffs.length).length,
      BUCKETS: clinicService.BUCKETS, activityNote: activityNote || '', activityRead: items.some((a) => a.activity_read_at),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/exportar.xlsx', async (req, res, next) => {
  try {
    const items = await m365Service.list({ q: req.query.q, status: req.query.estado, area: req.query.area, conexion: req.query.conexion });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Cuentas M365');
    ws.addRow(['Correo', 'Nombre', 'Cargo', 'Área', 'Sede', 'Tipo', 'Estado', 'Jefatura', 'Licencias (registradas)', 'Licencias (tenant)',
      'Habilitada en el tenant', 'Diferencias', 'Última conexión', 'Antigüedad de conexión', 'Último inicio de sesión', 'Correo (última actividad)',
      'Teams (última actividad)', 'OneDrive (última actividad)', 'SharePoint (última actividad)']);
    for (const a of items) {
      ws.addRow([a.upn, a.display_name, a.cargo || '', a.area || '', a.sede || '', m365Service.ACCOUNT_TYPES[a.account_type] || a.account_type,
        m365Service.STATUS[a.status].label, a.is_manager ? 'Sí' : 'No', a.licenses || '', a.tenant_licenses || '',
        a.tenant_enabled === null ? '' : (a.tenant_enabled ? 'Sí' : 'No'), a.diffs.join('; '), a.last_seen || '', a.conexion_label,
        a.last_signin_at || '', a.exchange_date || '', a.teams_date || '', a.onedrive_date || '', a.sharepoint_date || '']);
    }
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((c) => { c.width = 22; });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="cuentas_m365.xlsx"');
    res.send(await wb.xlsx.writeBuffer());
  } catch (err) {
    next(err);
  }
});

// ------------------------------ configuracion ------------------------------
router.get('/configuracion', isSuperAdmin, async (req, res, next) => {
  try {
    const cfg = await m365Service.config();
    res.render('m365/config', { title: 'Microsoft 365: conexión de lectura', cfg: { ...cfg, secret: cfg.secret ? 'set' : '' } });
  } catch (err) {
    next(err);
  }
});

router.post('/configuracion', isSuperAdmin, async (req, res, next) => {
  try {
    const pairs = { m365_tenant_id: clean(req.body.m365_tenant_id, 100), m365_client_id: clean(req.body.m365_client_id, 100) };
    if (pairs.m365_tenant_id && !/^[A-Za-z0-9.-]+$/.test(pairs.m365_tenant_id)) throw new Error('Tenant no válido: el dominio (empresa.onmicrosoft.com) o el GUID.');
    if (pairs.m365_client_id && !/^[0-9a-fA-F-]{36}$/.test(pairs.m365_client_id)) throw new Error('El ID de aplicación es un GUID (36 caracteres).');
    if (req.body.m365_client_secret) pairs.m365_client_secret = String(req.body.m365_client_secret).trim();
    await settingsService.setMany(pairs);
    await auditService.log(req, { user: req.session.user, action: 'm365_configuracion', detail: Object.keys(pairs).join(', ') });
    req.flash('success', 'Conexión guardada. Use "Leer el tenant ahora" para probarla.');
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/m365/configuracion');
});

router.post('/sincronizar', isAdmin, async (req, res) => {
  try {
    const r = await m365Service.sync(req.session.user);
    await auditService.log(req, { user: req.session.user, action: 'm365_lectura_tenant', detail: r.result });
    req.flash('success', `Tenant leído: ${r.result}`);
  } catch (err) {
    req.flash('error', `No se pudo leer el tenant: ${err.message}`);
  }
  res.redirect(req.body.volver === 'config' ? '/m365/configuracion' : '/m365');
});

// --------------------------------- cuentas ---------------------------------
async function accountForm(res, item, errors, status = 200) {
  const [areas, sedes] = await Promise.all([catalogService.getActive('area'), catalogService.getActive('sede')]);
  res.status(status).render('m365/account_form', { title: item.id ? `Editar ${item.upn}` : 'Registrar cuenta existente', item, errors, areas, sedes,
    ACCOUNT_TYPES: m365Service.ACCOUNT_TYPES, STATUS: m365Service.STATUS, licenseOptions: await m365Service.licenseOptions() });
}

async function readAccount(body, id = null) {
  const errors = [];
  const data = {
    upn: clean(body.upn).toLowerCase(), display_name: clean(body.display_name, 150), cargo: clean(body.cargo, 150) || null,
    area: clean(body.area, 100) || null, sede: clean(body.sede, 100) || null,
    account_type: m365Service.ACCOUNT_TYPES[body.account_type] ? body.account_type : 'usuario',
    is_manager: body.is_manager ? 1 : 0, notes: clean(body.notes, 2000) || null, employee_id: null,
    licenses: [].concat(body.licenses || []).map((x) => clean(x, 100)).filter(Boolean).join(', ') || null,
  };
  if (!m365Service.UPN.test(data.upn)) errors.push('Correo no válido.');
  if (!data.display_name) errors.push('El nombre es obligatorio.');
  const [[dup]] = await pool.query('SELECT id FROM m365_accounts WHERE upn = ? AND id <> ?', [data.upn, id || 0]);
  if (dup) errors.push(`Ya existe la cuenta ${data.upn}.`);
  const dni = clean(body.dni, 8);
  if (dni) {
    const [[e]] = await pool.query('SELECT id FROM employees WHERE dni = ?', [dni]);
    if (e) data.employee_id = e.id; else errors.push(`No hay un empleado con DNI ${dni}.`);
  }
  return { data, errors };
}

router.get('/cuentas/nueva', canWrite, async (req, res, next) => {
  try {
    await accountForm(res, { account_type: 'usuario' }, []);
  } catch (err) {
    next(err);
  }
});

// Registrar una cuenta que ya existe en el tenant (para el alta de una
// cuenta nueva se usa una solicitud).
router.post('/cuentas/nueva', canWrite, async (req, res, next) => {
  try {
    const { data, errors } = await readAccount(req.body);
    if (errors.length) return accountForm(res, { ...req.body, ...data }, errors, 422);
    const status = m365Service.STATUS[req.body.status] && req.body.status !== 'eliminada' ? req.body.status : 'activa';
    const [r] = await pool.query('INSERT INTO m365_accounts SET ?', [{ ...data, status, created_by: req.session.user.id }]);
    await m365Service.event(r.insertId, 'edicion', { to: data.upn, user: req.session.user, notes: 'Registrada a mano (cuenta existente)' });
    await auditService.log(req, { user: req.session.user, action: 'm365_cuenta_registrada', target: data.upn });
    res.redirect(`/m365/cuentas/${r.insertId}`);
  } catch (err) {
    next(err);
  }
});

router.get('/cuentas/:id', async (req, res, next) => {
  try {
    const item = await m365Service.get(req.params.id);
    if (!item) {
      req.flash('error', 'Cuenta no encontrada.');
      return res.redirect('/m365');
    }
    res.render('m365/account', { title: item.upn, item, requests: await requestService.ofEntity('m365', item.id),
      STATUS: m365Service.STATUS, ACCOUNT_TYPES: m365Service.ACCOUNT_TYPES, EVENT_LABELS: m365Service.EVENT_LABELS,
      REQUEST_TYPES: m365Service.REQUEST_TYPES, RSTATUS: requestService.STATUS });
  } catch (err) {
    next(err);
  }
});

router.get('/cuentas/:id/editar', canWrite, async (req, res, next) => {
  try {
    const item = await m365Service.get(req.params.id);
    if (!item) return res.redirect('/m365');
    await accountForm(res, { ...item, dni: item.employee_dni, licenses: item.licenses }, []);
  } catch (err) {
    next(err);
  }
});

// Editar datos descriptivos (nombre, cargo, area...). El correo, el estado
// y las licencias registradas cambian por solicitud (quedan con constancia).
router.post('/cuentas/:id/editar', canWrite, async (req, res, next) => {
  try {
    const before = await m365Service.get(req.params.id);
    if (!before) return res.redirect('/m365');
    const { data, errors } = await readAccount({ ...req.body, upn: before.upn, licenses: (before.licenses || '').split(', ') }, before.id);
    if (errors.length) return accountForm(res, { ...before, ...req.body }, errors, 422);
    delete data.upn;
    delete data.licenses;
    await pool.query('UPDATE m365_accounts SET ? WHERE id = ?', [data, before.id]);
    const changes = Object.keys(data).filter((k) => String(before[k] ?? '') !== String(data[k] ?? '')).map((k) => `${k}: "${before[k] ?? ''}" → "${data[k] ?? ''}"`);
    if (changes.length) {
      await m365Service.event(before.id, 'edicion', { user: req.session.user, notes: changes.join('; ') });
      await auditService.log(req, { user: req.session.user, action: 'm365_cuenta_editada', target: before.upn, detail: changes.join('; ') });
    }
    req.flash('success', changes.length ? 'Datos guardados.' : 'No había cambios.');
    res.redirect(`/m365/cuentas/${before.id}`);
  } catch (err) {
    next(err);
  }
});

// ------------------------------- solicitudes -------------------------------
router.get('/solicitudes/nueva', canWrite, async (req, res, next) => {
  try {
    const tipo = m365Service.REQUEST_TYPES[req.query.tipo] ? req.query.tipo : 'alta';
    const account = req.query.cuenta ? await m365Service.get(req.query.cuenta) : null;
    const [accounts, areas, sedes, licenseOptions, requesterOptions] = await Promise.all([
      pool.query("SELECT id, upn, display_name FROM m365_accounts WHERE status <> 'eliminada' ORDER BY display_name").then((r) => r[0]),
      catalogService.getActive('area'), catalogService.getActive('sede'), m365Service.licenseOptions(), requestService.pickerOptions(),
    ]);
    res.render('m365/request_form', { title: 'Nueva solicitud de Microsoft 365', tipo, account, accounts, areas, sedes, licenseOptions,
      requesterOptions, REQUEST_TYPES: m365Service.REQUEST_TYPES, form: req.session.m365Form || {} });
    delete req.session.m365Form;
  } catch (err) {
    next(err);
  }
});

router.post('/solicitudes/nueva', canWrite, async (req, res) => {
  try {
    const r = await m365Service.createRequest(req.body, req.session.user);
    await auditService.log(req, { user: req.session.user, action: 'm365_solicitud_creada', target: `Solicitud #${r.id}`,
      detail: `${m365Service.REQUEST_TYPES[r.type]}${r.account ? ` de ${r.account.upn}` : ` para ${req.body.target_name}`}. `
        + `Solicitado por ${requestService.describe(r.requester)}${r.isManager ? '. Jefatura: incluye PST y buzón compartido' : ''}` });
    req.flash('success', `Solicitud #${r.id} registrada${r.isManager && r.type === 'baja' ? ' (jefatura: incluye respaldo PST y buzón compartido)' : ''}. Queda pendiente de aprobación.`);
    res.redirect(`/solicitudes/${r.id}`);
  } catch (err) {
    req.session.m365Form = req.body;
    req.flash('error', err.message);
    res.redirect(`/m365/solicitudes/nueva?tipo=${encodeURIComponent(req.body.request_type || 'alta')}${req.body.account_id ? `&cuenta=${encodeURIComponent(req.body.account_id)}` : ''}`);
  }
});

module.exports = router;
