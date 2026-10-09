// Prueba del modulo Red: inventario de equipos (PC, AP, switches), datos de
// red de los celulares, VLAN y herramientas de diagnostico (ping, ruta, DNS,
// puertos), con sus limites de seguridad y de rol.
//
// Usa las rutas REALES con una sesion simulada. Crea datos marcados (ZZ-E2E)
// y los borra al final. Pide E2E_PERMITIR=1.
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/red.e2e.js
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
  const net = require(path.join(ROOT, 'src/services/networkService'));
  const tools = require(path.join(ROOT, 'src/services/netToolsService'));
  const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));
  const TAG = 'ZZ-E2E';
  const IMEI = '990000000000017';
  const GLPI_ID = 99999917;
  const cleanup = async () => {
    await pool.query('DELETE FROM network_devices WHERE name LIKE ? OR mobile_device_id IN (SELECT id FROM mobile_devices WHERE imei = ?)', [`${TAG}%`, IMEI]);
    await pool.query('DELETE FROM network_vlans WHERE name LIKE ?', [`${TAG}%`]);
    await pool.query('DELETE FROM mobile_devices WHERE imei = ?', [IMEI]);
    await pool.query("DELETE FROM glpi_assets WHERE asset_type = 'computadoras' AND glpi_id IN (?, ?)", [GLPI_ID, GLPI_ID + 1]);
    await pool.query("DELETE FROM audit_log WHERE action LIKE 'red\\_%' AND (target LIKE ? OR detail LIKE ? OR target IN ('equipos de red', '127.0.0.1', 'localhost'))", [`%${TAG}%`, `%${TAG}%`]);
  };
  await cleanup();
  // El acceso de editor y lector al modulo depende de Permisos: se habilita para la prueba y al final se deja como estaba.
  const [savedAccess] = await pool.query("SELECT role, enabled FROM role_modules WHERE module = 'red'");
  const setAccess = (role, enabled) => pool.query('INSERT INTO role_modules (role, module, enabled) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)', [role, 'red', enabled]);
  const restoreAccess = async () => {
    await pool.query("DELETE FROM role_modules WHERE module = 'red'");
    for (const r of savedAccess) await setAccess(r.role, r.enabled);
  };
  await setAccess('editor', 1);
  await setAccess('lector', 1);
  const [[superadmin]] = await pool.query("SELECT id, email, full_name, role FROM users WHERE role = 'superadmin' AND active = 1 ORDER BY id LIMIT 1");
  let user = superadmin;
  const as = (role) => { user = { ...superadmin, role }; };
  const CSRF = 'token-de-prueba-red-0123456789abcdef0123456789abcdef';
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'e2e', resave: false, saveUninitialized: true }));
  app.use(flash());
  let lastFlash = { ok: [], err: [] };
  app.use((req, res, next) => {
    req.session.user = user;
    req.session.csrfToken = CSRF;
    lastFlash = { ok: req.flash('success'), err: req.flash('error') };
    Object.assign(res.locals, { currentUser: user, csrfToken: CSRF, successMessages: lastFlash.ok, errorMessages: lastFlash.err, currentPath: req.path,
      currentHost: req.hostname, appName: 'Prueba', enabledModules: new Proxy({}, { get: () => true }), mobileLabels });
    next();
  });
  app.use('/red', require(path.join(ROOT, 'src/routes/network')));
  app.get('/', (req, res) => res.send('INICIO'));
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
  // El mensaje del ultimo POST sale en la siguiente pagina.
  const flashOf = async () => (await get('/red/vlan')).text;
  const row = async (sql, args) => (await pool.query(sql, args))[0][0];

  try {
    // ---------------- unidades ----------------
    check('MAC: acepta dos puntos, guiones, puntos o seguida y la normaliza', net.normalizeMac('aa-bb-cc-dd-ee-0f') === 'AA:BB:CC:DD:EE:0F'
      && net.normalizeMac('aabb.ccdd.ee0f') === 'AA:BB:CC:DD:EE:0F' && net.normalizeMac('AABBCCDDEE0F') === 'AA:BB:CC:DD:EE:0F' && net.normalizeMac('') === null);
    const bad = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
    check('MAC: rechaza la incompleta, la no hexadecimal y la de todo ceros', /12 dígitos/.test(bad(() => net.normalizeMac('AA:BB:CC'))) && /12 dígitos/.test(bad(() => net.normalizeMac('GG:BB:CC:DD:EE:FF')))
      && /no es válida/.test(bad(() => net.normalizeMac('00:00:00:00:00:00'))));
    const T = tools._;
    check('Destino: nombre o IPv4; nada que pueda ser una opción o un comando', T.target('PC-Ventas-01') === 'pc-ventas-01' && T.target('172.16.1.20') === '172.16.1.20'
      && ['-c 1', '127.0.0.1; ls', '$(id)', 'a b', '--help', 'x|y', '`id`', ''].every((h) => bad(() => T.target(h))));
    check('Puertos: lista, rango, los comunes por defecto y el tope', T.parsePorts('80, 443;3389').join() === '80,443,3389' && T.parsePorts('8000-8003').length === 4
      && T.parsePorts('').length === Object.keys(tools.COMMON_PORTS).length && /máximo/.test(bad(() => T.parsePorts('1-500'))) && /no válido/.test(bad(() => T.parsePorts('80,abc'))));
    check('Red interna: solo 10/8, 172.16/12 y 192.168/16', T.isPrivate('10.1.2.3') && T.isPrivate('172.16.1.22') && T.isPrivate('192.168.0.5')
      && !T.isPrivate('8.8.8.8') && !T.isPrivate('172.32.0.1') && !T.isPrivate('127.0.0.1') && !T.isPrivate('169.254.169.254'));

    // ---------------- VLAN ----------------
    await post('/red/vlan', { vlan_number: '3917', name: `${TAG} Administración`, subnet: '172.16.10.0/24', gateway: '172.16.10.1', sede: '', notes: 'prueba' });
    const v1 = await row('SELECT * FROM network_vlans WHERE name = ?', [`${TAG} Administración`]);
    check('Crear VLAN con subred y puerta de enlace', v1 && v1.vlan_number === 3917 && v1.subnet === '172.16.10.0/24' && v1.gateway === '172.16.10.1' && v1.sede === null);
    await post('/red/vlan', { vlan_number: '3917', name: `${TAG} Repetida` });
    check('VLAN repetida en la misma sede: rechazada', !(await row('SELECT id FROM network_vlans WHERE name = ?', [`${TAG} Repetida`])) && (await flashOf()).includes('Ya existe la VLAN 3917'));
    await post('/red/vlan', { vlan_number: '5000', name: `${TAG} Fuera` });
    await post('/red/vlan', { vlan_number: '3918', name: `${TAG} Mala`, subnet: '172.16.10.0/40' });
    check('VLAN fuera de rango o con subred inválida: rechazadas', !(await row('SELECT id FROM network_vlans WHERE name IN (?, ?)', [`${TAG} Fuera`, `${TAG} Mala`])));
    await post('/red/vlan', { vlan_number: '3918', name: `${TAG} Invitados`, sede: 'Surco' });
    const v2 = await row('SELECT * FROM network_vlans WHERE name = ?', [`${TAG} Invitados`]);
    await post('/red/vlan', { id: v2.id, vlan_number: '3919', name: `${TAG} Invitados`, sede: 'Surco', notes: 'editada' });
    check('Editar VLAN', (await row('SELECT * FROM network_vlans WHERE id = ?', [v2.id])).vlan_number === 3919);

    // ---------------- equipos a mano ----------------
    await post('/red/equipos/nuevo', { kind: 'switch', name: `${TAG}-SW1`, mac: 'aa-bb-cc-00-17-01', ip: '172.16.1.250', sede: 'Surco', area: 'Sistemas', location: 'Rack A',
      brand_model: 'Cisco CBS350', notes: 'principal', vlan_ids: [v1.id, v2.id] });
    const sw = await row('SELECT * FROM network_devices WHERE name = ?', [`${TAG}-SW1`]);
    const swV = (await pool.query('SELECT vlan_id FROM network_device_vlans WHERE device_id = ?', [sw.id]))[0];
    check('Registrar un switch con MAC, IP, sede, área, notas y dos VLAN', sw && sw.mac === 'AA:BB:CC:00:17:01' && sw.ip === '172.16.1.250' && sw.sede === 'Surco' && sw.area === 'Sistemas'
      && sw.source === 'manual' && swV.length === 2);
    await post('/red/equipos/nuevo', { kind: 'ap', name: `${TAG}-AP1`, mac: 'AA:BB:CC:00:17:01' });
    check('MAC ya registrada en otro equipo: rechazada y dice en cuál', !(await row('SELECT id FROM network_devices WHERE name = ?', [`${TAG}-AP1`]))
      && (await flashOf()).includes(`ya está registrada en ${TAG}-SW1`));
    await post('/red/equipos/nuevo', { kind: 'ap', name: `${TAG}-AP1`, mac: 'AA:BB:CC:00:17:02', ip: '999.1.1.1' });
    check('IP inválida: rechazada', !(await row('SELECT id FROM network_devices WHERE name = ?', [`${TAG}-AP1`])));
    await post('/red/equipos/nuevo', { kind: 'ap', name: `${TAG}-AP1`, mac: 'AABBCC001702', ip: '172.16.1.251', vlan_ids: v2.id });
    await post('/red/equipos/nuevo', { kind: 'celular', name: `${TAG}-FALSO` });
    check('Un celular no se crea desde Equipos (viene del módulo Celulares)', !(await row('SELECT id FROM network_devices WHERE name = ?', [`${TAG}-FALSO`])));
    const ap = await row('SELECT * FROM network_devices WHERE name = ?', [`${TAG}-AP1`]);
    await post(`/red/equipos/${ap.id}`, { kind: 'ap', name: `${TAG}-AP1`, mac: 'AA:BB:CC:00:17:02', ip: '172.16.1.252', location: 'Recepción', vlan_ids: [] });
    const ap2 = await row('SELECT * FROM network_devices WHERE id = ?', [ap.id]);
    check('Editar un equipo y quitarle las VLAN', ap2.ip === '172.16.1.252' && ap2.location === 'Recepción'
      && (await pool.query('SELECT vlan_id FROM network_device_vlans WHERE device_id = ?', [ap.id]))[0].length === 0);
    const lst = await get('/red/equipos');
    check('Listado de equipos: MAC, IP, VLAN y pestañas del módulo', lst.text.includes(`${TAG}-SW1`) && lst.text.includes('AA:BB:CC:00:17:01') && lst.text.includes(`3917 ${TAG} Administración`)
      && lst.text.includes('/red/celulares') && lst.text.includes('/red/vlan') && lst.text.includes('/red/herramientas'));
    check('Filtro por tipo y búsqueda por MAC', !(await get('/red/equipos?tipo=ap')).text.includes(`${TAG}-SW1`) && (await get('/red/equipos?tipo=ap')).text.includes(`${TAG}-AP1`)
      && (await get('/red/equipos?q=00:17:01')).text.includes(`${TAG}-SW1`) && !(await get('/red/equipos?q=00:17:01')).text.includes(`${TAG}-AP1`));
    check('La VLAN cuenta sus equipos', (await net.vlans()).find((x) => x.id === v1.id).devices_count === 1);

    // ---------------- PC desde GLPI ----------------
    await pool.query("INSERT INTO glpi_assets (asset_type, glpi_id, name, serial, manufacturer, model, location, ip, mac) VALUES ('computadoras', ?, ?, 'SER17', 'Lenovo', 'ThinkCentre', 'Surco', '172.16.5.17', ?)",
      [GLPI_ID, `${TAG}-pc1`, 'aa:bb:cc:00:17:10, AA:BB:CC:00:17:11']);
    await pool.query("INSERT INTO glpi_assets (asset_type, glpi_id, name, ip, mac) VALUES ('computadoras', ?, ?, '172.16.5.18', NULL)", [GLPI_ID + 1, `${TAG}-pc2`]);
    const imp = await post('/red/equipos/traer-pc');
    const pc1 = await row('SELECT * FROM network_devices WHERE name = ?', [`${TAG}-PC1`]);
    const pc2 = await row('SELECT * FROM network_devices WHERE name = ?', [`${TAG}-PC2`]);
    check('Traer PC de GLPI: nombre, las dos MAC, IP, serie y modelo', imp.location === '/red/equipos?tipo=pc' && pc1 && pc1.kind === 'pc' && pc1.mac === 'AA:BB:CC:00:17:10'
      && pc1.mac_wifi === 'AA:BB:CC:00:17:11' && pc1.ip === '172.16.5.17' && pc1.serial === 'SER17' && pc1.brand_model === 'Lenovo ThinkCentre' && pc1.source === 'glpi');
    check('Una PC que GLPI no inventarió entra sin MAC, para completarla a mano', pc2 && pc2.mac === null && pc2.ip === '172.16.5.18');
    await post(`/red/equipos/${pc2.id}`, { kind: 'pc', name: `${TAG}-PC2`, mac: 'AA:BB:CC:00:17:20', ip: '172.16.5.99', location: 'A mano' });
    await pool.query("UPDATE glpi_assets SET mac = 'AA:BB:CC:00:17:21', ip = '172.16.5.50' WHERE glpi_id = ?", [GLPI_ID + 1]);
    await post('/red/equipos/traer-pc');
    const pc2b = await row('SELECT * FROM network_devices WHERE id = ?', [pc2.id]);
    check('Traer de nuevo NO pisa lo escrito a mano ni duplica', pc2b.mac === 'AA:BB:CC:00:17:20' && pc2b.ip === '172.16.5.99' && pc2b.location === 'A mano'
      && (await row('SELECT COUNT(*) AS n FROM network_devices WHERE name LIKE ?', [`${TAG}-PC%`])).n === 2);

    // ---------------- celulares ----------------
    const [mob] = await pool.query("INSERT INTO mobile_devices (imei, asset_code, brand, model, area, sede, status) VALUES (?, 'ZZ-99917', 'Samsung', 'A15', 'ZZ-E2E', 'Surco', 'en_stock')", [IMEI]);
    const ph = await get('/red/celulares?q=ZZ-99917');
    check('Celulares: código, IMEI, marca y sede vienen del módulo Celulares', ph.text.includes('ZZ-99917') && ph.text.includes(IMEI) && ph.text.includes('Samsung A15') && ph.text.includes('Agregar MAC'));
    await post(`/red/celulares/${mob.insertId}`, { mac: 'aa:bb:cc:00:17:30', location: 'Recepción Surco', ip: '', notes: 'equipo de caja', vlan_ids: v2.id });
    const pd = await row('SELECT * FROM network_devices WHERE mobile_device_id = ?', [mob.insertId]);
    check('Agregar MAC, ubicación y VLAN a un celular', pd && pd.kind === 'celular' && pd.mac === 'AA:BB:CC:00:17:30' && pd.location === 'Recepción Surco' && pd.name === 'ZZ-99917');
    await post(`/red/celulares/${mob.insertId}`, { mac: 'AA:BB:CC:00:17:31', location: 'Cabina 2' });
    check('Editar los datos de red del celular no crea otra fila', (await row('SELECT COUNT(*) AS n, MAX(location) AS loc, MAX(mac) AS mac FROM network_devices WHERE mobile_device_id = ?', [mob.insertId])).n === 1
      && (await row('SELECT location FROM network_devices WHERE mobile_device_id = ?', [mob.insertId])).location === 'Cabina 2');
    const ph2 = await get('/red/celulares?q=cabina');
    check('El celular se encuentra por su ubicación y muestra su MAC', ph2.text.includes('AA:BB:CC:00:17:31') && ph2.text.includes('Cabina 2') && ph2.text.includes('ZZ-99917'));
    check('Los celulares no se mezclan en la lista de Equipos', !(await get('/red/equipos?q=ZZ-99917')).text.includes('AA:BB:CC:00:17:31'));
    await post(`/red/equipos/${pd.id}/eliminar`);
    check('Los datos de red de un celular no se borran desde Equipos', !!(await row('SELECT id FROM network_devices WHERE id = ?', [pd.id])));

    // ---------------- herramientas ----------------
    const tool = async (data) => { const r = await post('/red/herramientas/ejecutar', data); let j = {}; try { j = JSON.parse(r.text); } catch (_) { j = {}; } return { ...r, j }; };
    const pg = await tool({ tool: 'ping', host: '127.0.0.1' });
    check('Ping: responde con resumen y salida', pg.status === 200 && pg.j.ok === true && /Responde/.test(pg.j.summary) && /packets transmitted/.test(pg.j.output));
    const inj = await tool({ tool: 'ping', host: '127.0.0.1; cat /etc/passwd' });
    const inj2 = await tool({ tool: 'ping', host: '-c 1 127.0.0.1' });
    check('Un destino con caracteres de comando u opciones: rechazado sin ejecutar', inj.status === 400 && /no es válido/.test(inj.j.error) && inj2.status === 400 && !/root:/.test(inj.text));
    const dn = await tool({ tool: 'dns', host: 'localhost' });
    check('DNS: resuelve un nombre', dn.status === 200 && dn.j.ok === true && /127\.0\.0\.1|::1/.test(dn.j.output));
    const pout = await tool({ tool: 'puertos', host: '8.8.8.8', ports: '53' });
    const ploop = await tool({ tool: 'puertos', host: '127.0.0.1', ports: '3000' });
    check('Puertos: fuera de la red interna, rechazado', pout.status === 400 && /red interna/.test(pout.j.error) && ploop.status === 400);
    const dbHost = process.env.DB_HOST || 'db';
    const pdb = await tool({ tool: 'puertos', host: dbHost, ports: '3306,3307' });
    check('Puertos: en la red interna dice cuál está abierto y cuál no', pdb.status === 200 && pdb.j.rows.length === 2 && pdb.j.rows.find((x) => x.port === 3306).state === 'abierto'
      && pdb.j.rows.find((x) => x.port === 3307).state !== 'abierto' && /MySQL/.test(pdb.j.summary));
    const many = await tool({ tool: 'puertos', host: dbHost, ports: '1-1000' });
    check('Puertos: más del tope por consulta, rechazado', many.status === 400 && /máximo/.test(many.j.error));
    const tr = await tool({ tool: 'ruta', host: '127.0.0.1' });
    check('Ruta: devuelve saltos o avisa que falta la herramienta', tr.status === 200 && (Array.isArray(tr.j.hops)) && (tr.j.hops.length > 0 || /no está instalada|No se pudo/.test(tr.j.output + tr.j.summary)));
    check('Herramienta desconocida: rechazada', (await tool({ tool: 'netcat', host: '127.0.0.1' })).status === 400);
    const [aud] = await pool.query("SELECT action, target, detail FROM audit_log WHERE action = 'red_herramienta' AND user_id = ? ORDER BY id DESC LIMIT 8", [superadmin.id]);
    check('Cada prueba queda en la auditoría', aud.some((a) => a.target === '127.0.0.1' && /^ping/.test(a.detail)) && aud.some((a) => /^puertos \(2 puertos\)/.test(a.detail)));
    const tp = await get('/red/herramientas?host=172.16.1.20&h=puertos');
    check('Pantalla de herramientas: equipo precargado desde la lista', tp.status === 200 && tp.text.includes('value="172.16.1.20"') && tp.text.includes('desde el servidor de la aplicación'));

    // ---------------- roles ----------------
    as('editor');
    check('Un editor registra equipos pero no usa las herramientas', (await get('/red/herramientas')).status === 302 && (await tool({ tool: 'ping', host: '127.0.0.1' })).status === 302
      && (await get('/red/equipos/nuevo')).status === 200 && !(await get('/red/equipos')).text.includes('/red/herramientas'));
    as('lector');
    const before = (await row('SELECT COUNT(*) AS n FROM network_devices WHERE name LIKE ?', [`${TAG}%`])).n;
    await post('/red/equipos/nuevo', { kind: 'switch', name: `${TAG}-LECTOR` });
    await post(`/red/equipos/${sw.id}/eliminar`);
    await post('/red/vlan', { vlan_number: '3920', name: `${TAG} Lector` });
    await post(`/red/celulares/${mob.insertId}`, { mac: 'AA:BB:CC:00:17:40' });
    check('Un lector ve todo pero no cambia nada', (await get('/red/equipos')).status === 200 && (await get('/red/celulares')).status === 200 && (await get('/red/vlan')).status === 200
      && (await row('SELECT COUNT(*) AS n FROM network_devices WHERE name LIKE ?', [`${TAG}%`])).n === before && !(await row('SELECT id FROM network_vlans WHERE name = ?', [`${TAG} Lector`]))
      && (await row('SELECT mac FROM network_devices WHERE mobile_device_id = ?', [mob.insertId])).mac === 'AA:BB:CC:00:17:31'
      && !(await get('/red/equipos')).text.includes('Nuevo equipo') && !(await get('/red/vlan')).text.includes('id="vlan_form"'));
    await setAccess('lector', 0);
    check('Sin el módulo habilitado en Permisos, no se entra', (await get('/red/equipos')).status === 302 && (await get('/red/celulares')).status === 302);
    as('superadmin');

    // ---------------- borrar ----------------
    await post(`/red/vlan/${v1.id}/eliminar`);
    check('Eliminar una VLAN la quita de los equipos sin borrarlos', !(await row('SELECT id FROM network_vlans WHERE id = ?', [v1.id]))
      && (await pool.query('SELECT vlan_id FROM network_device_vlans WHERE device_id = ?', [sw.id]))[0].length === 1 && !!(await row('SELECT id FROM network_devices WHERE id = ?', [sw.id])));
    await post(`/red/equipos/${sw.id}/eliminar`);
    check('Eliminar un equipo', !(await row('SELECT id FROM network_devices WHERE id = ?', [sw.id])));
    await pool.query('DELETE FROM mobile_devices WHERE id = ?', [mob.insertId]);
    check('Al borrar el celular del inventario se van sus datos de red', !(await row('SELECT id FROM network_devices WHERE id = ?', [pd.id])));
  } finally {
    await restoreAccess();
    await cleanup();
    server.close();
    await pool.end();
  }
  results.forEach(([ok, name]) => console.log(`${ok ? 'PASA ' : 'FALLA'}  ${name}`));
  const bad = results.filter((r) => !r[0]).length;
  console.log(`\n${results.length - bad}/${results.length} pruebas correctas`);
  process.exit(bad ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
