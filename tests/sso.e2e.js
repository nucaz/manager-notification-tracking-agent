// Prueba del acceso unico con DevOps Sidecar, del lado de esta aplicacion:
// emision de pases, entrada /devops, permiso por rol y llamadas de
// servicio. El sidecar se SIMULA con un servidor local que verifica la
// firma por su cuenta; la otra mitad (el sidecar real aceptando estos
// pases) esta en devops-sidecar/tests/test_sso.py, con los mismos vectores.
//
// Solo escribe (y borra) filas de auditoria con accion "devops_sso".
// Uso (dentro del contenedor): node tests/sso.e2e.js
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

const ROOT = path.join(__dirname, '..');
const SECRET = 'secreto-de-prueba';
process.env.SSO_SHARED_SECRET = SECRET; // antes de cargar la configuracion
process.env.SIDECAR_PUBLIC_URL = '';
const env = require(path.join(ROOT, 'src/config/env'));
env.ssoSharedSecret = SECRET;
env.sidecarPublicUrl = '';
const pool = require(path.join(ROOT, 'src/db/pool'));
const settingsService = require(path.join(ROOT, 'src/services/settingsService'));
const ssoService = require(path.join(ROOT, 'src/services/ssoService'));
const modules = require(path.join(ROOT, 'src/middleware/modules'));

const results = [];
const check = (name, cond) => results.push([!!cond, name]);

// Los mismos pases que verifica devops-sidecar/tests/test_sso.py.
const VECTOR_PASE = 'v1.eyJhdWQiOiJzaWRlY2FyLXNzbyIsImV4cCI6NDEwMjQ0NDgwMCwianRpIjoidmVjdG9yLTEiLCJzdWIiOiJhbmFAcHJ1ZWJhIiwibmFtZSI6IkFuYSDDkWFuZMO6Iiwicm9sZSI6ImFkbWluIiwiYXBwIjoiaHR0cHM6Ly9hcHAucHJ1ZWJhIn0'
  + '.OXsCKS10oXunFBSzxqG4CFx0cfzjoCVf83IbxE7zLw0';
const VECTOR_SERVICIO = 'v1.eyJhdWQiOiJzaWRlY2FyLWFwaSIsImV4cCI6NDEwMjQ0NDgwMCwic3ViIjoiYXBsaWNhY2lvbi1wcmluY2lwYWwifQ.oiShJEAh4r7gKwhQ8zL2eA8iWNmTvLDxIFHs0UYaSZg';

// Verificacion independiente (como la hace el sidecar).
function read(token, audience) {
  const [version, body, signature] = String(token).split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(`v1.${body}`).digest('base64url');
  if (version !== 'v1' || signature !== expected) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  return payload.aud === audience && payload.exp > Date.now() / 1000 ? payload : null;
}

