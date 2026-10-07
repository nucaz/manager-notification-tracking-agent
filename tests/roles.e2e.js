// Prueba de los roles de la aplicacion:
//   superadmin -> todo (credenciales, usuarios, permisos, respaldos,
//                 mantenimiento, conexion de Microsoft 365, IA)
//   admin      -> los modulos, catalogos, auditoria e historial de chat,
//                 pero NO lo critico
//   editor     -> escribe en los modulos; lector -> solo ve
// y que nunca se quede la aplicacion sin un superadministrador activo.
//
// Usa las rutas REALES con una sesion simulada. Crea un usuario marcado
// (correo @prueba-roles.local) y lo borra al final. Pide E2E_PERMITIR=1.
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/roles.e2e.js
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

if (process.env.E2E_PERMITIR !== '1') {
  console.error('Esta prueba escribe (y luego borra) datos marcados en la base configurada. Ejecútela con E2E_PERMITIR=1.');
  process.exit(2);
}
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (name, cond) => results.push([!!cond, name]);

async function main() {
  const pool = require(path.join(ROOT, 'src/db/pool'));
  const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));
  const DOM = '@prueba-roles.local';
  const cleanup = async () => {
    await pool.query('DELETE FROM audit_log WHERE target LIKE ?', [`%${DOM}`]);
    await pool.query('DELETE FROM users WHERE email LIKE ?', [`%${DOM}`]);
  };
  await cleanup();
  const [[superadmin]] = await pool.query("SELECT id, email, full_name, role FROM users WHERE role = 'superadmin' AND active = 1 ORDER BY id LIMIT 1");
  const [{ insertId: tempId }] = await pool.query(
    "INSERT INTO users (full_name, email, password_hash, role, active) VALUES ('PRUEBA Roles', ?, 'x', 'admin', 1)", [`otro${DOM}`]
  );
  let user = superadmin;
  const CSRF = 'token-de-prueba-roles-0123456789abcdef0123456789abcdef';
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
  app.use('/usuarios', require(path.join(ROOT, 'src/routes/users')));
  app.use('/permisos', require(path.join(ROOT, 'src/routes/permissions')));
  app.use('/auditoria', require(path.join(ROOT, 'src/routes/audit')));
  app.use('/historial-chat', require(path.join(ROOT, 'src/routes/chatHistory')));
  app.use('/mantenimiento', require(path.join(ROOT, 'src/routes/maintenance')));
  app.use('/configuracion/catalogos', require(path.join(ROOT, 'src/routes/catalogs')));
  app.use('/configuracion/respaldos', require(path.join(ROOT, 'src/routes/backups')));
  app.use('/configuracion/ia', require(path.join(ROOT, 'src/routes/aiSettings')));
  app.use('/configuracion', require(path.join(ROOT, 'src/routes/settings')));
  app.use('/m365', require(path.join(ROOT, 'src/routes/m365')));
  app.get('/', (req, res) => res.send('INICIO'));
  app.use((err, req, res, next) => { res.status(500).send(`ERROR ${err.message}`); }); // eslint-disable-line no-unused-vars
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (u) => { const r = await fetch(base + u, { redirect: 'manual' }); return { status: r.status, location: r.headers.get('location') }; };
  const form = async (u, data) => {
    const body = new URLSearchParams({ _csrf: CSRF, ...data });
    const r = await fetch(base + u, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    return { status: r.status, location: r.headers.get('location') };
  };
  const opens = async (u) => (await get(u)).status === 200;
  const CRITICAL = ['/usuarios', '/permisos', '/mantenimiento', '/configuracion', '/configuracion/respaldos', '/configuracion/ia', '/m365/configuracion'];
  const ADMIN_OK = ['/auditoria', '/historial-chat', '/configuracion/catalogos'];

  try {
    check('Hay al menos un superadministrador activo (la migración convirtió a los administradores)', !!superadmin);
    user = superadmin;
    const superOpens = await Promise.all([...CRITICAL, ...ADMIN_OK].map(opens));
    check(`Superadmin abre todo (${CRITICAL.length + ADMIN_OK.length} pantallas)`, superOpens.every(Boolean));

    user = { ...superadmin, role: 'admin' };
    const adminCritical = await Promise.all(CRITICAL.map(get));
    check('Administrador: no entra a lo crítico (credenciales, usuarios, permisos, respaldos, mantenimiento, IA, conexión M365)',
      adminCritical.every((r) => r.status === 302 && r.location === '/'));
    check('Administrador: sí entra a catálogos, auditoría e historial de chat', (await Promise.all(ADMIN_OK.map(opens))).every(Boolean));
    check('Administrador: no puede guardar la conexión de Microsoft 365', (await form('/m365/configuracion', { m365_tenant_id: 'x' })).location === '/');

    user = { ...superadmin, role: 'editor' };
    check('Editor: no entra a catálogos ni a lo crítico', !(await opens('/configuracion/catalogos')) && !(await opens('/configuracion')));
    user = { ...superadmin, role: 'lector' };
    check('Lector: no entra a la administración', !(await opens('/auditoria')) && !(await opens('/usuarios')));

    // Nunca sin superadministrador.
    user = superadmin;
    const [[{ n: supers }]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin' AND active = 1");
    if (Number(supers) === 1) {
      const r = await form(`/usuarios/${superadmin.id}/editar`, { full_name: superadmin.full_name, email: superadmin.email, role: 'admin', active: '1' });
      const [[still]] = await pool.query('SELECT role FROM users WHERE id = ?', [superadmin.id]);
      check('El único superadministrador activo no se puede bajar de rol', r.status === 302 && still.role === 'superadmin');
    } else {
      check('(Hay varios superadministradores: la protección del último se prueba sola)', true);
    }
    await form(`/usuarios/${tempId}/editar`, { full_name: 'PRUEBA Roles', email: `otro${DOM}`, role: 'superadmin', active: '1' });
    const [[promoted]] = await pool.query('SELECT role FROM users WHERE id = ?', [tempId]);
    check('El superadmin puede nombrar a otro superadministrador', promoted.role === 'superadmin');
    await form(`/usuarios/${tempId}/editar`, { full_name: 'PRUEBA Roles', email: `otro${DOM}`, role: 'admin', active: '1' });
    const [[demoted]] = await pool.query('SELECT role FROM users WHERE id = ?', [tempId]);
    check('Con otro superadmin activo, sí se puede bajar a administrador', demoted.role === 'admin');
    const bad = await form(`/usuarios/${tempId}/editar`, { full_name: 'PRUEBA Roles', email: `otro${DOM}`, role: 'dios', active: '1' });
    check('Un rol inventado se rechaza', bad.location === `/usuarios/${tempId}/editar` && (await pool.query('SELECT role FROM users WHERE id = ?', [tempId]))[0][0].role === 'admin');
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
