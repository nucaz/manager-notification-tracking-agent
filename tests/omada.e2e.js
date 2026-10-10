// Prueba de Red > Omada: configuracion de controladores, lectura por la Open
// API (contra un controlador SIMULADO local; nunca uno real), tablero,
// equipos, clientes, registro en el inventario y permisos por rol.
//
// Usa las rutas REALES con una sesion simulada. Crea datos marcados (ZZ-E2E)
// y los borra al final. Pide E2E_PERMITIR=1.
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/omada.e2e.js
const path = require('path');
const http = require('http');
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

// ---------------- controlador Omada simulado ----------------
const OMADAC = 'e2e0omadac0id0000000000000000001';
const CLIENT = 'e2eclient0000000000000000000id01';
const SECRET = 'e2e-secreto-que-no-debe-verse-0001';
const mock = { calls: [], tokens: 0, expireNext: false, down: false, clients: null, devices: null, methods: new Set() };
const DEVICES = [
  { mac: '30-DE-4B-00-E2-01', name: 'ZZ-E2E SW-Sistemas', type: 'switch', model: 'SG2008 v4.20', ip: '192.168.100.94', status: 1, cpuUtil: 12, memUtil: 40, uptime: '9day(s) 6h', firmwareVersion: '4.20.24', sn: 'SN-SW-1' },
  { mac: '3C-78-95-00-E2-02', name: 'ZZ-E2E AP1-Counter', type: 'ap', model: 'EAP620 HD(US) v3.0', ip: '192.168.100.44', status: 1, cpuUtil: 91, memUtil: 55, uptime: '3day(s)', firmwareVersion: '1.6.7', sn: 'SN-AP-1',
    uplinkDeviceName: 'ZZ-E2E SW-Sistemas', uplinkDevicePort: '8' },
  { mac: '3C-78-95-00-E2-03', name: 'ZZ-E2E AP2-Clinica', type: 'ap', model: 'EAP620 HD(US) v3.0', ip: '192.168.100.17', status: 0, uptime: '', firmwareVersion: '1.6.7' },
];
const CLIENTS = [
  { mac: 'AA-00-00-00-E2-01', name: 'ZZ-E2E Corporativo', ip: '192.168.100.145', wireless: true, ssid: 'Clinica', apMac: '3C-78-95-00-E2-02', apName: 'ZZ-E2E AP1-Counter', signalLevel: 82,
    activity: 125000, uploadActivity: 25000, trafficDown: 3 * 1024 ** 3, trafficUp: 1024 ** 2, vendor: 'Samsung', deviceType: 'android' },
  { mac: 'AA-00-00-00-E2-02', hostName: 'ZZ-E2E-1PCCLINI01', ip: '192.168.100.53', wireless: true, ssid: 'Clinica', apMac: '3C-78-95-00-E2-02', apName: 'ZZ-E2E AP1-Counter', signalLevel: 31,
    activity: 1000, uploadActivity: 500, trafficDown: 1024 ** 2, trafficUp: 1024 },
  { mac: 'AA-00-00-00-E2-03', name: 'ZZ-E2E Garita', ip: '192.168.100.15', wireless: false, switchMac: '30-DE-4B-00-E2-01', switchName: 'ZZ-E2E SW-Sistemas', port: 8, vid: 1,
    activity: 0, uploadActivity: 0, trafficDown: 8 * 1024 ** 3, trafficUp: 0 },
  { mac: 'no-es-una-mac', name: 'ZZ-E2E Basura', wireless: true },
];
function startMock() {
  const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const grid = (rows, url) => {
    const page = Number(url.searchParams.get('page')); const size = Number(url.searchParams.get('pageSize'));
    return { errorCode: 0, msg: 'Success.', result: { totalRows: rows.length, currentPage: page, currentSize: size, data: rows.slice((page - 1) * size, page * size) } };
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    mock.calls.push(`${req.method} ${url.pathname}`);
    mock.methods.add(req.method);
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (mock.down) { res.writeHead(503); return res.end('fuera de servicio'); }
      if (req.method === 'POST' && url.pathname === '/openapi/authorize/token') {
        const b = JSON.parse(body || '{}');
        if (url.searchParams.get('grant_type') !== 'client_credentials' || b.omadacId !== OMADAC || b.client_id !== CLIENT || b.client_secret !== SECRET) {
          return json(res, { errorCode: -44106, msg: 'The client id or client secret is invalid' });
        }
        mock.tokens += 1;
        return json(res, { errorCode: 0, msg: 'Open API Get Access Token successfully.', result: { accessToken: `tok-${mock.tokens}`, tokenType: 'bearer', expiresIn: 7200, refreshToken: 'r' } });
      }
      if (req.headers.authorization !== `AccessToken=tok-${mock.tokens}`) return json(res, { errorCode: -44113, msg: 'The Access Token is Invalid' });
      if (mock.expireNext) { mock.expireNext = false; mock.tokens += 100; return json(res, { errorCode: -44112, msg: 'The access token has expired' }); }
      const p = url.pathname.replace(`/openapi/v1/${OMADAC}`, '');
      if (req.method !== 'GET') return json(res, { errorCode: -1, msg: 'solo lectura' });
      if (p === '/sites') return json(res, grid([{ siteId: 'site-e2e-1', name: 'ZZ-E2E Pueblo Libre', region: 'Peru' }], url));
      if (p === '/sites/site-e2e-1/devices') return json(res, grid(mock.devices || DEVICES, url));
      if (p === '/sites/site-e2e-1/clients') return json(res, grid(mock.clients || CLIENTS, url));
      res.writeHead(404); return res.end('no');
    });
  });
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server)); });
}

