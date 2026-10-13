// Prueba de Red > Switches y AP: ficha tecnica (marca, modelo, puertos, PoE,
// velocidad, piso, puertos de enlace, VLAN y protocolos de gestion) de los
// switches y puntos de acceso del inventario de red.
//
// Usa las rutas REALES con una sesion simulada. Crea datos marcados (ZZ-E2E)
// y los borra al final. Pide E2E_PERMITIR=1.
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/red_switches.e2e.js
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
  const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));
  const TAG = 'ZZ-E2E';
  const cleanup = async () => {
    await pool.query('DELETE FROM network_devices WHERE name LIKE ?', [`${TAG}%`]);
    await pool.query('DELETE FROM network_vlans WHERE name LIKE ?', [`${TAG}%`]);
    await pool.query("DELETE FROM audit_log WHERE action LIKE 'red\\_equipo\\_%' AND target LIKE ?", [`${TAG}%`]);
  };
  await cleanup();
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
  const CSRF = 'token-de-prueba-infra-0123456789abcdef0123456789abcdef';
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
  app.use('/red', require(path.join(ROOT, 'src/routes/network')));
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
  const full = (name) => row(`SELECT d.*, sp.brand, sp.model, sp.port_count, sp.poe, sp.speed, sp.floor, sp.uplink1, sp.uplink2, sp.protocols
    FROM network_devices d LEFT JOIN network_device_specs sp ON sp.device_id = d.id WHERE d.name = ?`, [name]);

  try {
    await pool.query('INSERT INTO network_vlans (vlan_number, name) VALUES (3921, ?), (3922, ?)', [`${TAG} Datos`, `${TAG} Voz`]);
    const vlans = await rows('SELECT id, vlan_number FROM network_vlans WHERE name LIKE ? ORDER BY vlan_number', [`${TAG}%`]);

    let page = await get('/red/infraestructura');
    check('La pestaña abre, aparece en el módulo Red y explica los protocolos', page.status === 200 && page.text.includes('href="/red/infraestructura"') && page.text.includes('Switches y AP')
      && page.text.includes('RESTCONF') && page.text.includes('gRPC Telemetry') && page.text.includes('Protocol Buffers') && page.text.includes('Zabbix, PRTG'));
    page = await get('/red/infraestructura/nuevo?tipo=ap');
    check('Formulario: todos los campos pedidos', ['name="brand"', 'name="model"', 'name="ip"', 'name="mac"', 'name="port_count"', 'name="poe"', 'name="speed"', 'name="sede"', 'name="floor"',
      'name="uplink1"', 'name="uplink2"', 'name="vlan_ids"', 'name="protocols"'].every((f) => page.text.includes(f)) && page.text.includes('<option value="ap" selected'));

    // ---------------- alta ----------------
    const sw = { kind: 'switch', name: `${TAG} SW-Sistemas`, brand: 'TP-Link', model: 'SG2008 v4.20', ip: '192.168.100.94', mac: '30-de-4b-00-e2-41', serial: 'SN-1', port_count: '8', poe: 'poe_plus', speed: 'gigabit',
      sede: 'Pueblo Libre', floor: '2', area: 'Sistemas', location: 'Rack A', uplink1: 'Puerto 8 → Router puerto 2', uplink2: 'Puerto 7 → SW-Clinica puerto 1', vlan_ids: vlans.map((v) => v.id),
      protocols: ['rest', 'snmp'], notes: 'principal' };
    const r1 = await post('/red/infraestructura/nuevo', sw);
    let d = await full(sw.name);
    check('Alta de un switch con toda su ficha', r1.location === '/red/infraestructura' && d && d.kind === 'switch' && d.brand === 'TP-Link' && d.model === 'SG2008 v4.20' && d.port_count === 8 && d.poe === 'poe_plus'
      && d.speed === 'gigabit' && d.floor === '2' && d.uplink1 === 'Puerto 8 → Router puerto 2' && d.uplink2 === 'Puerto 7 → SW-Clinica puerto 1' && d.protocols === 'rest,snmp');
    check('Los datos comunes quedan en el inventario de Red: MAC normalizada, IP, sede y marca / modelo', d.mac === '30:DE:4B:00:E2:41' && d.ip === '192.168.100.94' && d.sede === 'Pueblo Libre'
      && d.brand_model === 'TP-Link SG2008 v4.20' && d.source === 'manual' && (await rows('SELECT vlan_id FROM network_device_vlans WHERE device_id = ?', [d.id])).length === 2);
    await post('/red/infraestructura/nuevo', { kind: 'ap', name: `${TAG} AP1-Counter`, brand: 'TP-Link', model: 'EAP620 HD', ip: '192.168.100.44', mac: '3C:78:95:00:E2:42', port_count: '1', poe: 'poe', speed: 'multigig',
      sede: 'Surco', floor: '1', uplink1: 'Puerto 1 → SW-Sistemas puerto 3', vlan_ids: [vlans[0].id], protocols: 'grpc' });
    const ap = await full(`${TAG} AP1-Counter`);
    check('Alta de un punto de acceso', ap && ap.kind === 'ap' && ap.poe === 'poe' && ap.speed === 'multigig' && ap.uplink2 === null && ap.protocols === 'grpc');

    // ---------------- listado ----------------
    page = await get('/red/infraestructura');
    check('Listado: marca, modelo, puertos, PoE, velocidad, piso, enlaces, VLAN y protocolos', page.text.includes(sw.name) && page.text.includes('SG2008 v4.20') && page.text.includes('PoE+ (802.3at)') && page.text.includes('Gigabit')
      && page.text.includes('Puerto 7 → SW-Clinica puerto 1') && page.text.includes('3921, 3922') && page.text.includes('>SNMP</span>') && page.text.includes('30:DE:4B:00:E2:41'));
    check('Filtros por tipo, por sede y búsqueda', !(await get('/red/infraestructura?tipo=ap')).text.includes(sw.name) && (await get('/red/infraestructura?tipo=ap')).text.includes(`${TAG} AP1-Counter`)
      && !(await get('/red/infraestructura?sede=Surco')).text.includes(sw.name) && (await get('/red/infraestructura?q=EAP620')).text.includes(`${TAG} AP1-Counter`)
      && !(await get('/red/infraestructura?q=EAP620')).text.includes(sw.name));
    check('Los mismos equipos siguen en la pestaña Equipos, y editar desde ahí lleva a la ficha', (await get('/red/equipos?tipo=switch')).text.includes(sw.name)
      && (await get(`/red/equipos/${d.id}`)).location === `/red/infraestructura/${d.id}`);

    // ---------------- edición ----------------
    page = await get(`/red/infraestructura/${d.id}`);
    check('Editar: la ficha vuelve con lo guardado', page.text.includes('value="SG2008 v4.20"') && page.text.includes('<option value="poe_plus" selected') && page.text.includes('id="proto_snmp" checked')
      && !page.text.includes('id="proto_grpc" checked') && new RegExp(`id="vl_${vlans[1].id}"[^>]*checked`).test(page.text.replace(/[ \t\r\n]+/g, ' ')));
    await post(`/red/infraestructura/${d.id}`, { ...sw, port_count: '24', poe: 'no', uplink2: '', protocols: ['restconf'], vlan_ids: [vlans[1].id], floor: 'Sótano' });
    d = await full(sw.name);
    check('Editar: cambia puertos, PoE, enlaces, protocolos y VLAN', d.port_count === 24 && d.poe === 'no' && d.uplink2 === null && d.protocols === 'restconf' && d.floor === 'Sótano'
      && (await rows('SELECT vlan_id FROM network_device_vlans WHERE device_id = ?', [d.id])).map((x) => x.vlan_id).join() === String(vlans[1].id));
    await post(`/red/infraestructura/${d.id}`, { kind: 'switch', name: sw.name });
    d = await full(sw.name);
    check('Todos los campos de la ficha son opcionales', d.brand === null && d.port_count === null && d.poe === null && d.protocols === null && d.brand_model === null);

    // ---------------- validaciones ----------------
    const rejected = async (extra, text) => { await post('/red/infraestructura/nuevo', { kind: 'switch', name: `${TAG} Malo`, ...extra }); const p = await get('/red/infraestructura'); return p.text.includes(text) && !(await full(`${TAG} Malo`)); };
    check('Puertos fuera de rango o no numéricos: rechazados', await rejected({ port_count: '0' }, 'entre 1 y 1024') && await rejected({ port_count: '5000' }, 'entre 1 y 1024') && await rejected({ port_count: 'ocho' }, 'entre 1 y 1024'));
    check('MAC o IP inválidas y MAC repetida: rechazadas', await rejected({ mac: 'AA:BB' }, '12 dígitos') && await rejected({ ip: '300.1.1.1' }, 'IP') && await rejected({ mac: '3C:78:95:00:E2:42' }, 'ya está registrada'));
    check('Solo switch o punto de acceso', await rejected({ kind: 'pc' }, 'switch o un punto de acceso') && await rejected({ kind: 'celular' }, 'switch o un punto de acceso'));
    await post('/red/infraestructura/nuevo', { kind: 'switch', name: `${TAG} Raro`, poe: 'inventado', speed: '<script>', protocols: ['snmp', 'telnet', 'snmp'] });
    const odd = await full(`${TAG} Raro`);
    check('Valores que no están en las listas se descartan', odd && odd.poe === null && odd.speed === null && odd.protocols === 'snmp');
    await pool.query('INSERT INTO network_devices SET ?', [{ kind: 'pc', name: `${TAG} PC`, source: 'manual' }]);
    const pc = await full(`${TAG} PC`);
    await post(`/red/infraestructura/${pc.id}`, { kind: 'switch', name: `${TAG} PC`, port_count: '8' });
    check('Una PC no se puede editar como switch', (await full(`${TAG} PC`)).kind === 'pc' && (await get(`/red/infraestructura/${pc.id}`)).location === '/red/infraestructura'
      && (await get(`/red/equipos/${pc.id}`)).status === 200);

    // ---------------- equipos que vienen de otra parte ----------------
    await pool.query('INSERT INTO network_devices SET ?', [{ kind: 'ap', name: `${TAG} AP-Omada`, mac: '3C:78:95:00:E2:43', mac_wifi: null, brand_model: 'EAP620 HD(US) v3.0', source: 'omada' }]);
    const om = await full(`${TAG} AP-Omada`);
    page = await get(`/red/infraestructura/${om.id}`);
    check('Un AP registrado desde Omada aparece y propone su modelo', (await get('/red/infraestructura')).text.includes(`${TAG} AP-Omada`) && page.text.includes('value="EAP620 HD(US) v3.0"'));
    await post(`/red/infraestructura/${om.id}`, { kind: 'ap', name: `${TAG} AP-Omada`, mac: '3C:78:95:00:E2:43', brand: 'TP-Link', model: 'EAP620 HD(US) v3.0', floor: '3' });
    check('Al completarlo conserva su origen', (await full(`${TAG} AP-Omada`)).source === 'omada' && (await full(`${TAG} AP-Omada`)).floor === '3');

    // ---------------- roles ----------------
    as('lector');
    page = await get('/red/infraestructura');
    check('Lector: ve el listado, sin botones de escritura', page.status === 200 && page.text.includes(sw.name) && !page.text.includes('/red/infraestructura/nuevo') && !page.text.includes('/eliminar'));
    await post('/red/infraestructura/nuevo', { kind: 'switch', name: `${TAG} Lector` });
    await post(`/red/infraestructura/${d.id}/eliminar`);
    check('Lector: no crea, edita ni elimina', !(await full(`${TAG} Lector`)) && !!(await full(sw.name)) && (await get(`/red/infraestructura/${d.id}`)).status !== 200);
    as('editor');
    await post('/red/infraestructura/nuevo', { kind: 'switch', name: `${TAG} Editor`, port_count: '16' });
    check('Editor: puede registrar', (await full(`${TAG} Editor`)).port_count === 16);
    as('superadmin');
    const noCsrf = await fetch(`${base}/red/infraestructura/${d.id}/eliminar`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
    check('Sin token CSRF: no elimina', noCsrf.status === 302 && !!(await full(sw.name)));

    // ---------------- eliminar ----------------
    await post(`/red/infraestructura/${d.id}/eliminar`);
    check('Eliminar quita el equipo y su ficha, y queda en la auditoría', !(await full(sw.name)) && !(await row('SELECT device_id FROM network_device_specs WHERE device_id = ?', [d.id]))
      && !!(await row("SELECT id FROM audit_log WHERE action = 'red_equipo_eliminado' AND target = ?", [sw.name]))
      && !!(await row("SELECT id FROM audit_log WHERE action = 'red_equipo_creado' AND target = ? AND detail LIKE '%ficha técnica%'", [sw.name])));
    check('Unidades: listas de PoE, velocidad y los cuatro protocolos', Object.keys(net.POE).join() === 'no,poe,poe_plus,poe_pp,pasivo' && !!net.SPEEDS.gigabit && Object.keys(net.PROTOCOLS).join() === 'rest,restconf,snmp,grpc');
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
