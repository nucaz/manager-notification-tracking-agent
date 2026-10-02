// Prueba del inventario GLPI por la API v2 de GLPI 11 (OAuth) contra un
// GLPI SIMULADO que responde como la real (verificado contra el doc.json de
// GLPI 11 v2.3 y su codigo fuente): POST /api.php/token (form, grant
// password, scope api) -> {access_token, expires_in}; /Assets/<Tipo> con
// start/limit/filter RSQL/sort -> arreglo + Content-Range; errores OAuth
// {"error":"invalid_client",...}. No toca la base ni la configuracion
// guardada: la configuracion se reemplaza en memoria.
//
// Uso: node tests/glpi_v2.e2e.js
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const settingsService = require(path.join(ROOT, 'src/services/settingsService'));
const results = [];
const check = (name, cond) => results.push([!!cond, name]);

const CLIENT = { id: 'cliente-app', secret: 'secreto-app', user: 'svc_inventario', pass: 'clave-svc' };
const obj = (name) => ({ id: 1, name });
const PCS = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `PC-${String(i + 1).padStart(3, '0')}`, serial: `SN${i + 1}`,
  otherserial: `INV-${i + 1}`, status: obj('En uso'), type: obj('Laptop'), manufacturer: obj('Lenovo'), model: obj('ThinkPad'),
  location: obj('Sede Surco'), user: obj('jperez'), entity: { id: 0, name: 'DEPILZONE', completename: 'Raíz > DEPILZONE' }, group: [obj('TI')] }));
const DATA = {
  Computer: PCS,
  Monitor: [{ id: 101, name: 'MON-001', serial: 'MSN1', otherserial: 'INV-M1', status: obj('En uso'), type: obj('LED'), manufacturer: obj('LG'),
    model: obj('24MK430'), location: obj('Sede Surco'), user: obj('jperez'), entity: obj('DEPILZONE'), size: 24 }],
  Printer: [{ id: 201, name: 'IMP-RECEPCION', serial: 'PSN1', otherserial: 'INV-P1', status: obj('En uso'), type: obj('Láser'),
    manufacturer: obj('HP'), model: obj('M404'), location: obj('Recepción'), entity: obj('DEPILZONE') }],
};
const seen = { tokenRequests: 0, lastToken: null, headers: null, filter: null, contract: null, legacySearches: 0 };
// API clasica del mismo GLPI (en GLPI 11: /api.php/v1): de ahi salen los
// datos ampliados. Se puede "apagar", como viene por defecto en GLPI 11.
const LEGACY = { enabled: false, app: 'app-token-prueba', user: 'user-token-prueba' };
const EXTRA = { 2: 'id', 45: 'os', 46: 'os_version', 17: 'processor', 999: 'memory_type', 111: 'memory', 126: 'ip' };
const LEGACY_PC = { os: 'Windows 11 Pro', os_version: '23H2', processor: ['Intel Core i5-12400', 'Intel Core i5-12400'], memory_type: 'DDR4$$##$$DDR4', memory: '16384.0000', ip: ['127.0.0.1', '172.16.1.50', 'fe80::1'] };
const SEARCH_OPTIONS = {
  common: 'Características',
  1: { name: 'Nombre', table: 'glpi_computers', field: 'name' },
  10: { name: 'Fecha de último arranque', table: 'glpi_computers', field: 'last_boot' },
  17: { name: 'Procesador', table: 'glpi_deviceprocessors', field: 'designation' },
  45: { name: 'Sistema operativo - Nombre', table: 'glpi_operatingsystems', field: 'name' },
  46: { name: 'Sistema operativo - Versión', table: 'glpi_operatingsystemversions', field: 'name' },
  111: { name: 'Memoria', table: 'glpi_items_devicememories', field: 'size' },
  999: { name: 'Tipo de memoria', table: 'glpi_devicememories', field: 'designation' },
};

