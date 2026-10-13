// Prueba de los permisos por modulo en sus dos niveles:
//   por PERFIL  (role_modules): que modulos abre admin, editor y lector;
//   por USUARIO (user_modules): un permiso especial que manda sobre el perfil
//                               (sin acceso, solo ver, ver y editar).
//
// Usa las rutas REALES (Red, Usuarios, Permisos) con una sesion simulada. Crea
// usuarios marcados (correo @prueba-permisos.local) y datos ZZ-E2E, y los
// borra al final; deja role_modules como estaba. Pide E2E_PERMITIR=1.
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/permisos_usuario.e2e.js
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
  const modules = require(path.join(ROOT, 'src/middleware/modules'));
  const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));
  const DOM = '@prueba-permisos.local';
  const TAG = 'ZZ-E2E';
  const cleanup = async () => {
    await pool.query('DELETE FROM audit_log WHERE target LIKE ? OR target LIKE ?', [`%${DOM}`, `%${TAG}%`]);
    await pool.query('DELETE FROM users WHERE email LIKE ?', [`%${DOM}`]);
    await pool.query('DELETE FROM network_vlans WHERE name LIKE ?', [`${TAG}%`]);
  };
  await cleanup();
  const [savedAccess] = await pool.query('SELECT role, module, enabled FROM role_modules');
  const setRole = (role, module, enabled) => pool.query('INSERT INTO role_modules (role, module, enabled) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)', [role, module, enabled]);
  const restoreAccess = async () => {
    await pool.query('DELETE FROM role_modules');
    for (const r of savedAccess) await setRole(r.role, r.module, r.enabled);
  };
  for (const role of ['admin', 'editor', 'lector']) await setRole(role, 'red', 1);

  const [[superadmin]] = await pool.query("SELECT id, email, full_name, role FROM users WHERE role = 'superadmin' AND active = 1 ORDER BY id LIMIT 1");
  let seq = 0;
  const mk = async (role) => {
    seq += 1;
    const email = `${role}${seq > 3 ? seq : ''}${DOM}`;
    const [r] = await pool.query("INSERT INTO users (full_name, email, password_hash, role, active) VALUES (?, ?, 'x', ?, 1)", [`PRUEBA ${role}${seq > 3 ? ` ${seq}` : ''}`, email, role]);
    return { id: r.insertId, email, full_name: `PRUEBA ${role}${seq > 3 ? ` ${seq}` : ''}`, role };
  };
  const U = { lector: await mk('lector'), editor: await mk('editor'), admin: await mk('admin') };
  const setUser = async (u, module, access) => {
    await pool.query('DELETE FROM user_modules WHERE user_id = ? AND module = ?', [u.id, module]);
    if (access) await pool.query('INSERT INTO user_modules (user_id, module, access) VALUES (?, ?, ?)', [u.id, module, access]);
  };

  let user = superadmin;
  const CSRF = 'token-de-prueba-permisos-0123456789abcdef0123456789abcdef';
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'e2e', resave: false, saveUninitialized: true }));
  app.use(flash());
  app.use(async (req, res, next) => {
    req.session.user = user;
    req.session.csrfToken = CSRF;
    // Igual que src/app.js: el menu sale del permiso real del usuario.
    const overrides = await modules.userOverrides(user.id);
    const enabledModules = {};
    for (const k of Object.keys(modules.MODULES)) enabledModules[k] = await modules.moduleAllowed(user, k, overrides);
    Object.assign(res.locals, { currentUser: user, realRole: user.role, csrfToken: CSRF, successMessages: req.flash('success'), errorMessages: req.flash('error'), currentPath: req.path,
      currentHost: req.hostname, appName: 'Prueba', enabledModules, mobileLabels });
    next();
  });
  app.use('/red', require(path.join(ROOT, 'src/routes/network')));
  app.use('/usuarios', require(path.join(ROOT, 'src/routes/users')));
  app.use('/permisos', require(path.join(ROOT, 'src/routes/permissions')));
  app.use('/reportes', require(path.join(ROOT, 'src/routes/reports')));
  app.get('/', (req, res) => res.send(`INICIO ${res.locals.errorMessages.join(' | ')}`));
  app.use((err, req, res, next) => { res.status(500).send(`ERROR ${err.message}`); }); // eslint-disable-line no-unused-vars
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const keep = (r) => { const s = r.headers.get('set-cookie'); if (s) cookie = s.split(';')[0]; return r; };
  const get = async (u) => { const r = keep(await fetch(base + u, { redirect: 'manual', headers: { cookie } })); return { status: r.status, location: r.headers.get('location'), text: await r.text() }; };
  const post = async (u, data = {}) => {
    const body = new URLSearchParams({ _csrf: CSRF });
    Object.entries(data).forEach(([k, v]) => [].concat(v).forEach((x) => body.append(k, String(x))));
    const r = keep(await fetch(base + u, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }));
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  };
  const row = async (sql, args) => (await pool.query(sql, args))[0][0];
  const rows = async (sql, args) => (await pool.query(sql, args))[0];
  let n = 3930;
  // Intenta crear una VLAN: dice si quedo creada.
  const tryVlan = async () => { n += 1; await post('/red/vlan', { vlan_number: String(n), name: `${TAG} V${n}` }); return !!(await row('SELECT id FROM network_vlans WHERE name = ?', [`${TAG} V${n}`])); };
  const canSeeForm = async () => (await get('/red/vlan')).text.includes('id="vlan_form"');

  try {
    // ---------------- unidades ----------------
    check('Perfil efectivo: «solo ver» baja a lector; «ver y editar» sube al lector a editor y no cambia a los demás', modules.effectiveRole('editor', 'view') === 'lector' && modules.effectiveRole('admin', 'view') === 'lector'
      && modules.effectiveRole('lector', 'edit') === 'editor' && modules.effectiveRole('admin', 'edit') === 'admin' && modules.effectiveRole('editor', null) === 'editor');
    check('Por defecto: el administrador abre todo menos DevOps, como antes', modules.DEFAULT_MODULE_ACCESS.red.admin === true && modules.DEFAULT_MODULE_ACCESS.devops.admin === false
      && modules.DEFAULT_MODULE_ACCESS.directorio.admin === true && modules.CONFIGURABLE_ROLES.join() === 'admin,editor,lector');
    check('Sin permisos especiales manda el perfil', (await modules.moduleAccess(U.lector, 'red')).level === 'view' && (await modules.moduleAccess(U.editor, 'red')).level === 'edit'
      && (await modules.moduleAccess(U.admin, 'red')).override === null && (await modules.moduleAccess(superadmin, 'devops')).level === 'edit' && (await modules.moduleAccess(null, 'red')).level === 'none');

    // ---------------- lector ----------------
    user = U.lector;
    check('Lector por perfil: ve Red y no puede escribir', (await get('/red/vlan')).status === 200 && !(await canSeeForm()) && !(await tryVlan()));
    await setUser(U.lector, 'red', 'edit');
    check('Lector con «ver y editar» en Red: ve el formulario y puede crear', await canSeeForm() && await tryVlan());
    check('…pero no las acciones de administrador (herramientas, configuración de Omada)', (await get('/red/herramientas')).location === '/' && (await get('/red/omada/configuracion')).location === '/'
      && !(await get('/red/vlan')).text.includes('href="/red/herramientas"'));
    check('…y su perfil real no cambia: en el menú sigue siendo Lector', (await get('/red/vlan')).text.includes('text-uppercase">lector</span>'));
    await setRole('lector', 'red', 0);
    check('El permiso especial manda aunque el perfil tenga el módulo apagado', (await get('/red/vlan')).status === 200 && await tryVlan());
    await setUser(U.lector, 'red', null);
    check('Sin permiso especial y con el módulo apagado para su perfil: no entra', (await get('/red/vlan')).location === '/' && (await get('/')).text.includes('No tienes acceso a este módulo'));
    await setUser(U.lector, 'red', 'view');
    check('Lector con «solo ver» en un módulo apagado para su perfil: entra y no escribe', (await get('/red/vlan')).status === 200 && !(await canSeeForm()) && !(await tryVlan()));
    await setRole('lector', 'red', 1);
    await setUser(U.lector, 'red', null);

    // ---------------- editor ----------------
    user = U.editor;
    check('Editor por perfil: crea', await canSeeForm() && await tryVlan());
    await setUser(U.editor, 'red', 'view');
    check('Editor con «solo ver» en Red: entra, sin formulario, y no puede crear ni borrar', (await get('/red/vlan')).status === 200 && !(await canSeeForm()) && !(await tryVlan())
      && (await post(`/red/vlan/${(await row('SELECT id FROM network_vlans WHERE name LIKE ? LIMIT 1', [`${TAG}%`])).id}/eliminar`)).location === '/'
      && (await get('/')).text.includes('solo de consulta'));
    check('…y tampoco abre los formularios de alta', (await get('/red/equipos/nuevo')).location === '/' && (await get('/red/infraestructura/nuevo')).location === '/');
    await setUser(U.editor, 'red', 'none');
    check('Editor con «sin acceso» en Red: no entra y el módulo sale del menú', (await get('/red')).location === '/' && (await modules.moduleAllowed(U.editor, 'red')) === false
      && (await modules.moduleAllowed(U.editor, 'licencias')) === (await modules.moduleEnabled('editor', 'licencias')));
    await setUser(U.editor, 'red', null);
    check('Al quitar el permiso especial vuelve a su perfil', await tryVlan());

    // ---------------- administrador ----------------
    user = U.admin;
    check('Administrador por perfil: entra a las herramientas', (await get('/red/herramientas')).status === 200);
    await setUser(U.admin, 'red', 'view');
    check('Administrador con «solo ver» en Red: consulta, sin herramientas ni escritura', (await get('/red/vlan')).status === 200 && (await get('/red/herramientas')).location === '/' && !(await tryVlan())
      && (await get('/red/vlan')).text.includes('text-uppercase">admin</span>'));
    await setUser(U.admin, 'red', null);
    await setRole('admin', 'red', 0);
    check('El perfil Administrador ahora se configura: con Red apagado no entra', (await get('/red')).location === '/');
    await setRole('admin', 'red', 1);
    check('…y al habilitarlo vuelve a entrar', (await get('/red/herramientas')).status === 200);
    check('Un administrador no entra a Usuarios ni a Permisos', (await get('/usuarios')).location === '/' && (await get('/permisos')).location === '/'
      && (await post(`/usuarios/${U.lector.id}/editar`, { full_name: 'x', email: U.lector.email, role: 'lector', active: 'on', um_red: 'edit' })).location === '/'
      && !(await row('SELECT module FROM user_modules WHERE user_id = ?', [U.lector.id])));

    // ---------------- ficha del usuario ----------------
    user = superadmin;
    let page = await get(`/usuarios/${U.lector.id}/editar`);
    check('Ficha del usuario: un selector por módulo, con lo que le da su perfil', page.status === 200 && page.text.includes('id="permisos_especiales"') && Object.keys(modules.MODULES).every((k) => page.text.includes(`name="um_${k}"`))
      && page.text.includes('Según su perfil') && page.text.includes('Ver y editar') && page.text.includes('solo ver'));
    const form = (u, extra) => ({ full_name: u.full_name, email: u.email, role: u.role, active: 'on', ...extra });
    await post(`/usuarios/${U.lector.id}/editar`, form(U.lector, { um_red: 'edit', um_licencias: 'none', um_dominios: 'view', um_reportes: '', um_isp: 'inventado' }));
    const saved = await rows('SELECT module, access FROM user_modules WHERE user_id = ? ORDER BY module', [U.lector.id]);
    check('Guardar: solo quedan los permisos distintos al perfil; un valor inválido se ignora', saved.map((r) => `${r.module}=${r.access}`).join() === 'dominios=view,licencias=none,red=edit');
    page = await get(`/usuarios/${U.lector.id}/editar`);
    check('La ficha vuelve con lo guardado', /name="um_red"[^>]*>[\s\S]*?<option value="edit" selected/.test(page.text) && /name="um_licencias"[^>]*>[\s\S]*?<option value="none" selected/.test(page.text));
    check('Queda en la auditoría', /permisos especiales: .*red=edit/.test((await row("SELECT detail FROM audit_log WHERE action = 'user_update' AND target = ? ORDER BY id DESC LIMIT 1", [U.lector.email])).detail));
    user = U.lector;
    check('El usuario lo nota de inmediato: edita en Red y no entra a Licencias', await tryVlan() && (await modules.moduleAllowed(U.lector, 'licencias')) === false);
    user = superadmin;
    check('Lista de usuarios: marca quién tiene permisos especiales', (await get('/usuarios')).text.includes('+3 especiales') && !(await get('/usuarios')).text.includes('+0 especial'));
    page = await get('/permisos');
    check('Pantalla Permisos: columna Administrador y lista de usuarios con permisos especiales', page.text.includes('>Administrador</th>') && page.text.includes('name="m_admin_red"') && page.text.includes('id="permisos_usuarios"')
      && page.text.includes('PRUEBA lector') && page.text.includes('Red: ver y editar') && page.text.includes('Licencias: sin acceso'));
    const all = {};
    for (const k of Object.keys(modules.MODULES)) for (const r of ['admin', 'editor', 'lector']) if (!(r === 'admin' && k === 'certificados')) all[`m_${r}_${k}`] = '1';
    await post('/permisos', all);
    check('Guardar Permisos también guarda la columna Administrador', (await row("SELECT enabled FROM role_modules WHERE role = 'admin' AND module = 'certificados'")).enabled === 0
      && (await row("SELECT enabled FROM role_modules WHERE role = 'admin' AND module = 'red'")).enabled === 1 && (await modules.moduleEnabled('admin', 'certificados')) === false);
    // ---------------- reportes: solo de los módulos a los que tiene acceso ----------------
    const reportService = require(path.join(ROOT, 'src/services/reportService'));
    check('Todo reporte declara de qué módulo salen sus datos', Object.values(reportService.REPORTS).every((r) => !!modules.MODULES[r.module]));
    for (const m of ['reportes', 'celulares', 'certificados', 'licencias', 'dominios']) await setRole('lector', m, 1);
    await setUser(U.lector, 'celulares', 'none'); // ademas de licencias = sin acceso, dominios = solo ver, red = ver y editar
    user = U.lector;
    page = await get('/reportes?modulo=certificate');
    check('Reportes: no ofrece los de módulos sin acceso (Celulares, Chips, Licencias) y sí los demás', page.status === 200 && !page.text.includes('Celulares (equipos)') && !page.text.includes('Chips (líneas)')
      && !page.text.includes('Licencias de software') && page.text.includes('Certificados TLS') && page.text.includes('Dominios'));
    const rr1 = await get('/reportes?modulo=celulares');
    check('Pedir por la dirección el reporte de un módulo sin acceso: no lo muestra y lo dice', rr1.status === 302 && !rr1.location.includes('celulares')
      && (await get(rr1.location)).text.includes('No tienes acceso al módulo de ese reporte'));
    const blocked = async (u) => { const r = await fetch(base + u, { redirect: 'manual', headers: { cookie } }); return r.status === 302 && !/attachment/.test(r.headers.get('content-disposition') || ''); };
    check('Descargar (CSV, Excel o PDF) el reporte de un módulo sin acceso: no entrega ningún archivo', await blocked('/reportes/exportar.csv?modulo=celulares') && await blocked('/reportes/exportar.xlsx?modulo=chips')
      && await blocked('/reportes/exportar.pdf?modulo=license'));
    const okFile = await fetch(`${base}/reportes/exportar.csv?modulo=domain`, { redirect: 'manual', headers: { cookie } });
    check('…y sí descarga el de un módulo donde solo tiene «ver»', okFile.status === 200 && /reporte_domain_/.test(okFile.headers.get('content-disposition') || ''));
    check('Unidad: los reportes disponibles siguen al acceso por módulo', Object.keys(reportService.available(U.lector, { celulares: false, dominios: true })).join() === 'domain'
      && Object.keys(reportService.available(U.lector, { devops: true })).length === 0 && Object.keys(reportService.available(U.admin, { devops: true })).join() === 'repositorios'
      && Object.keys(reportService.available(U.lector, {})).length === 0);
    for (const k of Object.keys(modules.MODULES)) if (k !== 'reportes') await setUser(U.lector, k, 'none');
    const rr2 = await get('/reportes');
    check('Con Reportes habilitado pero sin acceso a ningún otro módulo: no hay reportes y se explica', rr2.location === '/' && (await get('/')).text.includes('ningún módulo del que se puedan sacar reportes')
      && await blocked('/reportes/exportar.csv?modulo=domain'));
    await setUser(U.lector, 'reportes', 'none');
    check('Sin acceso al propio módulo Reportes: no entra', (await get('/reportes')).location === '/' && await blocked('/reportes/exportar.csv?modulo=domain'));
    await pool.query('DELETE FROM user_modules WHERE user_id = ?', [U.lector.id]);
    for (const [m, a] of [['dominios', 'view'], ['licencias', 'none'], ['red', 'edit']]) await setUser(U.lector, m, a);
    user = superadmin;

    // ---------------- copiar a otros usuarios ----------------
    const copia = await mk('lector');
    await setUser(U.admin, 'red', 'view');
    page = await get(`/usuarios/${U.lector.id}/editar`);
    check('Ficha: sección para copiar los permisos guardados, con los demás usuarios (sin superadministradores)', page.text.includes('id="copiar_permisos"') && page.text.includes(`id="destino_${U.admin.id}"`)
      && !page.text.includes(`id="destino_${superadmin.id}"`) && !page.text.includes(`id="destino_${U.lector.id}"`) && page.text.includes('ya tiene 1 permiso(s) especial(es), se reemplazarán')
      && page.text.includes('Red: ver y editar'));
    const rc = await post(`/usuarios/${U.lector.id}/copiar-permisos`, { destino: [U.admin.id, copia.id, superadmin.id, U.lector.id, 99999999] });
    const copied = async (id) => (await rows('SELECT module, access FROM user_modules WHERE user_id = ? ORDER BY module', [id])).map((r) => `${r.module}=${r.access}`).join();
    check('Copiar: cada destino queda con exactamente los mismos permisos (se reemplazan los que tenía)', rc.location === `/usuarios/${U.lector.id}/editar#permisos_especiales`
      && (await copied(U.admin.id)) === 'dominios=view,licencias=none,red=edit' && (await copied(copia.id)) === 'dominios=view,licencias=none,red=edit'
      && (await copied(U.lector.id)) === 'dominios=view,licencias=none,red=edit');
    check('Nunca se copia a un superadministrador, y queda en la auditoría por cada destino', !(await row('SELECT module FROM user_modules WHERE user_id = ?', [superadmin.id]))
      && /copiados de lector@.*red=edit/.test((await row("SELECT detail FROM audit_log WHERE action = 'user_permissions_copy' AND target = ?", [copia.email])).detail)
      && (await get(`/usuarios/${U.lector.id}/editar`)).text.includes('copiados a:'));
    await post(`/usuarios/${U.lector.id}/copiar-permisos`, {});
    check('Sin marcar a nadie: avisa y no cambia nada', (await get(`/usuarios/${U.lector.id}/editar`)).text.includes('Marque al menos un usuario') && (await copied(copia.id)) === 'dominios=view,licencias=none,red=edit');
    await post(`/usuarios/${U.editor.id}/copiar-permisos`, { destino: [copia.id] });
    check('Un usuario sin permisos especiales no tiene qué copiar (no borra los del destino)', (await get(`/usuarios/${U.editor.id}/editar`)).text.includes('no tiene permisos especiales que copiar')
      && (await copied(copia.id)) === 'dominios=view,licencias=none,red=edit' && (await get(`/usuarios/${U.editor.id}/editar`)).text.includes('no tiene permisos especiales guardados'));
    user = U.admin;
    await setUser(U.admin, 'red', null);
    await pool.query('DELETE FROM user_modules WHERE user_id = ?', [U.admin.id]);
    check('Un administrador no puede copiar permisos', (await post(`/usuarios/${U.lector.id}/copiar-permisos`, { destino: [U.admin.id] })).location === '/' && !(await row('SELECT module FROM user_modules WHERE user_id = ?', [U.admin.id])));
    user = superadmin;
    await pool.query('DELETE FROM user_modules WHERE user_id = ?', [copia.id]);

    await post(`/usuarios/${U.lector.id}/editar`, form(U.lector, { role: 'superadmin', um_red: 'none' }));
    check('Al pasar a superadministrador se le quitan los permisos especiales', !(await row('SELECT module FROM user_modules WHERE user_id = ?', [U.lector.id]))
      && (await get(`/usuarios/${U.lector.id}/editar`)).text.includes('siempre tiene acceso a todo'));
    await setUser(U.editor, 'red', 'view');
    await post(`/usuarios/${U.editor.id}/eliminar`);
    check('Eliminar un usuario borra sus permisos especiales', !(await row('SELECT module FROM user_modules WHERE user_id = ?', [U.editor.id])));
    check('Usuario nuevo: el formulario no muestra permisos hasta que exista', !(await get('/usuarios/nuevo')).text.includes('id="permisos_especiales"'));
  } finally {
    await cleanup().catch((e) => console.error('limpieza:', e.message));
    await restoreAccess().catch((e) => console.error('permisos:', e.message));
    server.close();
    results.forEach(([ok, name]) => console.log(ok ? 'PASA ' : 'FALLA', name));
    const ok = results.filter((r) => r[0]).length;
    console.log(`\n${ok}/${results.length} pruebas correctas`);
    await pool.end();
    process.exit(ok === results.length && results.length ? 0 : 1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
