// Prueba del modulo Directorio activo (fase 1, solo lectura) contra un
// controlador de dominio REAL de prueba (Samba AD DC en Docker, dominio
// prueba.local sembrado con OUs, usuarios, grupos anidados, equipos, DNS y
// un objeto en la papelera). No se usa contra un dominio de produccion.
//
// Variables (si faltan, la prueba no se ejecuta):
//   AD_TEST_URL=ldaps://dc1.prueba.local:636  AD_TEST_CA=/ruta/ca.pem
//   AD_TEST_USER=svc-gestor@prueba.local      AD_TEST_PASSWORD=...
//   AD_TEST_ADMIN_USER / AD_TEST_ADMIN_PASSWORD (opcional: para ver la papelera)
// Uso (dentro del contenedor): E2E_PERMITIR=1 AD_TEST_...=... node tests/ad.e2e.js
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

if (process.env.E2E_PERMITIR !== '1') {
  console.error('Esta prueba escribe (y luego borra) datos marcados en la base configurada. Ejecútela con E2E_PERMITIR=1.');
  process.exit(2);
}
const E = process.env;
if (!E.AD_TEST_URL || !E.AD_TEST_CA || !E.AD_TEST_USER || !E.AD_TEST_PASSWORD) {
  console.error('Faltan AD_TEST_URL, AD_TEST_CA, AD_TEST_USER y AD_TEST_PASSWORD (un DC de prueba, ver el encabezado).');
  process.exit(2);
}
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (name, cond) => results.push([!!cond, name]);
const CA = fs.readFileSync(E.AD_TEST_CA, 'utf8');

