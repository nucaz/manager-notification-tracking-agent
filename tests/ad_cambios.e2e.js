// Prueba de la fase 2 del Directorio activo (cambios en el dominio con
// aprobacion) contra un controlador de dominio REAL de prueba (Samba AD DC
// en Docker, ver scripts/ad-prueba/levantar.sh). Nunca contra un dominio real.
//
// La cuenta de escritura (svc-escritor) solo tiene control delegado sobre
// OU=Depilzone y la zona DNS: asi se prueba con el minimo privilegio.
//
// Variables (si faltan, la prueba no se ejecuta):
//   AD_TEST_URL, AD_TEST_CA, AD_TEST_USER, AD_TEST_PASSWORD   (lectura, como tests/ad.e2e.js)
//   AD_TEST_WRITE_USER=svc-escritor@prueba.local  AD_TEST_WRITE_PASSWORD=...
//   AD_TEST_ADMIN_USER / AD_TEST_ADMIN_PASSWORD (opcional: restaurar de la papelera)
// Uso (dentro del contenedor): E2E_PERMITIR=1 AD_TEST_...=... node tests/ad_cambios.e2e.js
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

if (process.env.E2E_PERMITIR !== '1') {
  console.error('Esta prueba escribe (y luego borra) datos marcados en la base configurada. Ejecútela con E2E_PERMITIR=1.');
  process.exit(2);
}
const E = process.env;
if (!E.AD_TEST_URL || !E.AD_TEST_CA || !E.AD_TEST_USER || !E.AD_TEST_PASSWORD || !E.AD_TEST_WRITE_USER || !E.AD_TEST_WRITE_PASSWORD) {
  console.error('Faltan AD_TEST_URL, AD_TEST_CA, AD_TEST_USER, AD_TEST_PASSWORD, AD_TEST_WRITE_USER y AD_TEST_WRITE_PASSWORD (DC de prueba).');
  process.exit(2);
}
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (name, cond) => results.push([!!cond, name]);
const CA = fs.readFileSync(E.AD_TEST_CA, 'utf8');
const B = 'DC=prueba,DC=local';
const MANAGED = `OU=Depilzone,${B}`;
const PASS = 'Clave-e2e-AD-2026!';