function fakeGlpi() {
  const g = express();
  g.use(express.urlencoded({ extended: false }));
  g.use(express.json());
  g.post('/api.php/token', (req, res) => {
    seen.tokenRequests += 1;
    seen.lastToken = req.body;
    if (req.body.client_id !== CLIENT.id || req.body.client_secret !== CLIENT.secret) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Client authentication failed' });
    }
    if (req.body.grant_type !== 'password') return res.status(400).json({ error: 'unsupported_grant_type' });
    if (req.body.username !== CLIENT.user || req.body.password !== CLIENT.pass) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'The user credentials were incorrect.' });
    }
    res.json({ token_type: 'Bearer', expires_in: 3600, access_token: 'token-v2', refresh_token: 'r' });
  });
  g.get('/api.php/v1/initSession', (req, res) => {
    if (!LEGACY.enabled) return res.status(400).json(['ERROR', 'API deshabilitada']);
    if (req.get('App-Token') !== LEGACY.app) return res.status(400).json(['ERROR_WRONG_APP_TOKEN_PARAMETER', 'x']);
    if (req.get('Authorization') !== `user_token ${LEGACY.user}`) return res.status(401).json(['ERROR_GLPI_LOGIN_USER_TOKEN', 'x']);
    res.json({ session_token: 'sesion-legacy' });
  });
  g.get('/api.php/v1/killSession', (req, res) => res.json({}));
  g.get('/api.php/v1/listSearchOptions/Computer', (req, res) => res.json(SEARCH_OPTIONS));
  g.get('/api.php/v1/search/Computer', (req, res) => {
    seen.legacySearches += 1;
    const display = Object.values(req.query.forcedisplay || {}).map(String);
    const data = PCS.map((pc) => Object.fromEntries(display.map((id) => [id, EXTRA[id] === 'id' ? pc.id : LEGACY_PC[EXTRA[id]]])));
    res.set('Content-Range', `0-${data.length - 1}/${data.length}`).json({ totalcount: data.length, count: data.length, data });
  });
  g.use('/api.php', (req, res, next) => {
    if (req.get('Authorization') !== 'Bearer token-v2') {
      return res.status(401).json({ title: 'You are not authenticated', status: 'ERROR_UNAUTHENTICATED' });
    }
    seen.headers = req.headers;
    next();
  });
  g.get('/api.php/Administration/User/Me', (req, res) => (seen.meForbidden ? res.status(403).json({ status: 'ERROR_RIGHT_MISSING' }) : res.json({ id: 7, username: CLIENT.user })));
  g.get('/api.php/Administration/Entity', (req, res) => res.json([{ id: 0, name: 'Raíz', completename: 'Raíz' }]));
  g.post('/api.php/Management/Contract', (req, res) => { seen.contract = req.body; res.status(201).json({ id: 55, href: '/Management/Contract/55' }); });
  g.get('/api.php/Assets/:itemtype', (req, res) => {
    const rows = DATA[req.params.itemtype];
    if (!rows) return res.status(404).json({});
    seen.filter = req.query.filter;
    let list = rows;
    if (req.query.filter) {
      const terms = req.query.filter.split(',').map((t) => t.split('=ilike=')[1].replace(/\*/g, '').toLowerCase());
      list = rows.filter((r) => terms.some((v) => [r.name, r.serial, r.otherserial].some((x) => String(x).toLowerCase().includes(v))));
    }
    const start = Number(req.query.start || 0);
    const limit = Number(req.query.limit || 100);
    const page = list.slice(start, start + limit);
    res.status(start + page.length < list.length ? 206 : 200).set('Content-Range', `${start}-${start + page.length - 1}/${list.length}`).json(page);
  });
  g.get('/api.php/Assets/:itemtype/:id/PeripheralConnection', (req, res) => {
    if (req.params.itemtype === 'Computer' && req.params.id === '1') {
      return res.json([{ id: 1, itemtype_asset: 'Computer', items_id_asset: 1, itemtype_peripheral: 'Monitor', items_id_peripheral: 101, is_deleted: false },
        { id: 2, itemtype_asset: 'Computer', items_id_asset: 1, itemtype_peripheral: 'Printer', items_id_peripheral: 201, is_deleted: false }]);
    }
    if (req.params.itemtype === 'Monitor') return res.json([{ id: 1, itemtype_asset: 'Computer', items_id_asset: 1, itemtype_peripheral: 'Monitor', items_id_peripheral: 101 }]);
    res.json([]);
  });
  g.get('/api.php/Assets/Computer/:id/SoftwareInstallation', (req, res) => res.set('Content-Range', '0-1/2')
    .json([{ id: 1, softwareversion: { id: 9, name: '7.0.1' }, date_install: '2026-01-10' }, { id: 2, softwareversion: { id: 10, name: '24.05' } }]));
  g.get('/api.php/Assets/:itemtype/:id', (req, res) => {
    const r = (DATA[req.params.itemtype] || []).find((x) => String(x.id) === req.params.id);
    return r ? res.json(r) : res.status(404).json({ status: 'ERROR_ITEM_NOT_FOUND' });
  });
  return g;
}