async function main() {
  const pool = require(path.join(ROOT, 'src/db/pool'));
  const settingsService = require(path.join(ROOT, 'src/services/settingsService'));
  const modules = require(path.join(ROOT, 'src/middleware/modules'));
  const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));
  let cfg = {};
  settingsService.getAll = async () => cfg;
  settingsService.get = async (k) => cfg[k];
  settingsService.setMany = async (p) => { cfg = { ...cfg, ...p }; };
  const ad = require(path.join(ROOT, 'src/services/adService'));
  const T = ad._;

  const cleanup = async () => {
    const like = '%DC=prueba,DC=local';
    await pool.query('DELETE FROM ad_group_members WHERE member_dn LIKE ?', [like]);
    await pool.query('DELETE FROM ad_users WHERE dn LIKE ?', [like]);
    await pool.query('DELETE FROM ad_groups WHERE dn LIKE ?', [like]);
    await pool.query('DELETE FROM ad_ous WHERE dn LIKE ?', [like]);
    await pool.query("DELETE FROM ad_dns_records WHERE zone LIKE '%prueba.local'");
    await pool.query('DELETE FROM ad_computers WHERE dn LIKE ?', [like]);
    await pool.query('DELETE FROM ad_deleted WHERE last_known_parent LIKE ?', [like]);
    await pool.query("DELETE FROM ad_sync_runs WHERE dc LIKE '%prueba.local'");
    await pool.query("DELETE FROM audit_log WHERE action LIKE 'ad\\_%' AND (target LIKE '%prueba.local%' OR target = 'directorio activo')");
  };
  await cleanup();
  const [[superadmin]] = await pool.query("SELECT id, email, full_name, role FROM users WHERE role = 'superadmin' AND active = 1 ORDER BY id LIMIT 1");
  let user = superadmin;
  const CSRF = 'token-de-prueba-ad-0123456789abcdef0123456789abcdef0123';
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'e2e', resave: false, saveUninitialized: true }));
  app.use(flash());
  app.use((req, res, next) => {
    req.session.user = user;
    req.session.csrfToken = CSRF;
    Object.assign(res.locals, { currentUser: user, csrfToken: CSRF, successMessages: req.flash('success'), errorMessages: req.flash('error'), currentPath: req.path,
      currentHost: req.hostname, appName: 'Prueba', enabledModules: new Proxy({}, { get: () => true }), mobileLabels });
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
  const form = async (u, data) => {
    const body = new URLSearchParams({ _csrf: CSRF, ...data });
    const r = keep(await fetch(base + u, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }));
    return { status: r.status, location: r.headers.get('location') };
  };
  const flashes = async () => (await get('/ad/configuracion')).text;
  const goodForm = { ad_url: E.AD_TEST_URL, ad_bind_user: E.AD_TEST_USER, ad_bind_password: E.AD_TEST_PASSWORD, ad_ca_pem: CA, ad_all_dcs: '1' };

  try {
    // ---------------- conversiones ----------------
    check('FILETIME: 0 y el máximo son "nunca"; una fecha real se convierte', T.fileTime('0') === null && T.fileTime('9223372036854775807') === null
      && T.fileTime('133000000000000000').toISOString().startsWith('2022-06-18'));
    check('GUID de AD (bytes en orden mixto)', T.guidOf(Buffer.from('00112233445566778899aabbccddeeff', 'hex')) === '33221100-5544-7766-8899-aabbccddeeff');
    check('SID binario a texto', T.sidOf(Buffer.from('010500000000000515000000a065cf7e784b9b5fe77c8770f4010000', 'hex')) === 'S-1-5-21-2127521184-1604012920-1887927527-500');
    const rec = Buffer.alloc(28);
    rec.writeUInt16LE(4, 0); rec.writeUInt16LE(1, 2); rec.writeUInt32BE(3600, 12); rec.writeUInt32LE(0, 20);
    Buffer.from([10, 10, 0, 21]).copy(rec, 24);
    const pa = T.parseDnsRecord(rec);
    check('Registro DNS de AD: tipo A, IP, TTL y estático', pa.rtype === 'A' && pa.data === '10.10.0.21' && pa.ttl === 3600 && pa.recordTs === null);
    check('Escapar DN dentro de un filtro LDAP', T.escapeDn('CN=Ana (TI)*,DC=x') === 'CN=Ana \\28TI\\29\\2a,DC=x');

    // ---------------- seguridad de la conexion ----------------
    const bad = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
    check('Se rechaza LDAP sin cifrar (ldap://)', /No se permite LDAP sin cifrar/.test(bad(() => ad.validateConfig({ ...goodForm, url: 'ldap://dc1:389', bindUser: 'x', password: 'y', caPem: CA }))));
    check('Sin certificado de CA no se conecta', /certificado de la CA/.test(bad(() => ad.validateConfig({ url: E.AD_TEST_URL, bindUser: 'x', password: 'y', caPem: '' }))));
    let msg = '';
    try { await ad.test({ url: E.AD_TEST_URL, bindUser: E.AD_TEST_USER, password: E.AD_TEST_PASSWORD, caPem: tls.rootCertificates[0] }); } catch (e) { msg = e.message; }
    check('Con otra CA el certificado del DC NO se acepta', /no se pudo validar/.test(msg));
    msg = '';
    try { await ad.test({ url: E.AD_TEST_URL, bindUser: E.AD_TEST_USER, password: 'clave-mala', caPem: CA }); } catch (e) { msg = e.message; }
    check('Contraseña equivocada: mensaje claro', /rechazó la cuenta/.test(msg));
    const t = await ad.test({ url: E.AD_TEST_URL, bindUser: E.AD_TEST_USER, password: E.AD_TEST_PASSWORD, caPem: CA });
    check('Conexión LDAPS válida: DN base, DC y certificado validado', /^DC=/.test(t.baseDn) && t.dc && t.cert && t.cert.ok === true && t.cert.validTo);
    const src = fs.readFileSync(path.join(ROOT, 'src/services/adService.js'), 'utf8');
    check('Fase 1 de solo lectura: el servicio no tiene ninguna operación de escritura LDAP', !/\.(add|modify|modifyDN|del|exop)\s*\(/.test(src));

    // ---------------- roles ----------------
    user = { ...superadmin, role: 'admin' };
    check('Un administrador no ve ni cambia la conexión (credenciales)', (await get('/ad/configuracion')).location === '/'
      && (await form('/ad/configuracion', goodForm)).location === '/' && !cfg.ad_url);
    user = { ...superadmin, role: 'editor' };
    const realEnabled = modules.realModuleEnabled;
    check('El módulo viene apagado para editor y lector; encendido para admin', !(await realEnabled('editor', 'directorio'))
      && !(await realEnabled('lector', 'directorio')) && (await realEnabled('admin', 'directorio')));

    // ---------------- configuracion (superadmin) ----------------
    user = superadmin;
    await form('/ad/configuracion', { ...goodForm, ad_ca_pem: tls.rootCertificates[0] });
    check('Configuración con CA equivocada: se prueba y NO se guarda', !cfg.ad_url && (await flashes()).includes('no se pudo validar'));
    await form('/ad/configuracion', goodForm);
    check('Configuración válida: se prueba, se guarda y la contraseña no se vuelve a mostrar', cfg.ad_url === E.AD_TEST_URL && cfg.ad_bind_password === E.AD_TEST_PASSWORD
      && !(await get('/ad/configuracion')).text.includes(E.AD_TEST_PASSWORD));

    // ---------------- lectura del dominio ----------------
    await form('/ad/sincronizar', {});
    const [[cnt]] = await pool.query("SELECT COUNT(*) AS n FROM ad_users WHERE dn LIKE '%DC=prueba,DC=local' AND removed_at IS NULL");
    const [[pedro]] = await pool.query("SELECT * FROM ad_users WHERE sam = 'pedro.soporte'");
    const [[ana]] = await pool.query("SELECT * FROM ad_users WHERE sam = 'ana.admin'");
    const [[maria]] = await pool.query("SELECT * FROM ad_users WHERE sam = 'maria.lopez'");
    check(`Usuarios leídos con la cuenta de servicio sin privilegios (${cnt.n})`, Number(cnt.n) >= 7);
    check('Privilegiados por SID: administradora directa y uno por grupo anidado', ana.privileged_groups.includes('domain_admins')
      && pedro.privileged_groups === 'administrators' && pedro.pwd_never_expires === 1);
    check('Deshabilitado y unidad organizativa', maria.enabled === 0 && /OU=Ventas,OU=Depilzone/.test(maria.ou_dn));
    const [[pc]] = await pool.query("SELECT * FROM ad_computers WHERE name = 'PC-VENTAS-01'");
    const [[old]] = await pool.query("SELECT * FROM ad_computers WHERE name = 'PC-ANTIGUA'");
    const [[ghost]] = await pool.query("SELECT * FROM ad_dns_records WHERE name = 'pc-fantasma'");
    check('Equipos con su IP desde el DNS integrado; uno sin DNS', pc.ips === '10.10.0.21' && !old.ips);
    check('Registro DNS sin equipo en AD (huérfano) detectado', ghost && ghost.computer_id === null && ghost.data === '10.10.0.99');
    const [[grp]] = await pool.query("SELECT * FROM ad_groups WHERE name = 'Ventas-Lima'");
    const [mem] = await pool.query('SELECT member_kind FROM ad_group_members WHERE group_id = ?', [grp.id]);
    check('Grupo con sus miembros directos', grp.member_count === 2 && mem.length === 2 && mem.every((m) => m.member_kind === 'usuario'));
    const [[ou]] = await pool.query("SELECT * FROM ad_ous WHERE name = 'Ventas'");
    check('Unidades organizativas con lo que contienen', ou && ou.users_count >= 2 && ou.groups_count >= 1);
    const [[runRow]] = await pool.query("SELECT * FROM ad_sync_runs WHERE dc LIKE '%prueba.local' ORDER BY id DESC LIMIT 1");
    const summary = JSON.parse(runRow.summary_json);
    check('Resumen del dominio: política, nivel, certificado y DC consultados', summary.policy.minPwdLength > 0 && summary.domainLevel && summary.cert.ok
      && summary.dcs.length >= 1 && runRow.status !== 'error');
    const [[aud]] = await pool.query("SELECT detail FROM audit_log WHERE action = 'ad_lectura' ORDER BY id DESC LIMIT 1");
    check('La lectura queda en la auditoría', aud && aud.detail.includes('usuario(s)'));

    // Releer no duplica; lo que desaparece queda marcado, no se borra.
    await form('/ad/sincronizar', {});
    const [[cnt2]] = await pool.query("SELECT COUNT(*) AS n FROM ad_users WHERE dn LIKE '%DC=prueba,DC=local' AND removed_at IS NULL");
    check('Volver a leer no duplica', Number(cnt2.n) === Number(cnt.n));

    // ---------------- pantallas ----------------
    const pages = { '/ad': 'Grupos privilegiados', '/ad/usuarios': 'pedro.soporte', [`/ad/usuarios/${pedro.id}`]: 'Privilegios de administración',
      '/ad/grupos': 'Ventas-Lima', [`/ad/grupos/${grp.id}`]: 'juan.perez', '/ad/unidades': 'Depilzone', '/ad/equipos': 'PC-VENTAS-01', '/ad/dns': 'Sin equipo en AD',
      '/ad/papelera': 'papelera', '/ad/configuracion': 'Probar y guardar' };
    const badPages = [];
    for (const [u, needle] of Object.entries(pages)) {
      const p = await get(u);
      if (p.status !== 200 || !p.text.includes(needle)) badPages.push(`${u} (${p.status})`);
    }
    check(`Todas las pantallas del módulo (${Object.keys(pages).length})${badPages.length ? ': fallan ' + badPages.join(', ') : ''}`, !badPages.length);
    const pu = await get('/ad/usuarios');
    check('Usuarios: columnas extra y antigüedad de conexión para filtrar', pu.text.includes('<th data-oculta>UPN</th>') && pu.text.includes('Nunca entró'));
    const [[never]] = await pool.query("SELECT COUNT(*) AS n FROM ad_users WHERE sam = 'juan.perez' AND last_logon IS NULL AND last_logon_ts IS NULL");
    const ov = await ad.overview();
    check('Quien nunca se conectó cuenta como "nunca" (no como "más de 1 año")', Number(never.n) === 1
      && (await ad.users()).find((x) => x.sam === 'juan.perez').last_seen === null && ov.lastSeen.some((x) => x.last_seen === null));
    const rep = await get('/reportes?modulo=ad_privilegiados');
    check('Reporte de cuentas privilegiadas', rep.text.includes('ana.admin') && rep.text.includes('pedro.soporte') && !rep.text.includes('>juan.perez<'));
    const repEq = await get('/reportes?modulo=ad_equipos');
    check('Reporte de equipos con IP y sistema operativo', repEq.text.includes('PC-VENTAS-01') && repEq.text.includes('10.10.0.21'));
    const panel = await get('/');
    check('Panel: bloque del directorio activo', panel.text.includes('id="panel_directorio"') && panel.text.includes('Con privilegios de administración'));

    // ---------------- papelera (cuenta con permiso) ----------------
    if (E.AD_TEST_ADMIN_USER && E.AD_TEST_ADMIN_PASSWORD) {
      cfg.ad_bind_user = E.AD_TEST_ADMIN_USER;
      cfg.ad_bind_password = E.AD_TEST_ADMIN_PASSWORD;
      await ad.sync(user);
      const [[del]] = await pool.query("SELECT * FROM ad_deleted WHERE sam = 'borrado.temp'");
      check('Papelera: el usuario eliminado aparece con su ubicación anterior', del && /OU=Ventas/.test(del.last_known_parent) && del.object_class === 'usuario');
    }
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

main().catch((err) => { console.error(err); process.exit(1); });