async function main() {
  const [[admin]] = await pool.query("SELECT id, email, full_name, role FROM users WHERE role IN ('superadmin', 'admin') ORDER BY role = 'superadmin' DESC, id LIMIT 1");
  const seen = { auth: [] };
  const sidecar = express();
  sidecar.get('/api/repos', (req, res) => {
    seen.auth.push(req.get('authorization') || '');
    const bearer = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (bearer && read(bearer[1], 'sidecar-api')) return res.json([{ id: 1, name: 'repo-de-prueba', active: true }]);
    res.status(401).json({ detail: 'Sesion no iniciada.' });
  });
  const fake = sidecar.listen(0);
  settingsService.getAll = async () => ({ devops_sidecar_url: `http://127.0.0.1:${fake.address().port}`, devops_sidecar_user: '', devops_sidecar_password: '' });
  const devopsSidecarClient = require(path.join(ROOT, 'src/services/devopsSidecarClient'));

  let user = admin;
  let allowed = {};
  modules.moduleEnabled = async (role, key) => role === 'superadmin' || !!allowed[key];
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.use(session({ secret: 'e2e', resave: false, saveUninitialized: true }));
  app.use(flash());
  app.use((req, res, next) => {
    req.session.user = user;
    Object.assign(res.locals, { currentUser: user, csrfToken: 'x', successMessages: [], errorMessages: [], currentPath: req.path,
      currentHost: req.hostname, appName: 'Prueba', enabledModules: new Proxy({}, { get: (t, k) => user.role === 'superadmin' || !!allowed[k] }) });
    next();
  });
  app.use('/devops', require(path.join(ROOT, 'src/routes/devops')));
  app.get('/', (req, res) => res.render('partials/head', { title: 'x' }, (err, html) => res.send(err ? err.message : `${html}|${JSON.stringify(req.flash('error'))}`)));
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const get = async (url) => {
    const r = await fetch(base + url, { redirect: 'manual', headers: { cookie } });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, location: r.headers.get('location'), cache: r.headers.get('cache-control'), text: await r.text() };
  };
  const tokenOf = (html) => (/name="token" value="([^"]+)"/.exec(html) || [])[1];

  try {
    // --- Formato del pase
    check('Los pases que emite esta aplicación son exactamente los que el sidecar tiene probados (mismo formato y firma)',
      ssoService._sign({ aud: 'sidecar-sso', exp: 4102444800, jti: 'vector-1', sub: 'ana@prueba', name: 'Ana Ñandú', role: 'admin', app: 'https://app.prueba' }) === VECTOR_PASE
      && ssoService._sign({ aud: 'sidecar-api', exp: 4102444800, sub: 'aplicacion-principal' }) === VECTOR_SERVICIO);

    // --- Entrada de un administrador
    let p = await get('/devops');
    const pass = read(tokenOf(p.text), 'sidecar-sso');
    check('Menú DevOps: entrega al navegador un formulario que envía el pase al sidecar (POST, no en la URL)', p.status === 200
      && p.text.includes(`<form method="post" action="http://127.0.0.1:8091/sso"`) && p.cache === 'no-store' && !p.text.includes('?token='));
    check('El pase identifica al usuario de esta aplicación, vence en un minuto y dice a dónde volver', pass && pass.sub === admin.email && pass.role === 'superadmin'
      && pass.name === admin.full_name && pass.app === base && pass.exp - Date.now() / 1000 <= 60 && pass.exp > Date.now() / 1000 && /^[0-9a-f]{32}$/.test(pass.jti));
    const p2 = await get('/devops');
    check('Cada entrada genera un pase distinto (de un solo uso)', read(tokenOf(p2.text), 'sidecar-sso').jti !== pass.jti);
    const [[audit]] = await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'devops_sso' AND user_id = ? AND created_at > NOW() - INTERVAL 2 MINUTE", [admin.id]);
    check('Cada entrada a DevOps queda en la auditoría', audit.n >= 2);

    env.sidecarPublicUrl = 'https://{host}:8443';
    p = await get('/devops');
    check('Con HTTPS, la dirección del sidecar sale de SIDECAR_PUBLIC_URL', p.text.includes('action="https://127.0.0.1:8443/sso"'));
    env.sidecarPublicUrl = '';

    // --- Permiso por rol
    user = { ...admin, role: 'editor' };
    p = await get('/devops');
    const home = await get('/');
    check('Un editor sin el permiso DevOps no recibe pase ni ve el enlace en el menú', p.status === 302 && p.location === '/' && home.text.includes('No tienes acceso a DevOps')
      && !home.text.includes('href="/devops"'));
    allowed = { devops: true };
    p = await get('/devops');
    const editorPass = read(tokenOf(p.text), 'sidecar-sso');
    check('Con el permiso DevOps habilitado en Permisos, el editor entra con su propio usuario', p.status === 200 && editorPass.role === 'editor'
      && (await get('/')).text.includes('href="/devops"'));
    check('El permiso DevOps viene apagado para editor y lector (dentro del sidecar no hay roles)', modules.DEFAULT_MODULE_ACCESS.devops.editor === false
      && modules.DEFAULT_MODULE_ACCESS.devops.lector === false && modules.DEFAULT_MODULE_ACCESS.reportes.editor === true);
    user = admin;
    allowed = {};
    // Rol administrador (sin lo critico): DevOps guarda credenciales y restaura -> no entra.
    const realModuleEnabled = require(path.join(ROOT, 'src/middleware/modules')).realModuleEnabled;
    check('Un administrador (no superadmin) no tiene DevOps por defecto; el superadmin sí', realModuleEnabled
      && !(await realModuleEnabled('admin', 'devops')) && (await realModuleEnabled('admin', 'reportes')) && (await realModuleEnabled('superadmin', 'devops')));

    // --- Llamadas de servicio
    const repos = await devopsSidecarClient.listRepos();
    const sent = read((/^Bearer (.+)$/.exec(seen.auth[0]) || [])[1], 'sidecar-api');
    check('Las consultas a la API del sidecar van con pase de servicio firmado, sin usuario ni contraseña guardados', repos[0].name === 'repo-de-prueba'
      && sent && sent.sub === 'aplicacion-principal' && sent.exp - Date.now() / 1000 <= 60 && !seen.auth[0].startsWith('Basic'));

    // --- Sin secreto compartido: como antes
    env.ssoSharedSecret = '';
    p = await get('/devops');
    check('Sin secreto compartido: el menú lleva directo al sidecar, que pide su propio usuario', p.status === 302 && p.location === 'http://127.0.0.1:8091');
    let message = '';
    try { await devopsSidecarClient.listRepos(); } catch (err) { message = err.message; }
    check('Sin secreto compartido: la API sigue pidiendo usuario y contraseña en Configuración', message.includes('DevOps Sidecar no esta configurado'));
    env.ssoSharedSecret = SECRET;
  } finally {
    server.close();
    fake.close();
    await pool.query("DELETE FROM audit_log WHERE action = 'devops_sso' AND created_at > NOW() - INTERVAL 5 MINUTE AND target LIKE 'http%127.0.0.1%'");
    await pool.end();
  }
}

main()
  .catch((err) => { console.error(err); results.push([false, `Excepción: ${err.message}`]); })
  .finally(() => {
    for (const [ok, name] of results) console.log(`${ok ? 'PASA ' : 'FALLA'} ${name}`);
    const ok = results.filter((r) => r[0]).length;
    console.log(`\n${ok}/${results.length} pruebas correctas`);
    process.exit(ok === results.length ? 0 : 1);
  });
