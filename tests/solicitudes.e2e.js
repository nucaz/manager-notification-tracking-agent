// Prueba de Solicitudes (quien pidio que) en Celulares, Clinic y Microsoft
// 365: solicitante vinculado al directorio, inventario e importacion de
// Clinic, flujo de M365 (aprobar, pasos con evidencia, jefatura con PST y
// buzon compartido, reasignacion y renombre con constancia) y la lectura
// del tenant con Microsoft Graph SIMULADO (servidor local).
//
// Los datos de prueba van marcados (DNI 9900000x, usuarios prueba.e2e*,
// correos @prueba-e2e.local, IMEI 990000000000091, catalogo PRUEBA-E2E) y
// se borran al final. La configuracion de M365 va en memoria. Pide
// E2E_PERMITIR=1.
//
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/solicitudes.e2e.js
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const ExcelJS = require('exceljs');

if (process.env.E2E_PERMITIR !== '1') {
  console.error('Esta prueba escribe (y luego borra) datos marcados en la base configurada. Ejecútela con E2E_PERMITIR=1.');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const IMEI = '990000000000091';
const DOM = '@prueba-e2e.local';
const results = [];
const check = (name, cond) => results.push([!!cond, name]);

// --- Microsoft Graph simulado: token, licencias y usuarios (2 paginas)
const graph = { users: [], tokens: 0, lastAuth: '' };
function fakeGraph() {
  const g = express();
  g.use(express.urlencoded({ extended: false }));
  g.post('/:tenant/oauth2/v2.0/token', (req, res) => {
    if (req.body.client_secret !== 'secreto-graph' || req.body.grant_type !== 'client_credentials' || req.params.tenant !== 'prueba.onmicrosoft.com') {
      return res.status(401).json({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\nTrace' });
    }
    graph.tokens += 1;
    res.json({ access_token: 'tok-prueba', token_type: 'Bearer' });
  });
  g.use('/v1.0', (req, res, next) => { graph.lastAuth = req.headers.authorization; return req.headers.authorization === 'Bearer tok-prueba' ? next() : res.status(401).end(); });
  g.get('/v1.0/subscribedSkus', (req, res) => res.json({ value: [
    { skuId: '11111111-1111-1111-1111-111111111111', skuPartNumber: 'O365_BUSINESS_PREMIUM', prepaidUnits: { enabled: 10 }, consumedUnits: 7 },
    { skuId: '22222222-2222-2222-2222-222222222222', skuPartNumber: 'PRUEBA_SKU_RARO', prepaidUnits: { enabled: 2 }, consumedUnits: 2 },
  ] }));
  g.get('/v1.0/users', (req, res) => {
    const port = req.socket.localPort;
    if (req.query.page === '2') return res.json({ value: graph.users.slice(1) });
    res.json({ value: graph.users.slice(0, 1), '@odata.nextLink': `http://127.0.0.1:${port}/v1.0/users?page=2` });
  });
  return g;
}

async function main() {
  const gServer = fakeGraph().listen(0);
  const GRAPH = `http://127.0.0.1:${gServer.address().port}`;
  process.env.MS_LOGIN_BASE_URL = GRAPH;
  process.env.GRAPH_BASE_URL = GRAPH;
  const pool = require(path.join(ROOT, 'src/db/pool'));
  const settingsService = require(path.join(ROOT, 'src/services/settingsService'));
  const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));
  let cfg = {};
  settingsService.getAll = async () => cfg;
  settingsService.get = async (k) => cfg[k];
  settingsService.setMany = async (pairs) => { cfg = { ...cfg, ...pairs }; };

  const cleanup = async () => {
    await pool.query(`DELETE FROM service_requests WHERE requested_by_name LIKE 'PRUEBA%' OR beneficiary_name LIKE 'PRUEBA%'
                      OR (module = 'clinic' AND details_json LIKE '%prueba.e2e%')`);
    await pool.query("DELETE FROM m365_accounts WHERE upn LIKE ?", [`%${DOM}`]);
    await pool.query("DELETE FROM m365_skus WHERE sku_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')");
    await pool.query("UPDATE clinic_users SET supervisor_id = NULL WHERE username LIKE 'prueba.e2e%'");
    await pool.query("DELETE FROM clinic_users WHERE username LIKE 'prueba.e2e%'");
    await pool.query('DELETE FROM mobile_devices WHERE imei = ?', [IMEI]);
    await pool.query("DELETE FROM employees WHERE dni IN ('99000001', '99000002', '99000003')");
    await pool.query("DELETE FROM catalog_items WHERE value LIKE 'PRUEBA-E2E%'");
    await pool.query("DELETE FROM audit_log WHERE (target LIKE 'Clinic prueba.e2e%' OR target LIKE ? OR detail LIKE '%PRUEBA Gerente%' OR target = 'usuarios_clinic_prueba.xlsx')", [`%${DOM}`]);
  };
  await cleanup();
  const [[admin]] = await pool.query("SELECT id, email, full_name, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  await pool.query(`INSERT INTO employees (dni, first_name, last_name, area, sede, cargo) VALUES
    ('99000001', 'Gerente', 'PRUEBA', 'PRUEBA-E2E Ventas', 'PUEBLO LIBRE', 'Gerente de Ventas'),
    ('99000002', 'Receptor', 'PRUEBA', 'PRUEBA-E2E Ventas', 'SURCO', 'Asistente'),
    ('99000003', 'Usuaria', 'PRUEBA', 'PRUEBA-E2E Ventas', 'SURCO', 'Vendedora')`);
  await pool.query("INSERT INTO catalog_items (catalog_type, value) VALUES ('area', 'PRUEBA-E2E Ventas'), ('perfil_clinic', 'PRUEBA-E2E Especialista')");
  await pool.query("INSERT INTO mobile_devices (imei, brand, model, area, status) VALUES (?, 'ZTE', 'A76', 'PRUEBA-E2E Ventas', 'en_stock')", [IMEI]);
  const [[device]] = await pool.query('SELECT id FROM mobile_devices WHERE imei = ?', [IMEI]);

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'e2e', resave: false, saveUninitialized: true }));
  app.use(flash());
  const CSRF = 'token-de-prueba-e2e-0123456789abcdef0123456789abcdef';
  app.use((req, res, next) => {
    req.session.user = admin;
    req.session.csrfToken = CSRF;
    Object.assign(res.locals, { currentUser: admin, csrfToken: CSRF, successMessages: req.flash('success'), errorMessages: req.flash('error'), currentPath: req.path,
      currentHost: req.hostname, appName: 'Prueba', enabledModules: new Proxy({}, { get: () => true }), mobileLabels });
    next();
  });
  app.use('/celulares', require(path.join(ROOT, 'src/routes/mobileDevices')));
  app.use('/clinic', require(path.join(ROOT, 'src/routes/clinic')));
  app.use('/m365', require(path.join(ROOT, 'src/routes/m365')));
  app.use('/solicitudes', require(path.join(ROOT, 'src/routes/requests')));
  app.use((err, req, res, next) => { console.error(err); res.status(500).send(`ERROR ${err.message}`); }); // eslint-disable-line no-unused-vars
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const keep = (r) => { const s = r.headers.get('set-cookie'); if (s) cookie = s.split(';')[0]; return r; };
  const get = async (u) => { const r = keep(await fetch(base + u, { headers: { cookie } })); return { status: r.status, text: await r.text(), r }; };
  const form = async (u, data) => {
    const body = new URLSearchParams({ _csrf: CSRF });
    for (const [k, v] of Object.entries(data)) [].concat(v).forEach((x) => body.append(k, x));
    const r = keep(await fetch(base + u, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }));
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  };
  const flashOf = async () => (await get('/solicitudes?q=__nada__')).text.match(/alert-(?:danger|success)[^>]*>([\s\S]*?)<\/div>/g) || [];
  const GERENTE = 'PRUEBA Gerente · DNI 99000001';

  try {
    // ================= Celulares: quien pidio el equipo =================
    let r = await form(`/celulares/${device.id}/asignar`, { dni: '99000003', first_name: 'Usuaria', last_name: 'PRUEBA', area: 'PRUEBA-E2E Ventas', sede: 'SURCO',
      cargo: 'Vendedora', req_name: GERENTE, req_date: '2026-10-01', req_ref: 'TICKET-123' });
    const [[asig]] = await pool.query('SELECT a.request_id, sr.* FROM mobile_device_assignments a JOIN service_requests sr ON sr.id = a.request_id WHERE a.device_id = ?', [device.id]);
    check('Celular: la asignación guarda la solicitud con el solicitante vinculado al directorio', r.status === 302 && asig && asig.module === 'celular'
      && asig.requested_by_name === 'Gerente PRUEBA' && asig.requested_by_cargo === 'Gerente de Ventas' && asig.requested_by_area === 'PRUEBA-E2E Ventas'
      && asig.request_ref === 'TICKET-123' && asig.status === 'completada' && asig.entity_id === device.id && asig.beneficiary_name === 'Usuaria PRUEBA');
    let page = await get(`/celulares/${device.id}`);
    check('Celular: la ficha muestra "Solicitado por" y el selector del directorio', page.status === 200 && page.text.includes('Gerente PRUEBA (Gerente de Ventas)')
      && page.text.includes('TICKET-123') && page.text.includes(GERENTE));
    const [[aud]] = await pool.query("SELECT detail FROM audit_log WHERE action = 'celular_asignado' AND target = ? ORDER BY id DESC LIMIT 1", [`Celular ${IMEI}`]);
    check('Celular: la auditoría registra quién lo pidió', aud && aud.detail.includes('Solicitado por Gerente PRUEBA (Gerente de Ventas, PRUEBA-E2E Ventas), ref. TICKET-123'));
    r = await form(`/celulares/${device.id}/usuario`, { dni: '99000003', first_name: 'Usuaria', last_name: 'PRUEBA', cargo: 'Vendedora', req_name: GERENTE, req_ref: 'TICKET-124', req_date: '2026-10-01' });
    const [[fixed]] = await pool.query('SELECT request_ref FROM service_requests WHERE id = ?', [asig.request_id]);
    check('Celular: corregir el solicitante actualiza la misma solicitud', fixed.request_ref === 'TICKET-124');
    r = await form(`/celulares/${device.id}/asignar`, { dni: '99000002', first_name: 'Receptor', last_name: 'PRUEBA', area: 'PRUEBA-E2E Ventas', sede: 'SURCO',
      req_name: 'Jefa externa sin DNI', req_cargo: 'Jefa de Operaciones' });
    page = await get(`/celulares/${device.id}`);
    check('Celular: reasignar con un solicitante que no está en el directorio; el historial muestra el anterior', page.text.includes('Jefa externa sin DNI')
      && /Historial de asignaciones[\s\S]*Gerente PRUEBA/.test(page.text));

    // ================= Clinic =================
    r = await form('/clinic/nuevo', { full_name: 'PRUEBA Especialista Uno', username: 'prueba.e2e1', perfil: 'PRUEBA-E2E Especialista', sede: 'SURCO', status: 'activo' });
    check('Clinic: sin solicitante no se registra', r.status === 422 && r.text.includes('Indique quién solicitó'));
    r = await form('/clinic/nuevo', { full_name: 'PRUEBA Especialista Uno', username: 'prueba.e2e1', perfil: 'PRUEBA-E2E Especialista', sede: 'SURCO',
      area: 'PRUEBA-E2E Ventas', status: 'activo', approved: '1', dni: '99000003', req_name: GERENTE, req_ref: 'MEMO-9' });
    const [[cu]] = await pool.query("SELECT c.*, sr.entity_id, sr.requested_by_name FROM clinic_users c JOIN service_requests sr ON sr.id = c.request_id WHERE c.username = 'prueba.e2e1'");
    check('Clinic: alta con perfil, sede, área, empleado y solicitud vinculada', r.status === 302 && cu && cu.entity_id === cu.id && cu.approved === 1
      && cu.requested_by_name === 'Gerente PRUEBA' && cu.employee_id);
    r = await form('/clinic/nuevo', { full_name: 'Otro', username: 'prueba.e2e1', perfil: 'PRUEBA-E2E Especialista', sede: 'SURCO', req_name: GERENTE });
    check('Clinic: usuario repetido rechazado', r.status === 422 && r.text.includes('Ya existe el usuario prueba.e2e1'));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Usuarios');
    ws.addRow(['NOMBRE', 'USUARIO', 'ESTADO', 'PERFIL', 'SEDE', 'REGISTRADO POR', 'FECHA REGISTRO', 'SUPERVISOR']);
    ws.addRow(['', 'prueba.e2e2', 'INACTIVO', 'PRUEBA-E2E Operador(a) de ventas', 'surco', 'JUAN ERIQUE', '16-10-2025 18:35:08', 'prueba.e2e1']);
    ws.addRow(['PRUEBA Especialista Uno', 'prueba.e2e1', 'ACTIVO', 'PRUEBA-E2E Especialista', 'SURCO', 'JAMES DIAZ LOPEZ', '05-09-2025 12:18:58', '']);
    ws.addRow(['PRUEBA Sede rara', 'prueba.e2e3', 'ACTIVO', 'PRUEBA-E2E Especialista', 'PRUEBA-E2E SEDE NUEVA', 'X', '', '']);
    ws.addRow(['Mal', 'con espacio', 'ACTIVO', '', '', '', '', '']);
    const buf = await wb.xlsx.writeBuffer();
    const fd = new FormData();
    fd.append('_csrf', CSRF);
    fd.append('file', new Blob([buf]), 'usuarios_clinic_prueba.xlsx');
    const imp = keep(await fetch(`${base}/clinic/importar`, { method: 'POST', headers: { cookie }, body: fd }));
    const impText = await imp.text();
    const [[u2]] = await pool.query("SELECT c.*, s.username AS sup FROM clinic_users c LEFT JOIN clinic_users s ON s.id = c.supervisor_id WHERE c.username = 'prueba.e2e2'");
    const [[perfilNuevo]] = await pool.query("SELECT id FROM catalog_items WHERE catalog_type = 'perfil_clinic' AND value = 'PRUEBA-E2E Operador(a) de ventas'");
    check('Clinic: importar el listado de Clinic crea, actualiza y avisa', imp.status === 200 && impText.includes('Importados: 3') && impText.includes('Con errores: 1')
      && impText.includes('Perfiles nuevos agregados al catálogo') && impText.includes('no trae nombre') && impText.includes('PRUEBA-E2E SEDE NUEVA'));
    check('Clinic: estado, sede del catálogo, fecha de Clinic, supervisor y perfil nuevo en el catálogo', u2 && u2.status === 'inactivo' && u2.sede === 'SURCO'
      && u2.clinic_registered_at === '2025-10-16 18:35:08' && u2.clinic_registered_by === 'JUAN ERIQUE' && u2.sup === 'prueba.e2e1' && perfilNuevo);

    r = await form(`/clinic/${cu.id}/baja`, { baja_reason: 'Renuncia', baja_date: '2026-10-05' });
    check('Clinic: la baja exige solicitante', r.status === 302 && (await pool.query('SELECT status FROM clinic_users WHERE id = ?', [cu.id]))[0][0].status === 'activo');
    r = await form(`/clinic/${cu.id}/baja`, { baja_reason: 'Renuncia', baja_date: '2026-10-05', req_name: GERENTE });
    const [[cb]] = await pool.query('SELECT status, baja_date, baja_reason FROM clinic_users WHERE id = ?', [cu.id]);
    check('Clinic: baja con fecha, motivo y solicitud', cb.status === 'baja' && cb.baja_date === '2026-10-05' && cb.baja_reason === 'Renuncia');
    const fd2 = new FormData();
    fd2.append('_csrf', CSRF);
    const ws2wb = new ExcelJS.Workbook();
    ws2wb.addWorksheet('U').addRows([['USUARIO', 'ESTADO'], ['prueba.e2e1', 'ACTIVO']]);
    fd2.append('file', new Blob([await ws2wb.xlsx.writeBuffer()]), 'usuarios_clinic_prueba.xlsx');
    const imp2 = await (await fetch(`${base}/clinic/importar`, { method: 'POST', headers: { cookie }, body: fd2 })).text();
    check('Clinic: si Clinic lo sigue mostrando ACTIVO tras la baja, se avisa y no se revierte',
      imp2.includes('está DE BAJA aquí pero Clinic lo muestra ACTIVO') && (await pool.query('SELECT status FROM clinic_users WHERE id = ?', [cu.id]))[0][0].status === 'baja');
    page = await get('/clinic?perfil=PRUEBA-E2E%20Especialista&estado=baja');
    check('Clinic: listado filtrado por perfil y estado', page.status === 200 && page.text.includes('prueba.e2e1') && !page.text.includes('prueba.e2e3'));
    page = await get(`/clinic/${cu.id}`);
    check('Clinic: la ficha muestra las solicitudes (alta y baja) con quién las pidió', (page.text.match(/Gerente PRUEBA/g) || []).length >= 2 && page.text.includes('MEMO-9'));
    check('Clinic: exportar a Excel', (await get('/clinic/exportar.xlsx')).r.headers.get('content-type').includes('spreadsheetml'));

    // ================= Microsoft 365: lectura del tenant =================
    r = await form('/m365/configuracion', { m365_tenant_id: 'prueba.onmicrosoft.com', m365_client_id: 'no-es-guid' });
    check('M365: ID de aplicación inválido rechazado', !cfg.m365_client_id);
    await form('/m365/configuracion', { m365_tenant_id: 'prueba.onmicrosoft.com', m365_client_id: '12345678-1234-1234-1234-123456789012', m365_client_secret: 'malo' });
    await form('/m365/sincronizar', {});
    check('M365: secreto incorrecto -> mensaje claro de Microsoft', (await flashOf()).join(' ').includes('Microsoft rechazó la aplicación: AADSTS7000215'));
    await form('/m365/configuracion', { m365_client_secret: 'secreto-graph', m365_tenant_id: 'prueba.onmicrosoft.com', m365_client_id: '12345678-1234-1234-1234-123456789012' });
    graph.users = [
      { id: 'aaaaaaaa-0000-0000-0000-000000000001', displayName: 'PRUEBA Gerente', userPrincipalName: `Gerente${DOM}`, accountEnabled: true, jobTitle: 'Gerente de Ventas',
        department: 'PRUEBA-E2E Ventas', assignedLicenses: [{ skuId: '11111111-1111-1111-1111-111111111111' }], userType: 'Member' },
      { id: 'aaaaaaaa-0000-0000-0000-000000000002', displayName: 'PRUEBA Vendedora', userPrincipalName: `vendedora${DOM}`, accountEnabled: false, jobTitle: 'Vendedora',
        assignedLicenses: [], userType: 'Member' },
      { id: 'aaaaaaaa-0000-0000-0000-000000000003', displayName: 'Invitado', userPrincipalName: `inv_x.com#EXT#${DOM}`, accountEnabled: true, userType: 'Guest' },
    ];
    await form('/m365/sincronizar', {});
    const [accs] = await pool.query('SELECT * FROM m365_accounts WHERE upn LIKE ? ORDER BY upn', [`%${DOM}`]);
    const ger = accs.find((a) => a.upn === `gerente${DOM}`);
    check(`M365: lectura del tenant con paginación (${accs.length} cuentas, sin invitados)`, accs.length === 2 && graph.lastAuth === 'Bearer tok-prueba'
      && ger.is_manager === 1 && ger.licenses === 'Microsoft 365 Business Standard' && ger.tenant_enabled === 1 && cfg.m365_last_sync);
    const [[sku]] = await pool.query("SELECT * FROM m365_skus WHERE sku_id = '11111111-1111-1111-1111-111111111111'");
    check('M365: licencias compradas/usadas con nombre comercial', sku.friendly_name === 'Microsoft 365 Business Standard' && sku.prepaid === 10 && sku.consumed === 7);
    page = await get('/m365');
    check('M365: listado con licencias disponibles y cuentas detectadas', page.status === 200 && page.text.includes('Microsoft 365 Business Standard') && page.text.includes('PRUEBA Vendedora'));

    // ================= M365: alta con flujo =================
    r = await form('/m365/solicitudes/nueva', { request_type: 'alta', target_name: 'PRUEBA Nuevo Jefe', target_cargo: 'Jefe de Sistemas', target_area: 'PRUEBA-E2E Ventas',
      target_upn: `nuevo.jefe${DOM}`, target_licenses: ['Microsoft 365 Business Standard'], req_name: GERENTE, req_ref: 'CORREO-7' });
    const altaId = Number((r.location || '').split('/').pop());
    let req = (await pool.query('SELECT * FROM service_requests WHERE id = ?', [altaId]))[0][0];
    const [altaTasks] = await pool.query('SELECT * FROM service_request_tasks WHERE request_id = ? ORDER BY seq', [altaId]);
    check('M365: alta pendiente con pasos; cargo de jefatura detectado', req && req.status === 'pendiente' && altaTasks.length === 4
      && JSON.parse(req.details_json).jefatura === true);
    await form(`/solicitudes/${altaId}/pasos/${altaTasks[0].id}`, { evidence: `nuevo.jefe${DOM}` });
    check('M365: no se marcan pasos antes de aprobar', !(await pool.query('SELECT done_at FROM service_request_tasks WHERE id = ?', [altaTasks[0].id]))[0][0].done_at);
    await form(`/solicitudes/${altaId}/aprobar`, { decision: 'aprobar' });
    await form(`/solicitudes/${altaId}/pasos/${altaTasks[0].id}`, { evidence: `nuevo.jefe${DOM}` });
    await form(`/solicitudes/${altaId}/completar`, {});
    check('M365: no se completa con pasos obligatorios pendientes', (await pool.query('SELECT status FROM service_requests WHERE id = ?', [altaId]))[0][0].status === 'en_proceso');
    await form(`/solicitudes/${altaId}/pasos/${altaTasks[1].id}`, { evidence: '' });
    check('M365: un paso que pide evidencia no se marca vacío', !(await pool.query('SELECT done_at FROM service_request_tasks WHERE id = ?', [altaTasks[1].id]))[0][0].done_at);
    await form(`/solicitudes/${altaId}/pasos/${altaTasks[1].id}`, { evidence: 'Microsoft 365 Business Standard' });
    await form(`/solicitudes/${altaId}/pasos/${altaTasks[3].id}`, {});
    await form(`/solicitudes/${altaId}/completar`, {});
    req = (await pool.query('SELECT * FROM service_requests WHERE id = ?', [altaId]))[0][0];
    const [[nuevo]] = await pool.query('SELECT * FROM m365_accounts WHERE upn = ?', [`nuevo.jefe${DOM}`]);
    check('M365: alta completada (el paso opcional no bloquea) crea la cuenta con licencias y jefatura', req.status === 'completada' && nuevo
      && req.entity_id === nuevo.id && nuevo.licenses === 'Microsoft 365 Business Standard' && nuevo.is_manager === 1 && nuevo.status === 'activa');

    // ================= M365: baja de jefatura =================
    r = await form('/m365/solicitudes/nueva', { request_type: 'baja', account_id: String(ger.id), retiro_date: '2026-10-31', receiver_name: 'PRUEBA Receptor · DNI 99000002',
      req_name: 'Jefa RRHH externa', req_cargo: 'Jefa de RR. HH.' });
    const bajaId = Number((r.location || '').split('/').pop());
    const [bajaTasks] = await pool.query('SELECT * FROM service_request_tasks WHERE request_id = ? ORDER BY seq', [bajaId]);
    const keys = bajaTasks.map((t) => t.task_key);
    check(`M365: baja de jefatura incluye PST y buzón compartido (${keys.join(', ')})`, keys.includes('pst') && keys.includes('compartido')
      && bajaTasks.find((t) => t.task_key === 'reasignar').required === 1);
    r = await form('/m365/solicitudes/nueva', { request_type: 'bloqueo', account_id: String(ger.id), req_name: GERENTE });
    check('M365: no se abre otra solicitud para una cuenta con una abierta', r.status === 302 && !/\/solicitudes\/\d+$/.test(r.location || ''));
    await form(`/solicitudes/${bajaId}/aprobar`, { decision: 'aprobar' });
    const ev = { bloquear: '', clave: '', pst: '\\\\nas\\pst\\gerente_2026-10-31.pst', compartido: '', reasignar: 'PRUEBA Receptor · DNI 99000002',
      renombrar: `baja.gerente${DOM}`, quitar_licencias: 'ninguna' };
    for (const t of bajaTasks) {
      if (t.task_key in ev) await form(`/solicitudes/${bajaId}/pasos/${t.id}`, { evidence: ev[t.task_key] });
    }
    await form(`/solicitudes/${bajaId}/completar`, {});
    const [[gb]] = await pool.query('SELECT * FROM m365_accounts WHERE id = ?', [ger.id]);
    const [events] = await pool.query('SELECT * FROM m365_account_events WHERE account_id = ? ORDER BY id', [ger.id]);
    const evOf = (t) => events.filter((e) => e.event_type === t);
    const [[receptor]] = await pool.query("SELECT id FROM employees WHERE dni = '99000002'");
    check('M365: baja aplicada: desactivada, buzón compartido, correo renombrado y sin licencias', gb.status === 'desactivada' && gb.account_type === 'compartido'
      && gb.upn === `baja.gerente${DOM}` && gb.licenses === null);
    check('M365: constancia de renombre (de -> a) y de PST', evOf('renombre')[0] && evOf('renombre')[0].from_value === `gerente${DOM}`
      && evOf('renombre')[0].to_value === `baja.gerente${DOM}` && evOf('pst')[0] && evOf('pst')[0].to_value.endsWith('.pst'));
    check('M365: constancia de la reasignación del buzón, vinculada al empleado que lo recibe', evOf('reasignacion')[0]
      && evOf('reasignacion')[0].related_employee_id === receptor.id && evOf('reasignacion')[0].related_name === 'Receptor PRUEBA' && evOf('reasignacion')[0].request_id === bajaId);
    page = await get(`/m365/cuentas/${ger.id}`);
    check('M365: la ficha muestra la constancia (renombre, PST, quién recibe)', page.text.includes('Renombre del correo') && page.text.includes('Respaldo PST')
      && page.text.includes('Recibe: <strong>Receptor PRUEBA</strong>'));

    // ================= Diferencias con el tenant =================
    graph.users[0].accountEnabled = true; // el tenant sigue habilitado tras la "baja"
    graph.users[0].userPrincipalName = `gerente${DOM}`;
    await form('/m365/sincronizar', {});
    const list = await require(path.join(ROOT, 'src/services/m365Service')).list({ diff: true });
    const mine = list.filter((a) => a.upn.endsWith(DOM));
    const gd = mine.find((a) => a.id === ger.id);
    const nd = mine.find((a) => a.id === nuevo.id);
    check(`M365: diferencias detectadas (${mine.map((a) => a.diffs.join('/')).join(' | ')})`, gd && gd.diffs.some((d) => d.includes('puede iniciar sesión'))
      && nd && nd.diffs.includes('No aparece en el tenant'));
    page = await get('/m365?diferencias=1');
    check('M365: filtro "solo con diferencias"', page.text.includes('nuevo.jefe') && page.text.includes('No aparece en el tenant'));

    // ================= Pantallas (todas abren sin error) =================
    const pages = ['/m365/solicitudes/nueva?tipo=alta', `/m365/solicitudes/nueva?tipo=baja&cuenta=${nuevo.id}`, `/m365/solicitudes/nueva?tipo=licencia&cuenta=${nuevo.id}`,
      `/m365/solicitudes/nueva?tipo=renombre&cuenta=${nuevo.id}`, '/m365/configuracion', '/m365/cuentas/nueva', `/m365/cuentas/${nuevo.id}/editar`,
      `/m365/cuentas/${nuevo.id}`, '/clinic/nuevo', `/clinic/${cu.id}/editar`, '/clinic/importar', `/solicitudes/${altaId}`, '/solicitudes?estado=abiertas'];
    const bad = [];
    for (const u of pages) {
      const p = await get(u);
      if (p.status !== 200 || p.text.includes('ERROR ')) bad.push(`${u} (${p.status})`);
    }
    check(`Todas las pantallas nuevas abren (${pages.length})${bad.length ? ': fallan ' + bad.join(', ') : ''}`, bad.length === 0);
    page = await get('/m365/configuracion');
    check('M365: la configuración no muestra el secreto', !page.text.includes('secreto-graph') && page.text.includes('Configurado - dejar vacío'));
    page = await get(`/m365/solicitudes/nueva?tipo=baja&cuenta=${nuevo.id}`);
    check('M365: el formulario de baja explica PST y buzón compartido y pide solicitante', page.text.includes('respaldo PST') && page.text.includes('Solicitado por'));

    // ================= Trazabilidad en todos los modulos =================
    page = await get(`/solicitudes?q=${encodeURIComponent('Gerente PRUEBA')}`);
    check('Solicitudes: todo lo que pidió una persona en celulares, Clinic y M365', page.status === 200 && page.text.includes('Asignación de celular')
      && page.text.includes('>Clinic<') && page.text.includes('Alta de cuenta') && page.text.includes('CORREO-7'));
    page = await get(`/solicitudes/${bajaId}`);
    check('Solicitudes: detalle con pasos, quién los hizo y su evidencia', page.text.includes('gerente_2026-10-31.pst') && page.text.includes(admin.full_name || ''));
    check('Solicitudes: exportar a Excel', (await get('/solicitudes/exportar.xlsx?modulo=m365')).r.headers.get('content-type').includes('spreadsheetml'));
    r = await form(`/solicitudes/${bajaId}/aprobar`, { decision: 'rechazar' });
    check('Solicitudes: una completada no se vuelve a decidir', (await pool.query('SELECT status FROM service_requests WHERE id = ?', [bajaId]))[0][0].status === 'completada');
  } finally {
    await cleanup();
    server.close();
    gServer.close();
    await pool.end();
  }
  const fails = results.filter(([ok]) => !ok);
  for (const [ok, name] of results) console.log(`${ok ? 'PASA ' : 'FALLA'}  ${name}`);
  console.log(`\n${results.length - fails.length}/${results.length} pruebas correctas`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