async function main() {
  const pool = require(path.join(ROOT, 'src/db/pool'));
  const omada = require(path.join(ROOT, 'src/services/omadaService'));
  const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));
  omada._.allowHttp = true; // el simulado no tiene TLS
  const TAG = 'ZZ-E2E';
  const cleanup = async () => {
    await pool.query('DELETE FROM omada_controllers WHERE name LIKE ? OR omadac_id = ?', [`${TAG}%`, OMADAC]);
    await pool.query('DELETE FROM network_devices WHERE name LIKE ?', [`${TAG}%`]);
    await pool.query("DELETE FROM audit_log WHERE action LIKE 'red\\_omada\\_%' AND (target LIKE ? OR target = 'equipos de red')", [`${TAG}%`]);
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
  const CSRF = 'token-de-prueba-omada-0123456789abcdef0123456789abcdef';
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
  const row = async (sql, args) => (await pool.query(sql, args))[0][0];
  const rows = async (sql, args) => (await pool.query(sql, args))[0];
  const fake = await startMock();
  const URL_OK = `http://127.0.0.1:${fake.address().port}`;
  const form = (extra = {}) => ({ name: `${TAG} OC300`, base_url: URL_OK, omadac_id: OMADAC, client_id: CLIENT, client_secret: SECRET, verify_tls: ['0', '1'], enabled: ['0', '1'], ...extra });

  try {
    // ---------------- sin configurar ----------------
    let page = await get('/red/omada');
    check('Sin controladores: la pantalla abre e invita a configurar', page.status === 200 && page.text.includes('Aún no hay ningún controlador Omada') && page.text.includes('/red/omada/configuracion'));
    check('La pestaña Omada aparece en el módulo Red', (await get('/red/vlan')).text.includes('href="/red/omada"'));

    // ---------------- validaciones del formulario ----------------
    omada._.allowHttp = false;
    await post('/red/omada/configuracion', form());
    page = await get('/red/omada/configuracion');
    check('Dirección sin https: rechazada, y lo escrito vuelve al formulario sin el secreto', page.text.includes('debe empezar con https://') && page.text.includes(`value="${OMADAC}"`) && !page.text.includes(SECRET)
      && !(await row('SELECT id FROM omada_controllers WHERE omadac_id = ?', [OMADAC])));
    omada._.allowHttp = true;
    const rejected = async (extra, text) => { await post('/red/omada/configuracion', form(extra)); const p = await get('/red/omada/configuracion'); return p.text.includes(text) && !(await row('SELECT id FROM omada_controllers WHERE omadac_id = ?', [OMADAC])); };
    check('Dirección con usuario, parámetros o que no es una URL: rechazada', await rejected({ base_url: 'https://a:b@host' }, 'no lleva usuario') && await rejected({ base_url: 'https://host/?x=1' }, 'no lleva usuario')
      && await rejected({ base_url: 'omada' }, 'no es válida'));
    check('Omada ID, Client ID o secreto mal formados: rechazados', await rejected({ omadac_id: 'con espacios x' }, 'Omada ID no es válido') && await rejected({ client_id: 'x;rm' }, 'Client ID no es válido')
      && await rejected({ client_secret: '' }, 'Escriba el Client Secret') && await rejected({ client_secret: 'con espacio dentro' }, 'Client Secret no es válido'));

    // ---------------- credenciales malas ----------------
    await post('/red/omada/configuracion', form({ client_secret: 'secreto-equivocado-000' }));
    page = await get('/red/omada/configuracion');
    let ctrl = await row('SELECT * FROM omada_controllers WHERE omadac_id = ?', [OMADAC]);
    check('Secreto equivocado: se guarda, pero avisa que la conexión falló y por qué', !!ctrl && page.text.includes('la prueba de conexión falló') && page.text.includes('client id or client secret is invalid'));

    // ---------------- alta correcta ----------------
    await post('/red/omada/configuracion', form({ id: ctrl.id }));
    page = await get('/red/omada/configuracion');
    ctrl = await row('SELECT * FROM omada_controllers WHERE id = ?', [ctrl.id]);
    const keyed = !!require(path.join(ROOT, 'src/config/env')).credentialsEncKey;
    check('Guardar y probar: conexión correcta y lista de sitios', page.text.includes('conexión correcta') && page.text.includes(`${TAG} Pueblo Libre`));
    check('El secreto se guarda cifrado y no aparece en la página', (!keyed || String(ctrl.client_secret).startsWith('enc:v1:')) && (!keyed || !String(ctrl.client_secret).includes(SECRET)) && !page.text.includes(SECRET));
    check('Guardar hace la primera lectura', ctrl.last_sync_ok === 1 && /3 equipos, 3 clientes/.test(ctrl.last_sync_detail));
    await post('/red/omada/configuracion', form({ name: `${TAG} Otro` }));
    check('El mismo controlador dos veces: rechazado', (await get('/red/omada/configuracion')).text.includes('ya está registrado') && (await rows('SELECT id FROM omada_controllers WHERE omadac_id = ?', [OMADAC])).length === 1);
    await post('/red/omada/configuracion', form({ id: ctrl.id, client_secret: '', name: `${TAG} OC300 PL` }));
    const after = await row('SELECT * FROM omada_controllers WHERE id = ?', [ctrl.id]);
    check('Editar sin escribir el secreto lo conserva', after.name === `${TAG} OC300 PL` && after.client_secret === ctrl.client_secret);

    // ---------------- lo leído ----------------
    const site = await row('SELECT * FROM omada_sites WHERE controller_id = ?', [ctrl.id]);
    check('Sitio con sus totales', site && site.name === `${TAG} Pueblo Libre` && site.devices_total === 3 && site.devices_online === 2 && site.clients_total === 3 && site.clients_wireless === 2
      && Number(site.down_bps) === 126000 * 8 && Number(site.up_bps) === 25500 * 8);
    const devs = await rows('SELECT * FROM omada_devices WHERE site_id = ? ORDER BY mac', [site.id]);
    check('Equipos: MAC normalizada, tipo, estado, CPU, enlace y clientes por equipo', devs.length === 3 && devs[0].mac === '30:DE:4B:00:E2:01' && devs[0].kind === 'switch' && devs[0].clients === 1
      && devs[1].kind === 'ap' && devs[1].clients === 2 && devs[1].cpu === 91 && devs[1].uplink_port === '8' && devs[2].status === 0 && devs[2].cpu === null);
    const clis = await rows('SELECT * FROM omada_clients WHERE site_id = ? ORDER BY mac', [site.id]);
    check('Clientes: Wi-Fi con SSID, AP y señal; cable con switch, puerto y VLAN; el de MAC inválida se descarta', clis.length === 3 && clis[0].ssid === 'Clinica' && clis[0].via_mac === '3C:78:95:00:E2:02'
      && clis[0].signal_pct === 82 && Number(clis[0].down_bps) === 1000000 && clis[1].name === `${TAG}-1PCCLINI01` && clis[2].wireless === 0 && clis[2].via_port === '8' && clis[2].vlan === 1 && clis[2].ssid === null);
    check('Solo lectura: al controlador solo se le hizo GET, más el POST del token', [...mock.methods].sort().join() === 'GET,POST'
      && mock.calls.filter((c) => c.startsWith('POST')).every((c) => c === 'POST /openapi/authorize/token'));

    // ---------------- token ----------------
    const before = mock.tokens;
    await omada.syncController(ctrl.id);
    check('El token se reutiliza entre lecturas', mock.tokens === before);
    mock.expireNext = true;
    const r1 = await omada.syncController(ctrl.id);
    check('Token vencido: se pide otro y la lectura termina bien', r1.ok && mock.tokens > before);

    // ---------------- inventario ----------------
    await pool.query('INSERT INTO network_devices SET ?', [{ kind: 'celular', name: `${TAG} Cel inventario`, mac: 'AA:00:00:00:E2:01', source: 'manual' }]).catch(async () => {
      await pool.query('INSERT INTO network_devices SET ?', [{ kind: 'pc', name: `${TAG} Cel inventario`, mac: 'AA:00:00:00:E2:01', source: 'manual' }]);
    });
    page = await get('/red/omada/clientes');
    check('Clientes: lista, y el nombre del inventario cuando la MAC coincide', page.status === 200 && page.text.includes(`${TAG} Corporativo`) && page.text.includes(`${TAG} Cel inventario`) && page.text.includes('AA:00:00:00:E2:03')
      && page.text.includes('3.00 GB') && page.text.includes('1.0 Mbps'));
    check('Clientes: filtro por Wi-Fi o cable y búsqueda', !(await get('/red/omada/clientes?ver=cable')).text.includes(`${TAG} Corporativo`) && (await get('/red/omada/clientes?ver=cable')).text.includes(`${TAG} Garita`)
      && !(await get(`/red/omada/clientes?q=${encodeURIComponent('192.168.100.15')}`)).text.includes(`${TAG} Corporativo`));
    page = await get('/red/omada/equipos');
    check('Equipos: lista con estado y botón para registrar los 3 en el inventario', page.text.includes(`${TAG} AP2-Clinica`) && page.text.includes('Desconectado') && page.text.includes('Registrar 3 en el inventario'));
    check('Equipos: filtro por tipo', !(await get('/red/omada/equipos?tipo=switch')).text.includes(`${TAG} AP1-Counter`));
    await post('/red/omada/equipos/registrar');
    const inv = await rows("SELECT * FROM network_devices WHERE source = 'omada' AND name LIKE ? ORDER BY mac", [`${TAG}%`]);
    check('Registrar en el inventario: AP y switch con MAC, IP, modelo y serie', inv.length === 3 && inv[0].kind === 'switch' && inv[0].mac === '30:DE:4B:00:E2:01' && inv[0].ip === '192.168.100.94'
      && inv[1].kind === 'ap' && inv[1].serial === 'SN-AP-1' && /Pueblo Libre/.test(inv[0].notes));
    await pool.query('UPDATE network_devices SET sede = ?, notes = ? WHERE id = ?', ['Surco', 'nota a mano', inv[0].id]);
    await post('/red/omada/equipos/registrar');
    const again = await row('SELECT * FROM network_devices WHERE id = ?', [inv[0].id]);
    check('Registrar otra vez no duplica ni pisa lo escrito a mano', (await rows("SELECT id FROM network_devices WHERE source = 'omada' AND name LIKE ?", [`${TAG}%`])).length === 3 && again.notes === 'nota a mano'
      && (await get('/red/omada/equipos')).text.includes('/red/equipos/' + inv[0].id) && !(await get('/red/omada/equipos')).text.includes('en el inventario de Red</button>'));

    // ---------------- cambios entre lecturas ----------------
    mock.clients = CLIENTS.slice(0, 1);
    mock.devices = DEVICES.slice(0, 2);
    await omada.syncController(ctrl.id);
    const gone = await row('SELECT * FROM omada_clients WHERE mac = ?', ['AA:00:00:00:E2:03']);
    check('Un cliente que se desconecta queda como visto, sin velocidad', gone && gone.active === 0 && Number(gone.down_bps) === 0 && Number(gone.traffic_down) === 8 * 1024 ** 3);
    check('«Conectados» ya no lo muestra; «Vistos en 30 días», sí', !(await get('/red/omada/clientes')).text.includes(`${TAG} Garita`) && (await get('/red/omada/clientes?ver=todos')).text.includes(`${TAG} Garita`));
    check('Un equipo que ya no figura en el controlador deja de listarse', !(await get('/red/omada/equipos')).text.includes(`${TAG} AP2-Clinica`)
      && (await row('SELECT devices_total FROM omada_sites WHERE id = ?', [site.id])).devices_total === 2);
    mock.clients = null; mock.devices = null;
    await omada.syncController(ctrl.id);

    // ---------------- tablero ----------------
    // Muestras de horas anteriores, para el grafico.
    for (let i = 1; i <= 6; i += 1) await pool.query('INSERT INTO omada_samples (site_id, taken_at, clients, wireless, down_bps, up_bps) VALUES (?, NOW() - INTERVAL ? MINUTE, ?, ?, ?, ?)', [site.id, i * 30, 10 + i, 5, i * 2000000, i * 300000]);
    page = await get('/red/omada');
    check('Tablero: totales, equipos caídos y última lectura', page.status === 200 && page.text.includes('id="omada_kpis"') && page.text.includes('2 por Wi-Fi') && page.text.includes('id="omada_caidos"')
      && page.text.includes(`${TAG} AP2-Clinica`) && page.text.includes('id="omada_ultima"'));
    check('Tablero: gráfico de consumo con su escala y pico', page.text.includes('id="omada_grafico"') && page.text.includes('12.0 Mbps') && page.text.includes('pico de descarga') && !page.text.includes('NaN'));
    check('Tablero: más consumo, clientes por AP, por SSID y señal débil', page.text.indexOf(`${TAG} Garita`) < page.text.indexOf(`${TAG} Cel inventario`) && page.text.includes('8.00 GB')
      && page.text.includes('Clinica') && page.text.includes('31 %') && page.text.includes('Clientes con señal débil'));
    check('Tablero: periodo y sitio inválidos no rompen', (await get('/red/omada?h=999&sitio=abc')).status === 200 && (await get(`/red/omada?h=6&sitio=${site.id}`)).text.includes('id="omada_grafico"'));
    const s7 = await omada.samples({ siteId: site.id, hours: 6 });
    check('Muestras: ordenadas por hora y solo las del periodo', s7.length >= 7 && s7.every((p, i) => !i || String(p.t) >= String(s7[i - 1].t)));
    await pool.query('INSERT INTO omada_samples (site_id, taken_at, clients) VALUES (?, NOW() - INTERVAL 45 DAY, 999)', [site.id]);
    await omada.sync();
    check('Las muestras de más de 30 días se borran solas', !(await row('SELECT id FROM omada_samples WHERE site_id = ? AND clients = 999', [site.id])));

    // ---------------- fallas del controlador ----------------
    mock.down = true;
    await new Promise((r) => setTimeout(r, 10));
    const bad = await omada.syncController(ctrl.id);
    page = await get('/red/omada');
    check('Controlador caído: queda el aviso y se sigue mostrando lo último leído', !bad.ok && /código 503/.test(bad.detail) && page.text.includes('la última lectura') && page.text.includes('falló') && page.text.includes('id="omada_kpis"'));
    mock.down = false;
    await post(`/red/omada/configuracion/${ctrl.id}/probar`);
    check('Probar conexión desde la lista', (await get('/red/omada/configuracion')).text.includes('Conexión correcta'));
    await pool.query('UPDATE omada_controllers SET enabled = 0 WHERE id = ?', [ctrl.id]);
    const calls = mock.calls.length;
    await omada.sync();
    check('Un controlador en pausa no se lee', mock.calls.length === calls);
    await pool.query('UPDATE omada_controllers SET enabled = 1 WHERE id = ?', [ctrl.id]);

    // ---------------- roles ----------------
    as('lector');
    check('Lector: ve el tablero, equipos y clientes, sin botones de escritura', (await get('/red/omada')).status === 200 && !(await get('/red/omada')).text.includes('Leer ahora')
      && !(await get('/red/omada/equipos')).text.includes('/red/omada/equipos/registrar') && (await get('/red/omada/clientes')).status === 200);
    check('Lector: no entra a la configuración ni puede leer, registrar o guardar', (await get('/red/omada/configuracion')).status !== 200 && (await post('/red/omada/leer')).status !== 200
      && (await post('/red/omada/equipos/registrar')).location !== '/red/omada/equipos' && (await post('/red/omada/configuracion', form({ name: `${TAG} Lector` }))).status !== 200
      && !(await row('SELECT id FROM omada_controllers WHERE name = ?', [`${TAG} Lector`])));
    as('editor');
    check('Editor: no configura ni borra controladores', (await get('/red/omada/configuracion')).status !== 200 && (await post(`/red/omada/configuracion/${ctrl.id}/eliminar`)).location !== '/red/omada/configuracion'
      && !!(await row('SELECT id FROM omada_controllers WHERE id = ?', [ctrl.id])));
    as('superadmin');
    const callsBefore = mock.calls.length;
    const noCsrf = await fetch(`${base}/red/omada/leer`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
    check('Sin token CSRF: rechazado, sin leer el controlador', noCsrf.status === 302 && mock.calls.length === callsBefore && (await get('/red/omada')).text.includes('la solicitud no es válida'));
    await post('/red/omada/leer');
    check('Leer ahora (administrador) y tope de una por minuto', (await get('/red/omada')).text.includes('Lectura completa') && (await post('/red/omada/leer')).location === '/red/omada'
      && (await get('/red/omada')).text.includes('menos de un minuto'));
    check('Auditoría de guardar, registrar y quitar', !!(await row("SELECT id FROM audit_log WHERE action = 'red_omada_controlador_guardado' AND target LIKE ?", [`${TAG}%`]))
      && !!(await row("SELECT id FROM audit_log WHERE action = 'red_omada_registrar_equipos'")));

    // ---------------- quitar ----------------
    await post(`/red/omada/configuracion/${ctrl.id}/eliminar`);
    check('Quitar el controlador borra lo leído y deja el inventario de Red', !(await row('SELECT id FROM omada_sites WHERE id = ?', [site.id])) && !(await row('SELECT id FROM omada_clients WHERE site_id = ?', [site.id]))
      && !(await row('SELECT id FROM omada_samples WHERE site_id = ?', [site.id])) && (await rows("SELECT id FROM network_devices WHERE source = 'omada' AND name LIKE ?", [`${TAG}%`])).length === 3);
  } finally {
    await cleanup().catch((e) => console.error('limpieza:', e.message));
    await restoreAccess().catch((e) => console.error('permisos:', e.message));
    server.close();
    fake.close();
    results.forEach(([ok, name]) => console.log(ok ? 'PASA ' : 'FALLA', name));
    const ok = results.filter((r) => r[0]).length;
    console.log(`\n${ok}/${results.length} pruebas correctas`);
    await pool.end();
    process.exit(ok === results.length && results.length ? 0 : 1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