async function main() {
  const pool = require(path.join(ROOT, 'src/db/pool'));
  const bcrypt = require('bcryptjs');
  const { OTP } = require('otplib');
  const { Client } = require('ldapts');
  const settingsService = require(path.join(ROOT, 'src/services/settingsService'));
  const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));
  let cfg = {};
  settingsService.getAll = async () => cfg;
  settingsService.get = async (k) => cfg[k];
  settingsService.setMany = async (p) => { cfg = { ...cfg, ...p }; };
  const ad = require(path.join(ROOT, 'src/services/adService'));
  const adw = require(path.join(ROOT, 'src/services/adWriteService'));
  const changes = require(path.join(ROOT, 'src/services/adChangeService'));
  adw.options.autoResync = false; // la prueba relee el dominio cuando lo necesita
  const totp = new OTP({ strategy: 'totp' });

  // Lectura directa del DC para comprobar lo que hizo la aplicacion.
  const ldap = async (filter, attributes = ['distinguishedName', 'userAccountControl', 'title', 'member', 'sAMAccountName']) => {
    const c = new Client({ url: E.AD_TEST_URL, tlsOptions: { ca: [CA], servername: ad._.hostOf(E.AD_TEST_URL), minVersion: 'TLSv1.2' } });
    await c.bind(E.AD_TEST_USER, E.AD_TEST_PASSWORD);
    try {
      const { searchEntries } = await c.search(B, { scope: 'sub', filter, attributes });
      return searchEntries;
    } finally {
      await c.unbind().catch(() => {});
    }
  };
  const dnsSearch = async (filter) => {
    const c = new Client({ url: E.AD_TEST_URL, tlsOptions: { ca: [CA], servername: ad._.hostOf(E.AD_TEST_URL), minVersion: 'TLSv1.2' } });
    await c.bind(E.AD_TEST_USER, E.AD_TEST_PASSWORD);
    try {
      const { searchEntries } = await c.search(`DC=DomainDnsZones,${B}`, { scope: 'sub', filter, attributes: ['name'] });
      return searchEntries;
    } finally {
      await c.unbind().catch(() => {});
    }
  };
  const canBind = async (userPrincipal, password) => {
    const c = new Client({ url: E.AD_TEST_URL, tlsOptions: { ca: [CA], servername: ad._.hostOf(E.AD_TEST_URL), minVersion: 'TLSv1.2' } });
    try { await c.bind(userPrincipal, password); return true; } catch (_) { return false; } finally { await c.unbind().catch(() => {}); }
  };
  const uac = async (sam) => Number(((await ldap(`(sAMAccountName=${sam})`))[0] || {}).userAccountControl || 0);

  // Usuarios de la aplicacion, solo para esta prueba.
  const mk = async (email, role, otp) => {
    const hash = await bcrypt.hash(PASS, 4);
    const secret = otp ? totp.generateSecret() : null;
    const [r] = await pool.query('INSERT INTO users (full_name, email, password_hash, role, active, otp_secret, otp_enabled) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [`E2E ${role}`, email, hash, role, secret, otp ? 1 : 0]);
    return { id: r.insertId, email, full_name: `E2E ${role}`, role, secret };
  };
  const cleanup = async () => {
    const like = '%DC=prueba,DC=local';
    await pool.query("DELETE FROM ad_change_requests WHERE target_dn LIKE ? OR requested_by IN (SELECT id FROM users WHERE email LIKE 'e2e-ad-%@prueba.invalid')", [like]);
    await pool.query("DELETE FROM users WHERE email LIKE 'e2e-ad-%@prueba.invalid'");
    await pool.query('DELETE FROM ad_group_members WHERE member_dn LIKE ?', [like]);
    for (const t of ['ad_users', 'ad_groups', 'ad_ous', 'ad_computers']) await pool.query(`DELETE FROM ${t} WHERE dn LIKE ?`, [like]);
    await pool.query("DELETE FROM ad_dns_records WHERE zone LIKE '%prueba.local' OR zone LIKE '%in-addr.arpa'");
    await pool.query('DELETE FROM ad_gpo_links WHERE target_dn LIKE ?', [like]);
    await pool.query('DELETE FROM ad_gpos WHERE dn LIKE ?', [like]);
    await pool.query('DELETE FROM ad_deleted WHERE last_known_parent LIKE ?', [like]);
    await pool.query("DELETE FROM ad_sync_runs WHERE dc LIKE '%prueba.local'");
    await pool.query("DELETE FROM audit_log WHERE action LIKE 'ad\\_%' AND (user_email LIKE 'e2e-ad-%@prueba.invalid' OR target LIKE '%prueba.local%' OR target = 'directorio activo')");
  };
  await cleanup();
  const SUPER = await mk('e2e-ad-super@prueba.invalid', 'superadmin', false);
  const ADMIN = await mk('e2e-ad-admin@prueba.invalid', 'admin', true);
  const EDITOR = await mk('e2e-ad-editor@prueba.invalid', 'editor', false);

  let user = SUPER;
  const CSRF = 'token-de-prueba-ad2-0123456789abcdef0123456789abcdef012';
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'e2e', resave: false, saveUninitialized: true }));
  app.use(flash());
  app.use((req, res, next) => {
    req.session.user = { id: user.id, email: user.email, full_name: user.full_name, role: user.role };
    req.session.csrfToken = CSRF;
    Object.assign(res.locals, { currentUser: req.session.user, csrfToken: CSRF, successMessages: req.flash('success'), errorMessages: req.flash('error'),
      currentPath: req.path, currentHost: req.hostname, appName: 'Prueba', enabledModules: new Proxy({}, { get: () => true }), mobileLabels });
    next();
  });
  app.use('/ad', require(path.join(ROOT, 'src/routes/ad')));
  app.use('/reportes', require(path.join(ROOT, 'src/routes/reports')));
  app.use('/', require(path.join(ROOT, 'src/routes/dashboard')));
  app.use((err, req, res, next) => { console.error(err); res.status(500).send(`ERROR ${err.message}`); }); // eslint-disable-line no-unused-vars
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const keep = (r) => { const s = r.headers.get('set-cookie'); if (s) cookie = s.split(';')[0]; return r; };
  const get = async (u) => { const r = keep(await fetch(base + u, { redirect: 'manual', headers: { cookie } })); return { status: r.status, location: r.headers.get('location'), text: await r.text() }; };
  const post = async (u, data) => {
    const body = new URLSearchParams({ _csrf: CSRF });
    Object.entries(data).forEach(([k, v]) => [].concat(v).forEach((x) => body.append(k, String(x))));
    const r = keep(await fetch(base + u, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }));
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  };
  const flashes = async () => (await get('/ad/cambios')).text;
  const nonceOf = (html) => (html.match(/name="nonce" value="([0-9a-f]+)"/) || [])[1];
  const secretOf = (html) => (html.match(/id="secreto_\d+">([^<]+)</) || [])[1];
  const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#34;/g, '"').replace(/&#39;/g, "'");
  // Abre el formulario de una operacion y lo envia.
  const doOp = async (op, id, data = {}, query = '') => {
    const f = await get(`/ad/cambios/nuevo?op=${op}${id ? `&id=${id}` : ''}${query}`);
    return post('/ad/cambios', { op, nonce: nonceOf(f.text), ...(id ? { id } : {}), ...data });
  };
  const row = async (table, where, args) => (await pool.query(`SELECT * FROM ${table} WHERE ${where}`, args))[0][0];
  const resync = () => ad.sync();
  const lastReq = async () => row('ad_change_requests', 'requested_by IN (?, ?, ?) ORDER BY id DESC LIMIT 1', [SUPER.id, ADMIN.id, EDITOR.id]);
  const reauthAdmin = async () => ({ reauth_code: await totp.generate({ secret: ADMIN.secret }) });

  try {
    // ---------------- piezas sueltas ----------------
    const T = adw._;
    const g = '33221100-5544-7766-8899-aabbccddeeff';
    check('GUID a filtro LDAP binario (orden de bytes de AD)', T.guidFilter(g).attribute === 'objectGUID'
      && T.guidFilter(g).value.toString('hex') === '00112233445566778899aabbccddeeff');
    check('Escapar un RDN (coma, signo más, numeral inicial)', T.escapeRdn('#Pérez, Ana+1') === '\\#Pérez\\, Ana\\+1');
    const pws = Array.from({ length: 30 }, () => adw.generatePassword(16, ['juan.perez', 'Juan Perez']));
    check('Contraseñas generadas: 16 caracteres, las 4 clases y sin el nombre de la cuenta', pws.every((p) => p.length === 16 && /[A-Z]/.test(p) && /[a-z]/.test(p)
      && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p) && !/juan|perez/i.test(p)) && new Set(pws).size === 30);
    const bad = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
    check('Validación: usuario inválido, equipo inválido y atributo no permitido', /sAMAccountName/.test(bad(() => adw.validateParams('user_create', { givenName: 'A', sn: 'B', sam: 'a b' })))
      && /15 caracteres/.test(bad(() => adw.validateParams('computer_create', { name: '12345' })))
      && /No se puede modificar/.test(bad(() => adw.validateParams('user_update', { changes: { userAccountControl: { from: '', to: '512' } } }))));

    // ---------------- configuracion ----------------
    cfg = { ad_url: E.AD_TEST_URL, ad_bind_user: E.AD_TEST_USER, ad_bind_password: E.AD_TEST_PASSWORD, ad_ca_pem: CA, ad_all_dcs: '0' };
    await resync();
    const [[snapUsers]] = await pool.query("SELECT COUNT(*) AS n FROM ad_users WHERE dn LIKE '%DC=prueba,DC=local'");
    check('Lectura previa del dominio de prueba', Number(snapUsers.n) >= 7);
    check('Sin cambios encendidos, el formulario lo dice y no deja ejecutar', (await get('/ad/cambios/nuevo?op=user_create')).text.includes('están apagados'));
    const writeForm = { ad_writes_enabled: '1', ad_managed_ous: MANAGED, ad_write_user: E.AD_TEST_WRITE_USER, ad_write_password: E.AD_TEST_WRITE_PASSWORD };
    user = ADMIN;
    check('Un administrador no ve ni cambia la configuración de escritura', (await post('/ad/configuracion/escritura', { ...writeForm, reauth_password: PASS })).location === '/'
      && !cfg.ad_writes_enabled);
    user = SUPER;
    await post('/ad/configuracion/escritura', { ...writeForm, reauth_password: 'otra' });
    check('Sin confirmar la identidad no se guarda la escritura', !cfg.ad_writes_enabled && (await flashes()).includes('contraseña de confirmación no es correcta'));
    await post('/ad/configuracion/escritura', { ...writeForm, ad_managed_ous: `OU=NoExiste,${B}`, reauth_password: PASS });
    check('Una OU gestionada que no existe: se prueba y NO se guarda', !cfg.ad_writes_enabled && (await flashes()).includes('no existen'));
    // Detectar: el DC dice en que OU puede crear la cuenta de escritura (sin escribir nada).
    const det = await post('/ad/configuracion/escritura/detectar', { ad_write_user: E.AD_TEST_WRITE_USER, ad_write_password: E.AD_TEST_WRITE_PASSWORD });
    const detJ = JSON.parse(det.text || '{}');
    const detDns = (detJ.ous || []).map((o) => o.dn.toLowerCase());
    check('Detectar las OU delegadas: OU=Depilzone y sus sub-unidades, no OU=Servicios', det.status === 200 && detDns.includes(MANAGED.toLowerCase())
      && detDns.includes(`ou=ventas,${MANAGED}`.toLowerCase()) && !detDns.includes(`ou=servicios,${B}`.toLowerCase())
      && detJ.ous.find((o) => o.dn.toLowerCase() === MANAGED.toLowerCase()).classes.includes('user'));
    const detBad = await post('/ad/configuracion/escritura/detectar', { ad_write_user: E.AD_TEST_WRITE_USER, ad_write_password: 'no-es-esta' });
    check('Detectar con una contraseña errónea: error claro, sin lista', detBad.status === 400 && /error/.test(detBad.text) && !/"ous"/.test(detBad.text));
    user = ADMIN;
    check('Un administrador no puede usar Detectar', (await post('/ad/configuracion/escritura/detectar', { ad_write_user: E.AD_TEST_WRITE_USER, ad_write_password: E.AD_TEST_WRITE_PASSWORD })).location === '/');
    user = SUPER;
    await post('/ad/configuracion/escritura', { ...writeForm, ad_managed_ous: '', ad_managed_ou: [MANAGED, `OU=Servicios,${B}`], reauth_password: PASS });
    check('Una OU sin delegación para la cuenta: NO se guarda y dice cuál', !cfg.ad_writes_enabled && (await flashes()).includes('no tiene control delegado'));
    const cfgPage = (await get('/ad/configuracion')).text;
    check('Tras el error, el formulario conserva lo elegido (casillas y cuenta) sin la contraseña', /value="OU=Servicios,[^"]*"[^>]*checked/.test(cfgPage)
      && cfgPage.includes(`value="${E.AD_TEST_WRITE_USER}"`) && !cfgPage.includes(E.AD_TEST_WRITE_PASSWORD));
    // Contenedores: Computers esta delegado en el DC de prueba; Users no.
    check('Detectar incluye el contenedor Computers (delegado) y no Users', detDns.includes(`cn=computers,${B}`.toLowerCase()) && !detDns.includes(`cn=users,${B}`.toLowerCase()));
    await post('/ad/configuracion/escritura', { ...writeForm, ad_managed_ous: '', ad_managed_ou: [MANAGED, `CN=Users,${B}`], reauth_password: PASS });
    check('El contenedor Users sin delegar: NO se guarda', !cfg.ad_writes_enabled && (await flashes()).includes('no tiene control delegado'));
    await post('/ad/configuracion/escritura', { ...writeForm, ad_managed_ous: '', ad_managed_ou: [MANAGED, `CN=Computers,${B}`], reauth_password: PASS });
    check('El contenedor Computers delegado: se guarda como gestionado', cfg.ad_writes_enabled === '1' && cfg.ad_managed_ous === `${MANAGED}\nCN=Computers,${B}`
      && /value="CN=Computers,[^"]*"[^>]*checked/.test((await get('/ad/configuracion')).text));
    cfg.ad_writes_enabled = '0';
    // Casillas: una OU dentro de otra elegida sobra (la de arriba la incluye).
    await post('/ad/configuracion/escritura', { ...writeForm, ad_managed_ous: '', ad_managed_ou: [MANAGED, `OU=Ventas,${MANAGED}`], reauth_password: PASS });
    check('Escritura verificada y guardada (cuenta delegada, OU gestionada)', cfg.ad_writes_enabled === '1' && cfg.ad_managed_ous === MANAGED
      && cfg.ad_write_password === E.AD_TEST_WRITE_PASSWORD && !(await get('/ad/configuracion')).text.includes(E.AD_TEST_WRITE_PASSWORD));

    // ---------------- superadmin: directo ----------------
    const ventas = await row('ad_ous', "name = 'Ventas' AND dn LIKE ?", [`%${MANAGED}`]);
    const sistemas = await row('ad_ous', "name = 'Sistemas' AND dn LIKE ?", [`%${MANAGED}`]);
    const fc = await get(`/ad/cambios/nuevo?op=user_create&id=${ventas.id}`);
    const create = await post('/ad/cambios', { op: 'user_create', nonce: nonceOf(fc.text), ou_id: ventas.id, givenName: 'Lucía', sn: 'Prueba', sam: 'lucia.prueba',
      title: 'Cajera', employeeID: '45678912', mustChange: '1', reauth_password: PASS });
    const pw1 = decode(secretOf(create.text));
    const lucia = (await ldap('(sAMAccountName=lucia.prueba)', ['distinguishedName', 'userAccountControl', 'title', 'employeeID', 'pwdLastSet']))[0];
    check('Superadmin crea un usuario: queda en la OU, habilitado, con sus datos', lucia && /OU=Ventas,OU=Depilzone/.test(lucia.dn) && Number(lucia.userAccountControl) === 512
      && lucia.title === 'Cajera' && lucia.employeeID === '45678912');
    check('La contraseña generada se muestra una vez y obliga a cambiarla al entrar', pw1 && pw1.length === 16 && String(lucia.pwdLastSet) === '0');
    const [[luciaReq]] = await pool.query("SELECT * FROM ad_change_requests WHERE operation = 'user_create' AND target_label LIKE 'lucia.prueba%'");
    check('El cambio directo queda registrado sin guardar la contraseña', luciaReq && luciaReq.status === 'ejecutada' && luciaReq.via === 'directa'
      && luciaReq.decided_by === null && luciaReq.secret_enc === null && !String(luciaReq.params_json).includes(pw1));
    const again = await post('/ad/cambios', { op: 'user_create', nonce: nonceOf(fc.text), ou_id: ventas.id, givenName: 'Lucía', sn: 'Prueba', sam: 'lucia.prueba2', reauth_password: PASS });
    check('Reenviar el mismo formulario no vuelve a ejecutar', again.status === 302 && (await ldap('(sAMAccountName=lucia.prueba2)')).length === 0);
    const dup = await doOp('user_create', null, { ou_id: ventas.id, givenName: 'Otra', sn: 'Lucia', sam: 'lucia.prueba', reauth_password: PASS });
    check('Usuario repetido: el dominio no se toca y se explica', dup.status === 200 && /Ya existe la cuenta lucia.prueba/.test(dup.text));

    await resync();
    const juan = await row('ad_users', "sam = 'juan.perez'", []);
    const maria = await row('ad_users', "sam = 'maria.lopez'", []);
    const ana = await row('ad_users', "sam = 'ana.admin'", []);
    const pedro = await row('ad_users', "sam = 'pedro.soporte'", []);
    const svc = await row('ad_users', "sam = 'svc-gestor'", []);
    const luciaRow = await row('ad_users', "sam = 'lucia.prueba'", []);

    await doOp('user_update', luciaRow.id, { f_title: 'Jefa de caja', f_department: 'Ventas', f_givenName: 'Lucía', reauth_password: PASS });
    const l2 = (await ldap('(sAMAccountName=lucia.prueba)', ['title', 'department', 'givenName']))[0];
    check('Modificar datos: solo cambia lo editado', l2.title === 'Jefa de caja' && l2.department === 'Ventas' && l2.givenName === 'Lucía');
    await doOp('user_move', maria.id, { to_ou_id: sistemas.id, reauth_password: PASS });
    check('Mover a otra unidad organizativa gestionada', /CN=[^,]+,OU=Sistemas,OU=Depilzone/.test(((await ldap('(sAMAccountName=maria.lopez)'))[0] || {}).dn));
    await doOp('user_enable', maria.id, { reauth_password: PASS });
    check('Habilitar usuario', ((await uac('maria.lopez')) & 2) === 0);

    // ---------------- protecciones ----------------
    const pa = await doOp('user_disable', ana.id, { reauth_password: PASS });
    check('Administradora del dominio: protegida (no se puede ni pedir)', pa.status === 302 && ((await uac('ana.admin')) & 2) === 0
      && (await get(`/ad/usuarios/${ana.id}`)).text.includes('Cuenta protegida'));
    const pp = await doOp('user_reset_password', pedro.id, { reauth_password: PASS });
    check('Privilegiado por grupo anidado: protegido', pp.status === 302 && (await get(`/ad/cambios/nuevo?op=user_reset_password&id=${pedro.id}`)).text.includes('Objeto protegido'));
    check('Cuenta fuera de las OU gestionadas (servicio): protegida', (await get(`/ad/cambios/nuevo?op=user_delete&id=${svc.id}`)).text.includes('fuera de las unidades'));
    // Saltando la pantalla: el servicio vuelve a comprobar EN VIVO.
    const live = await adw.executeMany([{ op: 'user_disable', targetGuid: ana.object_guid, params: {} },
      { op: 'user_reset_password', targetGuid: pedro.object_guid, params: {} }]);
    check('Comprobación en vivo al ejecutar: privilegiados directos y anidados bloqueados', !live[0].ok && /protegido/.test(live[0].message)
      && !live[1].ok && /Administrators/.test(live[1].message) && ((await uac('ana.admin')) & 2) === 0);
    const soporte = await row('ad_groups', "name = 'Soporte-TI'", []);
    const nested = await doOp('group_add_member', soporte.id, { member: 'juan.perez', reauth_password: PASS });
    const soporteMembers = list((await ldap('(cn=Soporte-TI)', ['member']))[0].member);
    check('Grupo anidado en Administradores: agregar miembros bloqueado en vivo', /Administrators/.test(decode(nested.text))
      && !soporteMembers.some((m) => /juan/i.test(m)));
    const da = await adw.executeMany([{ op: 'group_add_member', targetGuid: (await row('ad_groups', "privileged = 'domain_admins'", [])).object_guid,
      params: { memberGuid: juan.object_guid } }]);
    check('Nunca se agrega a nadie a Domain Admins', !da[0].ok && !list((await ldap('(sAMAccountName=Domain Admins)', ['member']))[0].member).some((m) => /juan/i.test(m)));

    // ---------------- administrador: pide aprobacion ----------------
    user = ADMIN;
    let r = await doOp('user_disable', juan.id, { reason: '' });
    check('Pedir sin motivo: no se envía', r.status === 302 && !(await row('ad_change_requests', 'requested_by = ?', [ADMIN.id])));
    r = await doOp('user_disable', juan.id, { reason: 'Baja del colaborador (prueba)' });
    let req1 = await lastReq();
    check('Administrador pide deshabilitar: queda pendiente y el dominio NO cambia', req1 && req1.status === 'pendiente' && req1.via === 'aprobacion'
      && ((await uac('juan.perez')) & 2) === 0 && r.location === `/ad/cambios/${req1.id}`);
    check('El administrador no puede aprobar', (await post('/ad/cambios/aprobar', { ids: req1.id, ...(await reauthAdmin()) })).location === '/'
      && (await lastReq()).status === 'pendiente');
    user = SUPER;
    const pend = await get('/ad/cambios');
    check('El superadmin ve la solicitud pendiente con su contador', pend.text.includes(`#${req1.id}`) && pend.text.includes('Aprobar y ejecutar marcadas')
      && /bi-clipboard-check"><\/i> Cambios[\s\S]{0,200}>\d+</.test(pend.text));
    await post('/ad/cambios/aprobar', { ids: req1.id, reauth_password: 'mala' });
    check('Aprobar sin confirmar identidad: no se ejecuta', (await row('ad_change_requests', 'id = ?', [req1.id])).status === 'pendiente');
    await post('/ad/cambios/aprobar', { ids: req1.id, note: 'Ok', reauth_password: PASS });
    req1 = await row('ad_change_requests', 'id = ?', [req1.id]);
    check('Aprobada: se ejecuta en el dominio y queda quién decidió', req1.status === 'ejecutada' && req1.decided_by === SUPER.id && ((await uac('juan.perez')) & 2) === 2);

    // Restablecer con aprobacion: la contrasena la ve UNA vez quien la pidio.
    user = ADMIN;
    await doOp('user_reset_password', juan.id, { reason: 'Olvidó su clave', unlock: '1' });
    const req2 = await lastReq();
    user = SUPER;
    const ap2 = await post('/ad/cambios/aprobar', { ids: req2.id, reauth_password: PASS });
    const r2 = await row('ad_change_requests', 'id = ?', [req2.id]);
    check('Al aprobar, el superadmin NO ve la contraseña: queda cifrada para el solicitante', r2.status === 'ejecutada' && /^enc:v1:/.test(r2.secret_enc || '')
      && ap2.status === 302 && r2.secret_until);
    user = ADMIN;
    check('El solicitante ve el aviso de contraseña pendiente', (await get(`/ad/cambios/${req2.id}`)).text.includes('Ver la contraseña'));
    const reveal = await post(`/ad/cambios/${req2.id}/contrasena`, await reauthAdmin());
    const pw2 = decode(secretOf(reveal.text));
    await doOp('user_enable', juan.id, { reason: 'para probar la clave' });
    user = SUPER;
    await post('/ad/cambios/aprobar', { ids: (await lastReq()).id, reauth_password: PASS });
    check('La contraseña revelada es la que quedó en el dominio (se inicia sesión con ella)', pw2 && pw2.length === 16
      && (await canBind('juan.perez@prueba.local', pw2)) && (await row('ad_change_requests', 'id = ?', [req2.id])).secret_enc === null);
    user = ADMIN;
    const second = await post(`/ad/cambios/${req2.id}/contrasena`, await reauthAdmin());
    check('Se muestra una sola vez', second.status === 302 && !(await row('ad_change_requests', 'id = ?', [req2.id])).secret_enc);

    // Rechazar y cancelar.
    await doOp('user_delete', luciaRow.id, { reason: 'Prueba de rechazo' });
    const req3 = await lastReq();
    await doOp('user_unlock', luciaRow.id, { reason: 'Prueba de cancelación' });
    const req4 = await lastReq();
    await post(`/ad/cambios/${req4.id}/cancelar`, {});
    user = SUPER;
    await post('/ad/cambios/rechazar', { ids: req3.id, note: '' });
    check('Rechazar exige una nota', (await row('ad_change_requests', 'id = ?', [req3.id])).status === 'pendiente');
    await post('/ad/cambios/rechazar', { ids: req3.id, note: 'No corresponde' });
    check('Rechazada y cancelada: el usuario sigue en el dominio', (await row('ad_change_requests', 'id = ?', [req3.id])).status === 'rechazada'
      && (await row('ad_change_requests', 'id = ?', [req4.id])).status === 'cancelada' && (await ldap('(sAMAccountName=lucia.prueba)')).length === 1);

    // ---------------- permiso temporal ----------------
    await post('/ad/permisos', { user_id: ADMIN.id, groups: ['bloquear', 'contrasenas'], hours: '1', note: 'Prueba', reauth_password: PASS });
    const grant = await row('ad_grants', 'user_id = ? ORDER BY id DESC LIMIT 1', [ADMIN.id]);
    check('Superadmin da un permiso temporal (1 hora, con confirmación)', grant && grant.operations === 'bloquear,contrasenas' && !grant.revoked_at);
    user = ADMIN;
    const fg = await get(`/ad/cambios/nuevo?op=user_disable&id=${luciaRow.id}`);
    check('Con permiso, el formulario avisa que se ejecuta de inmediato y pide el código 2FA (con su cuenta regresiva)', fg.text.includes('permiso temporal') && fg.text.includes('reauth_code')
      && fg.text.includes('id="reauth_reloj"') && fg.text.includes('cambia cada 30 segundos'));
    await post('/ad/cambios', { op: 'user_disable', id: luciaRow.id, nonce: nonceOf(fg.text), reason: '', reauth_code: '000000' });
    check('Código 2FA equivocado: no se ejecuta', ((await uac('lucia.prueba')) & 2) === 0);
    await doOp('user_disable', luciaRow.id, await reauthAdmin());
    const req5 = await lastReq();
    check('Con permiso temporal: se ejecuta sin aprobación y cuenta el uso', req5.via === 'permiso_temporal' && req5.status === 'ejecutada'
      && ((await uac('lucia.prueba')) & 2) === 2 && (await row('ad_grants', 'id = ?', [grant.id])).uses_count === 1);
    await doOp('user_delete', luciaRow.id, { reason: 'Fuera del permiso' });
    check('Lo que el permiso no cubre sigue pidiendo aprobación', (await lastReq()).status === 'pendiente');
    user = SUPER;
    await post(`/ad/permisos/${grant.id}/revocar`, {});
    user = ADMIN;
    check('Revocado: vuelve a pedir aprobación', (await get(`/ad/cambios/nuevo?op=user_enable&id=${luciaRow.id}`)).text.includes('Se enviará como'));

    // ---------------- roles ----------------
    user = EDITOR;
    check('Editor sin el módulo: no entra', (await get('/ad/cambios')).status === 302);
    user = { ...SUPER, role: 'lector' };
    check('Lector: no puede pedir cambios', (await get('/ad/cambios/nuevo?op=user_disable&id=1')).status === 302);

    // ---------------- grupos, equipos, OU ----------------
    user = SUPER;
    await doOp('group_create', null, { ou_id: ventas.id, name: 'Cajeros-Prueba', scope: 'global', kind: 'seguridad', description: 'e2e', reauth_password: PASS });
    check('Crear grupo de seguridad global', (await ldap('(sAMAccountName=Cajeros-Prueba)', ['groupType']))[0]?.groupType === String(0x80000002 | 0));
    const og = await doOp('ou_create', null, { ou_id: ventas.id, name: 'Temporales', reauth_password: PASS });
    check('Crear sub-unidad organizativa', og.status === 200 && (await ldap('(ou=Temporales)')).length === 1);
    await doOp('computer_create', null, { ou_id: ventas.id, name: 'pc-caja-09', description: 'Caja 9', reauth_password: PASS });
    const pcNew = (await ldap('(sAMAccountName=PC-CAJA-09$)', ['userAccountControl', 'dNSHostName']))[0];
    check('Crear equipo (cuenta pre-creada para unirse al dominio)', pcNew && Number(pcNew.userAccountControl) === 4128 && pcNew.dNSHostName === 'pc-caja-09.prueba.local');
    await resync();
    const cajeros = await row('ad_groups', "name = 'Cajeros-Prueba'", []);
    await doOp('group_add_member', cajeros.id, { member: 'maria.lopez', reauth_password: PASS });
    check('Agregar miembro', list((await ldap('(sAMAccountName=Cajeros-Prueba)', ['member']))[0].member).some((m) => /maria|Maria/.test(m)));
    await resync();
    const hash = (await row('ad_group_members', 'group_id = ?', [cajeros.id])).member_hash;
    await doOp('group_remove_member', cajeros.id, { member_hash: hash, reauth_password: PASS }, `&miembro=${hash}`);
    check('Quitar miembro', list(((await ldap('(sAMAccountName=Cajeros-Prueba)', ['member']))[0] || {}).member).length === 0);
    await doOp('group_delete', cajeros.id, { reauth_password: PASS });
    check('Eliminar grupo', (await ldap('(sAMAccountName=Cajeros-Prueba)')).length === 0);

    // Mover un equipo a otra unidad gestionada; un controlador de dominio, nunca.
    const caja9 = await row('ad_computers', "name = 'PC-CAJA-09'", []);
    const arbol = (await get('/ad/unidades')).text;
    check('Árbol de unidades: menú de acciones con Mover para el equipo gestionado y sin él para el DC',
      arbol.includes(`op=computer_move&amp;id=${caja9.id}`) && arbol.includes('id="ad_arbol"') && arbol.includes('ou-mas')
      && !arbol.includes(`op=computer_move&amp;id=${(await row('ad_computers', 'is_dc = 1', [])).id}&`));
    await doOp('computer_move', caja9.id, { to_ou_id: sistemas.id, reauth_password: PASS });
    check('Mover equipo a otra unidad organizativa gestionada', /CN=PC-CAJA-09,OU=Sistemas,OU=Depilzone/i.test(((await ldap('(sAMAccountName=PC-CAJA-09$)'))[0] || {}).dn));
    // Un equipo recien unido (en CN=Computers) se mueve a una OU cuando el contenedor esta gestionado.
    const nueva = await row('ad_computers', "name = 'PC-RECIEN-UNIDA'", []);
    const fuera = await doOp('computer_move', nueva.id, { to_ou_id: sistemas.id, reauth_password: PASS });
    check('Equipo en Computers sin gestionar el contenedor: rechazado', /fuera de las unidades/.test(fuera.text + (await flashes()))
      && /CN=Computers/i.test(((await ldap('(sAMAccountName=PC-RECIEN-UNIDA$)'))[0] || {}).dn));
    cfg.ad_managed_ous = `${MANAGED}\nCN=Computers,${B}`;
    await doOp('computer_move', nueva.id, { to_ou_id: sistemas.id, reauth_password: PASS });
    check('Equipo en Computers con el contenedor gestionado: se mueve a la OU', /CN=PC-RECIEN-UNIDA,OU=Sistemas,OU=Depilzone/i.test(((await ldap('(sAMAccountName=PC-RECIEN-UNIDA$)'))[0] || {}).dn));
    cfg.ad_managed_ous = MANAGED;
    const mdc = await doOp('computer_move', (await row('ad_computers', 'is_dc = 1', [])).id, { to_ou_id: sistemas.id, reauth_password: PASS });
    check('Mover un controlador de dominio: rechazado', /controlador de dominio|fuera de las unidades/.test(mdc.text + (await flashes()))
      && /OU=Domain Controllers/i.test(((await ldap('(&(objectClass=computer)(userAccountControl:1.2.840.113556.1.4.803:=8192))'))[0] || {}).dn));

    // Lote: eliminar un equipo con su DNS (A y PTR); el DC queda fuera.
    const old = await row('ad_computers', "name = 'PC-ANTIGUA'", []);
    const dc = await row('ad_computers', 'is_dc = 1', []);
    const rev = await post('/ad/cambios/lote/revisar', { op: 'computer_delete', ids: [old.id, dc.id] });
    check('Lote: la revisión deja fuera al controlador de dominio', rev.text.includes('PC-ANTIGUA') && /No: .*(fuera de las unidades|controlador de dominio)/.test(rev.text)
      && (rev.text.match(/name="ids"/g) || []).length === 1);
    check('Antes: pc-antigua tiene A y PTR en el DNS', (await dnsSearch('(name=pc-antigua)')).length === 1 && (await dnsSearch('(&(objectClass=dnsNode)(name=30))')).length === 1);
    const lot = await post('/ad/cambios/lote', { op: 'computer_delete', ids: [old.id, dc.id], nonce: nonceOf(rev.text), reauth_password: PASS });
    check('Eliminar equipo: sale del dominio y de su OU, con su A y su PTR', lot.status === 200 && (await ldap('(sAMAccountName=PC-ANTIGUA$)')).length === 0
      && (await dnsSearch('(name=pc-antigua)')).length === 0 && (await dnsSearch('(&(objectClass=dnsNode)(name=30))')).length === 0
      && /borrado pc-antigua\.prueba\.local/.test(decode(lot.text)) && (await ldap(`(sAMAccountName=${dc.name}$)`)).length === 1);

    // Lote con aprobacion: el administrador pide deshabilitar dos usuarios.
    user = ADMIN;
    const revA = await post('/ad/cambios/lote/revisar', { op: 'user_disable', ids: [maria.id, luciaRow.id, ana.id] });
    await post('/ad/cambios/lote', { op: 'user_disable', ids: [maria.id, luciaRow.id, ana.id], nonce: nonceOf(revA.text), reason: 'Depuración de prueba' });
    const [batchRows] = await pool.query("SELECT * FROM ad_change_requests WHERE batch_id IS NOT NULL AND requested_by = ? AND status = 'pendiente'", [ADMIN.id]);
    check('Lote pedido por el administrador: una solicitud por objeto, sin la protegida', batchRows.length === 2 && batchRows.every((x) => x.batch_id === batchRows[0].batch_id)
      && !batchRows.some((x) => /ana/.test(x.target_label)));
    user = SUPER;
    await post('/ad/cambios/aprobar', { ids: batchRows.map((x) => x.id), reauth_password: PASS });
    check('El superadmin aprueba el lote de una vez', ((await uac('maria.lopez')) & 2) === 2);

    // ---------------- papelera ----------------
    if (E.AD_TEST_ADMIN_USER && E.AD_TEST_ADMIN_PASSWORD) {
      await doOp('user_delete', luciaRow.id, { reauth_password: PASS });
      check('Eliminar usuario (va a la papelera)', (await ldap('(sAMAccountName=lucia.prueba)')).length === 0);
      // Ver y restaurar la papelera necesita una delegacion que Samba no deja dar: se usa la cuenta Administrator de PRUEBA.
      cfg = { ...cfg, ad_bind_user: E.AD_TEST_ADMIN_USER, ad_bind_password: E.AD_TEST_ADMIN_PASSWORD, ad_write_user: E.AD_TEST_ADMIN_USER, ad_write_password: E.AD_TEST_ADMIN_PASSWORD };
      await resync();
      const del = await row('ad_deleted', "sam = 'lucia.prueba'", []);
      check('La papelera ofrece restaurar lo que estaba en una OU gestionada', del && (await get('/ad/papelera')).text.includes(`op=object_restore&id=${del.id}`));
      const rest = await doOp('object_restore', del.id, { reauth_password: PASS });
      check('Restaurar de la papelera: vuelve a su OU con su nombre', rest.status === 200 && /OU=Ventas,OU=Depilzone/.test(((await ldap('(sAMAccountName=lucia.prueba)'))[0] || {}).dn));
      cfg = { ...cfg, ad_bind_user: E.AD_TEST_USER, ad_bind_password: E.AD_TEST_PASSWORD, ad_write_user: E.AD_TEST_WRITE_USER, ad_write_password: E.AD_TEST_WRITE_PASSWORD };
    }

    // ---------------- vencimientos, pantallas, auditoria, bloqueo ----------------
    user = ADMIN;
    await doOp('user_unlock', maria.id, { reason: 'para vencer' });
    const req6 = await lastReq();
    await pool.query('UPDATE ad_change_requests SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?', [req6.id]);
    await pool.query("UPDATE ad_change_requests SET secret_enc = 'enc:v1:x', secret_until = NOW() - INTERVAL 1 MINUTE WHERE id = ?", [req1.id]);
    await changes.expire();
    check('Vencen las solicitudes de más de 7 días y las contraseñas no vistas en 24 h', (await row('ad_change_requests', 'id = ?', [req6.id])).status === 'vencida'
      && (await row('ad_change_requests', 'id = ?', [req1.id])).secret_enc === null);
    user = SUPER;
    const pages = { '/ad/cambios': 'Permisos temporales', [`/ad/cambios/${req1.id}`]: 'Baja del colaborador', '/ad/permisos': 'Dar un permiso temporal',
      '/ad/usuarios': 'id="adLote"', '/ad/equipos': 'Nuevo equipo', '/ad/grupos': 'Nuevo grupo', '/ad/unidades': 'gestionada',
      [`/ad/usuarios/${juan.id}`]: 'Restablecer contraseña', '/ad/configuracion': 'Cambios en el dominio', '/ad/cambios/nuevo?op=user_create': 'Usuario (inicio de sesión)' };
    const badPages = [];
    for (const [u, needle] of Object.entries(pages)) {
      const p = await get(u);
      if (p.status !== 200 || !p.text.includes(needle)) badPages.push(`${u} (${p.status})`);
    }
    check(`Pantallas de cambios (${Object.keys(pages).length})${badPages.length ? ': fallan ' + badPages.join(', ') : ''}`, !badPages.length);
    const rep = await get('/reportes?modulo=ad_cambios');
    check('Reporte de cambios: quién pidió, quién aprobó y el resultado', rep.status === 200 && rep.text.includes('Baja del colaborador')
      && rep.text.includes('E2E superadmin') && rep.text.includes('Permiso temporal'));
    const [aud] = await pool.query("SELECT DISTINCT action FROM audit_log WHERE user_email LIKE 'e2e-ad-%@prueba.invalid'");
    const acts = aud.map((a) => a.action);
    check('Todo queda en la auditoría', ['ad_cambio', 'ad_solicitud', 'ad_rechazada', 'ad_cancelada', 'ad_permiso_temporal', 'ad_permiso_revocado', 'ad_contrasena_vista',
      'ad_reauth_fallida', 'ad_configuracion_escritura'].every((a) => acts.includes(a)));
    for (let i = 0; i < 5; i += 1) await post('/ad/cambios/aprobar', { ids: 1, reauth_password: 'mala' });
    await post('/ad/cambios/aprobar', { ids: 1, reauth_password: PASS });
    check('Cinco confirmaciones fallidas bloquean 15 minutos (aunque luego acierte)', (await flashes()).includes('Demasiados intentos'));
    changes._.failures.clear();
    const src = fs.readFileSync(path.join(ROOT, 'src/services/adService.js'), 'utf8');
    check('El servicio de lectura sigue sin operaciones de escritura', !/\.(add|modify|modifyDN|del|exop)\s*\(/.test(src));
  } finally {
    await cleanup();
    server.close();
    await pool.end();
  }
  const fails = results.filter(([ok]) => !ok);
  for (const [ok, name] of results) console.log(`${ok ? 'PASA ' : 'FALLA'}  ${name}`);
  console.log(`\n${results.length - fails.length}/${results.length} pruebas correctas`);
  process.exit(fails.length ? 1 : 0);
}

function list(v) { return v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]); }

main().catch((err) => {
  for (const [ok, name] of results) console.log(`${ok ? 'PASA ' : 'FALLA'}  ${name}`);
  console.error(err);
  process.exit(1);
});