async function main() {
  const glpi = fakeGlpi().listen(0);
  const port = glpi.address().port;
  let cfg = { glpi_api_version: 'v2', glpi_base_url: `http://127.0.0.1:${port}/api.php/v2.3`, glpi_oauth_client_id: CLIENT.id,
    glpi_oauth_client_secret: CLIENT.secret, glpi_oauth_username: CLIENT.user, glpi_oauth_password: CLIENT.pass };
  settingsService.getAll = async () => cfg;

  const glpiClient = require(path.join(ROOT, 'src/services/glpiClient'));
  const v2 = require(path.join(ROOT, 'src/services/glpiV2Client'));
  require(path.join(ROOT, 'src/middleware/modules')).moduleEnabled = async () => true;

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'e2e', resave: false, saveUninitialized: true }));
  app.use(flash());
  const admin = { id: 1, email: 'admin@prueba', full_name: 'Admin', role: 'admin' };
  app.use((req, res, next) => {
    req.session.user = admin;
    Object.assign(res.locals, { currentUser: admin, csrfToken: 'x', successMessages: [], errorMessages: [], currentPath: req.path,
      currentHost: req.hostname, appName: 'Prueba', enabledModules: new Proxy({}, { get: () => true }) });
    next();
  });
  app.use('/glpi', require(path.join(ROOT, 'src/routes/glpi')));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (u) => { const r = await fetch(base + u); return { status: r.status, text: await r.text() }; };

  try {
    check('Con la API v2 elegida, la app la usa', (await glpiClient.apiVersion()) === 'v2');
    check('URL de GLPI 11 (…/api.php/v2.3) → raíz …/api.php', v2.apiRoot('http://svrmonitor-dp:8081/api.php/v2.3') === 'http://svrmonitor-dp:8081/api.php');
    const t = await glpiClient.testConnection();
    check(`Probar conexión (v2): usuario y conteos ${JSON.stringify(t.counts)}`, t.user === CLIENT.user && t.counts.computadoras === 30 && t.counts.impresoras === 1);
    check('Pide el token con grant password, scope api y los datos del cliente',
      seen.lastToken.grant_type === 'password' && seen.lastToken.scope === 'api' && seen.lastToken.client_id === CLIENT.id);
    check('Consulta con Bearer y GLPI-Entity-Recursive: true (incluye entidades hijas)', seen.headers['glpi-entity-recursive'] === 'true');

    const before = seen.tokenRequests;
    let p = await get('/glpi/inventario');
    check('Pestaña Computadoras con datos, total y paginación', p.text.includes('PC-001') && p.text.includes('<strong>30</strong>') && p.text.includes('Página 1 de 2'));
    p = await get('/glpi/inventario?tipo=computadoras&page=2');
    check('Página 2', p.text.includes('PC-026') && p.text.includes('PC-030'));
    check('El token se reutiliza (no se pide uno por consulta)', seen.tokenRequests === before);
    p = await get('/glpi/inventario?tipo=computadoras&q=INV-7');
    check(`Búsqueda con filtro RSQL (${seen.filter})`, p.text.includes('PC-007') && seen.filter === 'name=ilike=*INV-7*,serial=ilike=*INV-7*,otherserial=ilike=*INV-7*');
    await get('/glpi/inventario?tipo=computadoras&q=' + encodeURIComponent('a,b;c=d'));
    check('Caracteres especiales de RSQL se limpian de la búsqueda', !/[;]|=d/.test(seen.filter.replace(/=ilike=/g, '')));
    p = await get('/glpi/inventario?por=10&page=3');
    check('Registros por página (10): 3 páginas, la tercera con PC-021..PC-030, y los enlaces conservan la elección', p.text.includes('Página 3 de 3 · 21–30 de 30')
      && p.text.includes('PC-030') && !p.text.includes('PC-020<') && p.text.includes('por=10&amp;page=2') && p.text.includes('<option value="10" selected>'));
    p = await get('/glpi/inventario?por=todos');
    check('Registros por página "Todos": los 30 en una sola página, sin paginador', p.text.includes('PC-001') && p.text.includes('PC-030')
      && !p.text.includes('Página 1 de') && p.text.includes('<option value="todos" selected>'));
    p = await get('/glpi/inventario?por=999');
    check('Un valor no admitido vuelve al predeterminado (20)', p.text.includes('Página 1 de 2') && p.text.includes('1–20 de 30'));
    p = await get('/glpi/inventario?tipo=monitores');
    check('Pestaña Monitores', p.text.includes('MON-001') && p.text.includes('24MK430'));
    p = await get('/glpi/inventario?tipo=impresoras');
    check('Pestaña Impresoras', p.text.includes('IMP-RECEPCION') && p.text.includes('M404'));
    p = await get('/glpi/inventario/1');
    check('Detalle de computadora: periféricos conectados y software (versiones)',
      p.text.includes('MON-001') && p.text.includes('IMP-RECEPCION') && p.text.includes('7.0.1') && p.text.includes('nombre de cada programa no viene'));
    p = await get('/glpi/inventario/monitores/101');
    check('Detalle de monitor: tamaño y computadora a la que está conectado', p.text.includes('Tamaño (pulgadas)') && p.text.includes('PC-001'));

    const x = await fetch(`${base}/glpi/inventario/exportar.xlsx?tipo=computadoras`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await x.arrayBuffer()));
    check(`Excel con todas las páginas (${wb.worksheets[0].rowCount - 1} filas)`, wb.worksheets[0].rowCount === 31);

    // --- Datos ampliados: la API v2 no los entrega; salen de la API clasica
    p = await get('/glpi/inventario');
    check('v2 sin tokens de la API clásica: el inventario se lista igual y avisa qué falta para los datos ampliados', p.text.includes('PC-001')
      && p.text.includes('Sin sistema operativo, procesador, memoria ni IP') && p.text.includes('faltan el App-Token y el User-Token'));
    check('En v2 la pantalla también muestra entidad y fabricante', p.text.includes('Raíz &gt; DEPILZONE') && p.text.includes('Lenovo'));
    cfg = { ...cfg, glpi_app_token: LEGACY.app, glpi_user_token: LEGACY.user };
    p = await get('/glpi/inventario');
    check('v2 con la API clásica apagada en GLPI: lo explica y dice cómo activarla', p.text.includes('PC-001')
      && p.text.includes('La API clásica está desactivada en GLPI') && p.text.includes('Enable Legacy REST API') && p.text.includes('autorice la IP de este servidor'));
    p = await get('/glpi/inventario?tipo=monitores');
    check('El aviso solo aparece en Computadoras', !p.text.includes('Sin sistema operativo'));
    LEGACY.enabled = true;
    p = await get('/glpi/inventario');
    check('v2 + API clásica activa: trae sistema operativo y versión, procesador, tipo de memoria, memoria e IP, sin aviso',
      !p.text.includes('Sin sistema operativo') && p.text.includes('Windows 11 Pro') && p.text.includes('23H2') && p.text.includes('>Intel Core i5-12400<')
      && p.text.includes('>DDR4<') && p.text.includes('16 GB'));
    const searches = seen.legacySearches;
    p = await get('/glpi/inventario?tipo=computadoras&page=2');
    check('Los datos ampliados se piden una vez y se reutilizan entre páginas', p.text.includes('Windows 11 Pro') && seen.legacySearches === searches);
    p = await get('/glpi/inventario/1');
    check('Detalle de computadora en v2: suma procesador, memoria, sistema operativo e IP', p.text.includes('Procesador') && p.text.includes('Intel Core i5-12400')
      && p.text.includes('Versión del SO'));
    const x2 = await fetch(`${base}/glpi/inventario/exportar.xlsx?tipo=computadoras`);
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(Buffer.from(await x2.arrayBuffer()));
    const head = wb2.worksheets[0].getRow(1).values;
    const cell = (label) => wb2.worksheets[0].getRow(2).getCell(head.indexOf(label)).value;
    check('Excel en v2: todas las columnas pedidas, con datos', wb2.worksheets[0].rowCount === 31 && cell('Sistema operativo') === 'Windows 11 Pro'
      && cell('Versión del SO') === '23H2' && cell('Entidad') === 'Raíz > DEPILZONE' && cell('Fabricante') === 'Lenovo'
      && cell('Procesador') === 'Intel Core i5-12400' && cell('Tipo de memoria') === 'DDR4' && cell('Memoria') === '16 GB' && cell('IP') === '');

    // Conteo para el panel principal: no debe depender de ver el propio perfil
    // (un usuario de servicio de solo lectura puede no tener ese permiso).
    seen.meForbidden = true;
    glpiClient._clearCaches();
    const conteo = await glpiClient.assetCounts();
    check(`Conteo para el panel en v2, aun sin permiso para ver el propio usuario: ${JSON.stringify(conteo)}`, conteo && conteo.computadoras === 30
      && Number.isInteger(conteo.monitores) && Number.isInteger(conteo.impresoras));
    seen.meForbidden = false;

    const ent = await glpiClient.listEntities();
    check('Entidades por la API v2', ent[0] && ent[0].completename === 'Raíz');
    const c = await glpiClient.createContract({ name: 'Licencia: Office', notes: 'n', begin_date: '2026-01-01' });
    check('Crear contrato en GLPI por la API v2', c.id === 55 && seen.contract.name === 'Licencia: Office' && seen.contract.date_begin === '2026-01-01');
    const eq = await glpiClient.searchComputers('PC-00', 5);
    check('Autocompletar equipos mantiene la forma de la API clásica', eq.length === 5 && eq[0]['1'] === 'PC-001' && eq[0]['2'] === 1);

    v2._tokenCache.clear();
    cfg = { ...cfg, glpi_oauth_client_secret: 'malo' };
    p = await get('/glpi/inventario');
    check('Secreto de cliente incorrecto: explica qué revisar', p.text.includes('rechazó el cliente OAuth') && p.text.includes('invalid_client'));
    cfg = { ...cfg, glpi_oauth_client_secret: CLIENT.secret, glpi_oauth_password: 'mala' };
    p = await get('/glpi/inventario');
    check('Contraseña del usuario incorrecta: invalid_grant explicado', p.text.includes('usuario o la contraseña') && p.text.includes('invalid_grant'));
    cfg = { ...cfg, glpi_oauth_password: '' };
    p = await get('/glpi/inventario');
    check('Configuración incompleta: dice qué falta', p.text.includes('falta contraseña'));
    cfg = { ...cfg, glpi_oauth_password: CLIENT.pass, glpi_base_url: 'http://nombre-corto-inexistente.invalid:8081/api.php/v2.3' };
    p = await get('/glpi/inventario');
    check('Nombre que no se resuelve: sugiere el nombre completo o la IP', p.text.includes('no puede resolver ese nombre'));
    cfg = { ...cfg, glpi_api_version: 'legacy' };
    check('Volver a la API clásica', (await glpiClient.apiVersion()) === 'legacy');
  } finally {
    server.close();
    glpi.close();
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
