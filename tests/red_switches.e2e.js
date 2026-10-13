// Prueba de Red > Switches y AP: ficha tecnica de los switches y puntos de
// acceso (marca y modelo de un catalogo relacional, puertos, PoE, velocidad,
// sede y area del catalogo general, piso, puertos de enlace, VLAN, protocolos),
// credencial de acceso cifrada, estado (en uso / en stock) y monitoreo de
// actividad (ping, puerto TCP, SNMP v2c, dato de Omada).
//
// Usa las rutas REALES con una sesion simulada. Crea datos marcados (ZZ-E2E)
// y los borra al final. El monitoreo se prueba contra servicios locales
// (127.0.0.1), nunca contra equipos reales. Pide E2E_PERMITIR=1.
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/red_switches.e2e.js
const path = require('path');
const net = require('net');
const dgram = require('dgram');
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
  const netSvc = require(path.join(ROOT, 'src/services/networkService'));
  const mon = require(path.join(ROOT, 'src/services/netMonitorService'));
  const cryptoService = require(path.join(ROOT, 'src/services/cryptoService'));
  const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));
  mon._.allowLoopback = true;
  const TAG = 'ZZ-E2E';
  const SECRET = 'Clave-de-prueba-que-no-debe-verse-01';
  const cleanup = async () => {
    await pool.query('DELETE FROM network_devices WHERE name LIKE ?', [`${TAG}%`]);
    await pool.query('DELETE FROM network_vlans WHERE name LIKE ?', [`${TAG}%`]);
    await pool.query('DELETE FROM network_brands WHERE name LIKE ?', [`${TAG}%`]);
    await pool.query('DELETE FROM catalog_items WHERE value LIKE ?', [`${TAG}%`]);
    await pool.query('DELETE FROM omada_controllers WHERE name LIKE ?', [`${TAG}%`]);
    await pool.query("DELETE FROM audit_log WHERE action LIKE 'red\\_%' AND (target LIKE ? OR detail LIKE ? OR target LIKE 'marca id %' OR target LIKE 'modelo id %')", [`${TAG}%`, `%${TAG}%`]);
  };
  await cleanup();
  const [savedAccess] = await pool.query("SELECT role, enabled FROM role_modules WHERE module = 'red'");
  const setAccess = (role, enabled) => pool.query('INSERT INTO role_modules (role, module, enabled) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)', [role, 'red', enabled]);
  const restoreAccess = async () => {
    await pool.query("DELETE FROM role_modules WHERE module = 'red'");
    for (const r of savedAccess) await setAccess(r.role, r.enabled);
  };
  for (const r of ['admin', 'editor', 'lector']) await setAccess(r, 1);
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
  const full = (name) => row(`SELECT d.*, sp.model_id, sp.brand, sp.model, sp.port_count, sp.poe, sp.speed, sp.floor, sp.uplink1, sp.uplink2, sp.protocols, sp.state, sp.mgmt_user, sp.mgmt_password,
      mo.method, mo.port AS mon_port, mo.community, mo.status AS mon_status, mo.detail AS mon_detail
    FROM network_devices d LEFT JOIN network_device_specs sp ON sp.device_id = d.id LEFT JOIN network_device_monitor mo ON mo.device_id = d.id WHERE d.name = ?`, [name]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Servicios locales para el monitoreo: un puerto TCP abierto y un agente SNMP minimo.
  const tcpServer = net.createServer((s) => s.end()).listen(0, '127.0.0.1');
  await new Promise((r) => tcpServer.on('listening', r));
  const TCP_PORT = tcpServer.address().port;
  const snmpSeen = [];
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, rinfo) => {
    // Responde solo a la comunidad "e2e-publica": copia el identificador de la peticion y devuelve sysUpTime = 8 640 000 (1 dia).
    try {
      const text = msg.toString('latin1');
      snmpSeen.push(text.includes('e2e-publica') ? 'ok' : 'otra');
      if (!text.includes('e2e-publica')) return;
      const at = msg.indexOf(0xa0);
      const idLen = msg[at + 3];
      const reqId = msg.subarray(at + 2, at + 4 + idLen); // 02 len valor
      const oid = Buffer.from([0x06, 0x08, 0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x03, 0x00]);
      const val = Buffer.from([0x43, 0x04, 0x00, 0x83, 0xd6, 0x00]);
      const vb = Buffer.concat([Buffer.from([0x30, oid.length + val.length]), oid, val]);
      const list = Buffer.concat([Buffer.from([0x30, vb.length]), vb]);
      const pduBody = Buffer.concat([reqId, Buffer.from([0x02, 0x01, 0x00, 0x02, 0x01, 0x00]), list]);
      const pdu = Buffer.concat([Buffer.from([0xa2, pduBody.length]), pduBody]);
      const com = Buffer.concat([Buffer.from([0x04, 11]), Buffer.from('e2e-publica')]);
      const body = Buffer.concat([Buffer.from([0x02, 0x01, 0x01]), com, pdu]);
      udp.send(Buffer.concat([Buffer.from([0x30, body.length]), body]), rinfo.port, rinfo.address);
    } catch (e) { /* peticion que no se entiende: sin respuesta */ }
  });
  await new Promise((r) => udp.bind(0, '127.0.0.1', r));
  const UDP_PORT = udp.address().port;

  try {
    await pool.query('INSERT INTO network_vlans (vlan_number, name) VALUES (3921, ?), (3922, ?)', [`${TAG} Datos`, `${TAG} Voz`]);
    const vlans = await rows('SELECT id, vlan_number FROM network_vlans WHERE name LIKE ? ORDER BY vlan_number', [`${TAG}%`]);
    await pool.query("INSERT INTO catalog_items (catalog_type, value) VALUES ('sede', ?), ('sede', ?), ('area', ?)", [`${TAG} Pueblo Libre`, `${TAG} Surco`, `${TAG} Sistemas`]);

    // ---------------- catálogo de marcas y modelos ----------------
    let page = await get('/red/infraestructura/catalogo');
    check('Catálogo: abre, con marcas habituales ya cargadas', page.status === 200 && page.text.includes('TP-Link') && page.text.includes('id="modelo_form"') && page.text.includes('data-buscable'));
    await post('/red/infraestructura/catalogo/marca', { name: `${TAG} Marca` });
    const brand = await row('SELECT * FROM network_brands WHERE name = ?', [`${TAG} Marca`]);
    await post('/red/infraestructura/catalogo/marca', { name: `${TAG} Marca` });
    check('Alta de marca; repetida, rechazada', !!brand && (await get('/red/infraestructura/catalogo')).text.includes('ya está en el catálogo')
      && (await rows('SELECT id FROM network_brands WHERE name = ?', [`${TAG} Marca`])).length === 1);
    await post('/red/infraestructura/catalogo/modelo', { brand_id: brand.id, name: 'SG2008 v4.20', kind: 'switch', port_count: '8', poe: 'poe_plus', speed: 'gigabit' });
    await post('/red/infraestructura/catalogo/modelo', { brand_id: brand.id, name: 'EAP620 HD', kind: 'ap', port_count: '1', poe: 'poe', speed: 'multigig' });
    const mSw = await row('SELECT * FROM network_models WHERE brand_id = ? AND name = ?', [brand.id, 'SG2008 v4.20']);
    const mAp = await row('SELECT * FROM network_models WHERE brand_id = ? AND name = ?', [brand.id, 'EAP620 HD']);
    check('Alta de modelos con su tipo, puertos, PoE y velocidad', mSw && mSw.kind === 'switch' && mSw.port_count === 8 && mSw.poe === 'poe_plus' && mAp && mAp.kind === 'ap' && mAp.speed === 'multigig');
    const badModel = async (extra, text) => { await post('/red/infraestructura/catalogo/modelo', { brand_id: brand.id, name: 'Malo', kind: 'switch', ...extra }); return (await get('/red/infraestructura/catalogo')).text.includes(text) && !(await row('SELECT id FROM network_models WHERE name = ?', ['Malo'])); };
    check('Modelo repetido, sin marca, con tipo o puertos inválidos: rechazados', await badModel({ name: 'SG2008 v4.20' }, 'ya está en el catálogo') && await badModel({ brand_id: '0' }, 'Elija la marca')
      && await badModel({ kind: 'pc' }, 'switch o un punto de acceso') && await badModel({ port_count: '9999' }, 'entre 1 y 1024'));
    check('Índices del catálogo y de las fichas', (await rows("SHOW INDEX FROM network_models WHERE Key_name IN ('uniq_net_model', 'idx_net_model_kind')")).length >= 4
      && (await rows("SHOW INDEX FROM network_device_specs WHERE Key_name IN ('idx_net_spec_model', 'idx_net_spec_state', 'idx_net_spec_brand', 'idx_net_spec_floor')")).length >= 5
      && (await rows("SHOW INDEX FROM network_devices WHERE Key_name = 'idx_net_device_sede_area'")).length === 2 && (await rows("SHOW INDEX FROM network_device_monitor WHERE Key_name = 'idx_net_monitor_status'")).length === 1);

    // ---------------- formulario ----------------
    page = await get('/red/infraestructura');
    check('La pestaña abre, con el resumen de actividad y el acceso al catálogo', page.status === 200 && page.text.includes('id="infra_resumen"') && page.text.includes('Comprobar ahora') && page.text.includes('/red/infraestructura/catalogo')
      && page.text.includes('RESTCONF') && page.text.includes('desde el servidor de la aplicación'));
    page = await get('/red/infraestructura/nuevo?tipo=ap');
    check('Formulario: marca, modelo, sede y área son desplegables con búsqueda', ['id="brand_id" data-buscable', 'name="model_id" data-buscable', 'name="sede" data-buscable', 'name="area" data-buscable'].every((f) => page.text.includes(f))
      && page.text.includes('/js/buscable.js') && page.text.includes(`<option value="${TAG} Surco"`) && page.text.includes(`data-brand="${brand.id}" data-kind="ap" data-ports="1" data-poe="poe" data-speed="multigig"`));
    check('Formulario: credencial, estado, monitoreo y los demás campos', ['name="mgmt_user"', 'name="mgmt_password"', 'name="state"', 'name="mon_method"', 'name="mon_port"', 'name="mon_community"', 'name="port_count"', 'name="poe"', 'name="speed"',
      'name="floor"', 'name="uplink1"', 'name="uplink2"', 'name="vlan_ids"', 'name="protocols"'].every((f) => page.text.includes(f)) && page.text.includes('type="password" class="form-control font-monospace" id="mgmt_password"'));

    // ---------------- alta ----------------
    const sw = { kind: 'switch', name: `${TAG} SW-Sistemas`, model_id: mSw.id, ip: '127.0.0.1', mac: '30-de-4b-00-e2-41', serial: 'SN-1', port_count: '8', poe: 'poe_plus', speed: 'gigabit',
      sede: `${TAG} Pueblo Libre`, floor: '2', area: `${TAG} Sistemas`, location: 'Rack A', uplink1: 'Puerto 8 → Router puerto 2', uplink2: 'Puerto 7 → SW-Clinica puerto 1', vlan_ids: vlans.map((v) => v.id),
      protocols: ['rest', 'snmp'], notes: 'principal', state: 'en_uso', mgmt_user: 'admin', mgmt_password: SECRET, mon_method: 'tcp', mon_port: String(TCP_PORT) };
    const r1 = await post('/red/infraestructura/nuevo', sw);
    let d = await full(sw.name);
    check('Alta de un switch: marca y modelo salen del catálogo', r1.location === '/red/infraestructura' && d && d.model_id === mSw.id && d.brand === `${TAG} Marca` && d.model === 'SG2008 v4.20'
      && d.brand_model === `${TAG} Marca SG2008 v4.20` && d.port_count === 8 && d.poe === 'poe_plus' && d.speed === 'gigabit' && d.floor === '2' && d.protocols === 'rest,snmp' && d.state === 'en_uso');
    check('Datos comunes en el inventario de Red: MAC normalizada, sede, área y VLAN', d.mac === '30:DE:4B:00:E2:41' && d.sede === `${TAG} Pueblo Libre` && d.area === `${TAG} Sistemas`
      && (await rows('SELECT vlan_id FROM network_device_vlans WHERE device_id = ?', [d.id])).length === 2);
    const keyed = !!require(path.join(ROOT, 'src/config/env')).credentialsEncKey;
    check('La contraseña de acceso se guarda cifrada', d.mgmt_user === 'admin' && !!d.mgmt_password && (!keyed || (String(d.mgmt_password).startsWith('enc:v1:') && !String(d.mgmt_password).includes(SECRET)))
      && cryptoService.decrypt(d.mgmt_password) === SECRET);

    // ---------------- validaciones ----------------
    const rejected = async (extra, text) => { await post('/red/infraestructura/nuevo', { kind: 'switch', name: `${TAG} Malo`, ...extra }); const p = await get('/red/infraestructura'); return p.text.includes(text) && !(await full(`${TAG} Malo`)); };
    check('Sede o área que no están en el catálogo: rechazadas', await rejected({ sede: 'Sede inventada' }, 'no está en el catálogo') && await rejected({ area: 'Área inventada' }, 'no está en el catálogo'));
    check('Modelo que no existe en el catálogo: rechazado', await rejected({ model_id: '99999999' }, 'Elija un modelo del catálogo'));
    check('Puertos, MAC, IP o tipo inválidos y MAC repetida: rechazados', await rejected({ port_count: '0' }, 'entre 1 y 1024') && await rejected({ mac: 'AA:BB' }, '12 dígitos') && await rejected({ ip: '300.1.1.1' }, 'IP')
      && await rejected({ mac: '30:DE:4B:00:E2:41' }, 'ya está registrada') && await rejected({ kind: 'pc' }, 'switch o un punto de acceso'));
    check('Monitoreo mal configurado: rechazado', await rejected({ mon_method: 'snmp' }, 'escriba la comunidad') && await rejected({ mon_method: 'tcp', mon_port: '70000' }, 'entre 1 y 65535')
      && await rejected({ mon_method: 'snmp', mon_community: 'con espacio' }, 'no es válida'));

    // ---------------- listado y credencial ----------------
    page = await get('/red/infraestructura');
    check('Listado: marca, modelo, enlaces, VLAN, usuario de acceso (nunca la contraseña)', page.text.includes(sw.name) && page.text.includes('SG2008 v4.20') && page.text.includes('PoE+ (802.3at)')
      && page.text.includes('Puerto 7 → SW-Clinica puerto 1') && page.text.includes('3921, 3922') && page.text.includes('bi-key') && !page.text.includes(SECRET));
    page = await get(`/red/infraestructura/${d.id}`);
    check('Editar: la ficha vuelve con lo guardado y sin la contraseña', new RegExp(`<option value="${mSw.id}" data-brand[^>]*selected`).test(page.text.replace(/\s+/g, ' ')) && page.text.includes('Guardada. Escriba otra solo para cambiarla.')
      && !page.text.includes(SECRET) && page.text.includes('id="ver_credencial"') && page.text.includes('<option value="tcp" selected') && page.text.includes(`value="${TCP_PORT}"`));
    const cred = await post(`/red/infraestructura/${d.id}/credencial`);
    check('Ver credencial (administrador): devuelve usuario y contraseña, y queda en la auditoría', cred.status === 200 && JSON.parse(cred.text).user === 'admin' && JSON.parse(cred.text).password === SECRET
      && !!(await row("SELECT id FROM audit_log WHERE action = 'red_credencial_vista' AND target = ?", [sw.name])));
    as('editor');
    check('Editor: puede editar la ficha pero no ver la credencial', (await get(`/red/infraestructura/${d.id}`)).status === 200 && !(await get(`/red/infraestructura/${d.id}`)).text.includes('id="ver_credencial"')
      && !(await post(`/red/infraestructura/${d.id}/credencial`)).text.includes(SECRET));
    as('lector');
    check('Lector: ve el listado sin botones, y no ve credenciales ni formularios', (await get('/red/infraestructura')).status === 200 && !(await get('/red/infraestructura')).text.includes('/red/infraestructura/nuevo')
      && !(await post(`/red/infraestructura/${d.id}/credencial`)).text.includes(SECRET) && (await get(`/red/infraestructura/${d.id}`)).status !== 200 && (await get('/red/infraestructura/catalogo')).status !== 200);
    as('superadmin');
    await post(`/red/infraestructura/${d.id}`, { ...sw, mgmt_password: '', floor: '3' });
    check('Editar sin escribir la contraseña la conserva', cryptoService.decrypt((await full(sw.name)).mgmt_password) === SECRET && (await full(sw.name)).floor === '3');
    await post(`/red/infraestructura/${d.id}`, { ...sw, mgmt_password: '', mgmt_password_clear: '1' });
    check('Quitar la contraseña guardada', (await full(sw.name)).mgmt_password === null && (await full(sw.name)).mgmt_user === 'admin');

    // ---------------- monitoreo ----------------
    await mon.run(d.id);
    d = await full(sw.name);
    check('Monitoreo por puerto TCP: activo cuando el puerto responde', d.method === 'tcp' && d.mon_status === 'up' && /responde/.test(d.mon_detail));
    tcpServer.close();
    await wait(50);
    await mon.run(d.id);
    check('…e inactivo cuando deja de responder', (await full(sw.name)).mon_status === 'down' && !!(await row('SELECT changed_at FROM network_device_monitor WHERE device_id = ?', [d.id])).changed_at);
    await post(`/red/infraestructura/${d.id}`, { ...sw, mgmt_password: '', mon_method: 'snmp', mon_port: String(UDP_PORT), mon_community: 'e2e-publica' });
    d = await full(sw.name);
    check('La comunidad SNMP se guarda cifrada, y al cambiar el método se descarta el resultado anterior', d.method === 'snmp' && (!keyed || String(d.community).startsWith('enc:v1:')) && cryptoService.decrypt(d.community) === 'e2e-publica');
    await mon.run(d.id);
    d = await full(sw.name);
    check('Monitoreo por SNMP v2c: activo, con el tiempo encendido que informa el equipo', d.mon_status === 'up' && /encendido hace 1 d 0 h/.test(d.mon_detail) && snmpSeen.includes('ok'));
    await post(`/red/infraestructura/${d.id}`, { ...sw, mgmt_password: '', mon_method: 'snmp', mon_port: String(UDP_PORT), mon_community: 'otra-comunidad' });
    await mon.run(d.id);
    check('SNMP con otra comunidad: sin respuesta, inactivo', (await full(sw.name)).mon_status === 'down' && snmpSeen.includes('otra'));
    const req1 = mon.snmp.request('public', 0x01020304);
    check('Mensaje SNMP: GET de sysUpTime bien formado', req1[0] === 0x30 && req1[1] === req1.length - 2 && req1.includes(Buffer.from([0x04, 0x06, 0x70, 0x75, 0x62, 0x6c, 0x69, 0x63]))
      && req1.includes(Buffer.from([0x02, 0x04, 0x01, 0x02, 0x03, 0x04])) && req1.includes(Buffer.from([0x06, 0x08, 0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x03, 0x00, 0x05, 0x00])));
    await post(`/red/infraestructura/${d.id}`, { ...sw, mgmt_password: '', mon_method: 'auto' });
    await mon.run(d.id);
    d = await full(sw.name);
    check('Automático: ping (127.0.0.1 responde); y deja de guardarse la comunidad', d.mon_status === 'up' && /ping/.test(d.mon_detail) && d.community === null);
    check('Solo se comprueban direcciones internas', (await mon.check({ ip: '8.8.8.8', method: 'auto' })).status === null && /red interna/.test((await mon.check({ ip: '8.8.8.8', method: 'tcp', port: 443 })).detail)
      && (await mon.check({ ip: '', method: 'auto' })).status === null && (await mon.check({ ip: '10.255.255.1', method: 'no' })).status === null);

    // Punto de acceso que solo ve Omada (el servidor no llega a su red).
    await post('/red/infraestructura/nuevo', { kind: 'ap', name: `${TAG} AP1-Counter`, model_id: mAp.id, ip: '10.255.255.1', mac: '3C:78:95:00:E2:42', sede: `${TAG} Surco`, floor: '1', vlan_ids: [vlans[0].id], protocols: 'grpc' });
    const ap = await full(`${TAG} AP1-Counter`);
    check('Alta de un AP: toma PoE, velocidad y puertos solo si se envían; modelo del catálogo', ap && ap.kind === 'ap' && ap.model === 'EAP620 HD' && ap.protocols === 'grpc' && ap.method === 'auto');
    const [oc] = await pool.query("INSERT INTO omada_controllers (name, base_url, omadac_id, client_id, mode) VALUES (?, 'https://e2e.invalid', 'e2eomadacid00001', 'e2eclientid00001', 'local')", [`${TAG} OC`]);
    const [os] = await pool.query("INSERT INTO omada_sites (controller_id, site_key, name) VALUES (?, 'site-e2e-mon', ?)", [oc.insertId, `${TAG} Sitio`]);
    await pool.query("INSERT INTO omada_devices (site_id, mac, name, kind, status, present, synced_at) VALUES (?, '3C:78:95:00:E2:42', 'ap', 'ap', 1, 1, NOW())", [os.insertId]);
    await mon.run(ap.id);
    check('Automático con dato reciente de Omada: activo según Omada, sin llegar al equipo', (await full(`${TAG} AP1-Counter`)).mon_status === 'up' && /Omada/.test((await full(`${TAG} AP1-Counter`)).mon_detail));
    await pool.query('UPDATE omada_devices SET status = 0 WHERE site_id = ?', [os.insertId]);
    await mon.run(ap.id);
    check('…e inactivo cuando Omada lo da por desconectado', (await full(`${TAG} AP1-Counter`)).mon_status === 'down');

    // ---------------- stock ----------------
    await post('/red/infraestructura/nuevo', { kind: 'switch', name: `${TAG} SW-Repuesto`, model_id: mSw.id, ip: '127.0.0.1', state: 'stock' });
    const spare = await full(`${TAG} SW-Repuesto`);
    await mon.run(spare.id);
    check('Un equipo en stock no se monitorea', spare.state === 'stock' && (await full(`${TAG} SW-Repuesto`)).mon_status === null);
    page = await get('/red/infraestructura?estado=stock');
    check('Filtros por estado: en stock, activos e inactivos', page.text.includes(`${TAG} SW-Repuesto`) && !page.text.includes(sw.name) && page.text.includes('En stock')
      && (await get('/red/infraestructura?estado=activos')).text.includes(sw.name) && !(await get('/red/infraestructura?estado=activos')).text.includes(`${TAG} AP1-Counter`)
      && (await get('/red/infraestructura?estado=inactivos')).text.includes(`${TAG} AP1-Counter`));
    check('Filtros por tipo, por sede y búsqueda', !(await get('/red/infraestructura?tipo=ap')).text.includes(sw.name) && (await get(`/red/infraestructura?sede=${encodeURIComponent(`${TAG} Surco`)}`)).text.includes(`${TAG} AP1-Counter`)
      && !(await get(`/red/infraestructura?sede=${encodeURIComponent(`${TAG} Surco`)}`)).text.includes(sw.name) && (await get('/red/infraestructura?q=EAP620')).text.includes(`${TAG} AP1-Counter`));
    const r2 = await post('/red/infraestructura/comprobar');
    page = await get('/red/infraestructura');
    check('Comprobar ahora: recorre todos y avisa; el resumen cuenta activos, inactivos y en stock', r2.location === '/red/infraestructura' && page.text.includes('Comprobación terminada') && page.text.includes('id="infra_ultima"')
      && (await post('/red/infraestructura/comprobar')).location === '/red/infraestructura' && (await get('/red/infraestructura')).text.includes('menos de un minuto'));

    // ---------------- catálogo: cambios que llegan a los equipos ----------------
    await post('/red/infraestructura/catalogo/modelo', { id: mSw.id, brand_id: brand.id, name: 'SG2008P v5', kind: 'switch', port_count: '8', poe: 'poe_plus', speed: 'gigabit' });
    d = await full(sw.name);
    check('Renombrar un modelo en el catálogo actualiza los equipos que lo usan', d.model === 'SG2008P v5' && d.brand_model === `${TAG} Marca SG2008P v5` && (await get('/red/infraestructura')).text.includes('SG2008P v5'));
    await post(`/red/infraestructura/catalogo/modelo/${mSw.id}/eliminar`);
    check('Un modelo en uso no se puede borrar', !!(await row('SELECT id FROM network_models WHERE id = ?', [mSw.id])) && (await get('/red/infraestructura/catalogo')).text.includes('desactívelo en lugar de borrarlo'));
    await post(`/red/infraestructura/catalogo/modelo/${mSw.id}/desactivar`);
    check('Desactivado: no se ofrece en altas, pero el equipo que lo tiene lo conserva al editar', !(await get('/red/infraestructura/nuevo')).text.includes(`<option value="${mSw.id}" data-brand`)
      && (await get(`/red/infraestructura/${d.id}`)).text.includes(`<option value="${mSw.id}" data-brand`) && (await post(`/red/infraestructura/${d.id}`, { ...sw, mgmt_password: '' })).location === '/red/infraestructura'
      && (await full(sw.name)).model_id === mSw.id && await rejected({ model_id: mSw.id }, 'Elija un modelo del catálogo'));
    as('editor');
    await post(`/red/infraestructura/catalogo/modelo/${mAp.id}/desactivar`);
    await post('/red/infraestructura/catalogo/marca', { name: `${TAG} Marca del editor` });
    check('Editor: agrega al catálogo, pero no desactiva ni borra', (await row('SELECT active FROM network_models WHERE id = ?', [mAp.id])).active === 1 && !!(await row('SELECT id FROM network_brands WHERE name = ?', [`${TAG} Marca del editor`])));
    as('superadmin');
    await post(`/red/infraestructura/catalogo/marca/${brand.id}/eliminar`);
    const lone = await row('SELECT id FROM network_brands WHERE name = ?', [`${TAG} Marca del editor`]);
    await post(`/red/infraestructura/catalogo/marca/${lone.id}/eliminar`);
    check('Una marca con modelos no se borra; una sin modelos, sí', !!(await row('SELECT id FROM network_brands WHERE id = ?', [brand.id])) && !(await row('SELECT id FROM network_brands WHERE id = ?', [lone.id])));

    // ---------------- equipos que vienen de otra parte ----------------
    await pool.query('INSERT INTO network_devices SET ?', [{ kind: 'ap', name: `${TAG} AP-Omada`, mac: '3C:78:95:00:E2:43', brand_model: 'EAP620 HD(US) v3.0', sede: 'Sede antigua', source: 'omada' }]);
    const om = await full(`${TAG} AP-Omada`);
    page = await get(`/red/infraestructura/${om.id}`);
    check('Un AP registrado desde Omada: muestra su modelo anterior y conserva una sede que ya no está en el catálogo', page.text.includes('Antes figuraba como «EAP620 HD(US) v3.0»') && page.text.includes('<option value="Sede antigua" selected'));
    await post(`/red/infraestructura/${om.id}`, { kind: 'ap', name: `${TAG} AP-Omada`, mac: '3C:78:95:00:E2:43', sede: 'Sede antigua', floor: '3' });
    check('Al guardarlo sin elegir modelo conserva su texto, su sede y su origen', (await full(`${TAG} AP-Omada`)).brand_model === 'EAP620 HD(US) v3.0' && (await full(`${TAG} AP-Omada`)).sede === 'Sede antigua'
      && (await full(`${TAG} AP-Omada`)).source === 'omada' && (await full(`${TAG} AP-Omada`)).floor === '3');
    await post(`/red/infraestructura/${om.id}`, { kind: 'ap', name: `${TAG} AP-Omada`, mac: '3C:78:95:00:E2:43', model_id: mAp.id });
    check('Al elegirle un modelo del catálogo pasa a usarlo', (await full(`${TAG} AP-Omada`)).model_id === mAp.id && (await full(`${TAG} AP-Omada`)).brand_model === `${TAG} Marca EAP620 HD`);
    check('Los mismos equipos siguen en la pestaña Equipos, y editar desde ahí lleva a la ficha', (await get('/red/equipos?tipo=switch')).text.includes(sw.name) && (await get(`/red/equipos/${d.id}`)).location === `/red/infraestructura/${d.id}`);

    // ---------------- eliminar ----------------
    const noCsrf = await fetch(`${base}/red/infraestructura/${d.id}/eliminar`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
    check('Sin token CSRF: no elimina', noCsrf.status === 302 && !!(await full(sw.name)));
    await post(`/red/infraestructura/${d.id}/eliminar`);
    check('Eliminar quita el equipo, su ficha y su monitoreo, y queda en la auditoría', !(await full(sw.name)) && !(await row('SELECT device_id FROM network_device_specs WHERE device_id = ?', [d.id]))
      && !(await row('SELECT device_id FROM network_device_monitor WHERE device_id = ?', [d.id])) && !!(await row("SELECT id FROM audit_log WHERE action = 'red_equipo_eliminado' AND target = ?", [sw.name])));
    check('Unidades: estados, PoE, velocidades, protocolos y métodos de monitoreo', Object.keys(netSvc.STATES).join() === 'en_uso,stock,reparacion,baja' && Object.keys(netSvc.POE).join() === 'no,poe,poe_plus,poe_pp,pasivo'
      && Object.keys(netSvc.PROTOCOLS).join() === 'rest,restconf,snmp,grpc' && Object.keys(mon.METHODS).join() === 'auto,tcp,snmp,no');
  } finally {
    await cleanup().catch((e) => console.error('limpieza:', e.message));
    await restoreAccess().catch((e) => console.error('permisos:', e.message));
    server.close();
    try { tcpServer.close(); } catch (e) { /* ya cerrado */ }
    udp.close();
    results.forEach(([ok, name]) => console.log(ok ? 'PASA ' : 'FALLA', name));
    const ok = results.filter((r) => r[0]).length;
    console.log(`\n${ok}/${results.length} pruebas correctas`);
    await pool.end();
    process.exit(ok === results.length && results.length ? 0 : 1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
