// Prueba del inventario GLPI (computadoras, monitores, impresoras) contra un
// GLPI SIMULADO que responde como la API REST real: initSession con
// App-Token/User-Token, errores ["CODIGO","mensaje"], /search con
// forcedisplay y Content-Range, detalle con expand_dropdowns y
// Computer_Item. No toca la base ni la configuracion guardada: la
// configuracion de GLPI se reemplaza en memoria.
//
// Uso: node tests/glpi_inventario.e2e.js
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const settingsService = require(path.join(ROOT, 'src/services/settingsService'));
const results = [];
const check = (name, cond) => results.push([!!cond, name]);

const APP_TOKEN = 'app-token-prueba';
const USER_TOKEN = 'user-token-prueba';
const DATA = {
  Computer: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `PC-${String(i + 1).padStart(3, '0')}`, serial: `SN${i + 1}`,
    otherserial: `INV-${i + 1}`, state: 'En uso', type: 'Laptop', manufacturer: 'Lenovo', model: 'ThinkPad', location: 'Sede Surco &#62; Piso 2',
    user: 'jperez', entity: 'Entidad raíz &#62; DEPILZONE', os: 'Windows 11' })),
  Monitor: [{ id: 101, name: 'MON-001', serial: 'MSN1', otherserial: 'INV-M1', state: 'En uso', type: 'LED', manufacturer: 'LG',
    model: '24MK430', location: 'Sede Surco', user: 'jperez', entity: 'DEPILZONE' }],
  Printer: [{ id: 201, name: 'IMP-RECEPCION', serial: 'PSN1', otherserial: 'INV-P1', state: 'En uso', type: 'Láser', manufacturer: 'HP',
    model: 'M404', location: 'Recepción', user: '', entity: 'DEPILZONE' }],
};
const OPT = { 1: 'name', 2: 'id', 3: 'location', 4: 'type', 5: 'serial', 6: 'otherserial', 23: 'manufacturer', 31: 'state', 40: 'model', 45: 'os', 70: 'user', 80: 'entity', 19: 'date_mod' };
const seen = { forcedisplay: null, criteria: null };

function fakeGlpi() {
  const g = express();
  g.use(express.json());
  const auth = (req, res, next) => {
    if (req.get('App-Token') !== APP_TOKEN) return res.status(400).json(['ERROR_WRONG_APP_TOKEN_PARAMETER', 'parametro app_token incorrecto']);
    if (req.path !== '/initSession' && req.get('Session-Token') !== 'sesion-1') return res.status(401).json(['ERROR_SESSION_TOKEN_INVALID', 'x']);
    next();
  };
  g.use('/apirest.php', auth);
  g.get('/apirest.php/initSession', (req, res) => {
    if (req.get('Authorization') !== `user_token ${USER_TOKEN}`) return res.status(401).json(['ERROR_GLPI_LOGIN_USER_TOKEN', 'token incorrecto']);
    res.json({ session_token: 'sesion-1' });
  });
  g.get('/apirest.php/killSession', (req, res) => res.json({}));
  g.get('/apirest.php/getMyProfiles', (req, res) => res.json({ myprofiles: [{ id: 2, name: 'Observer' }] }));
  g.get('/apirest.php/search/:itemtype', (req, res) => {
    const rows = DATA[req.params.itemtype];
    if (!rows) return res.status(400).json(['ERROR_RIGHT_MISSING', 'x']);
    seen.forcedisplay = req.query.forcedisplay;
    seen.criteria = req.query.criteria;
    let list = rows;
    const crit = req.query.criteria;
    if (crit && crit[0] && crit[0].value) {
      const v = crit[0].value.toLowerCase();
      list = rows.filter((r) => [r.name, r.serial, r.otherserial].some((x) => String(x).toLowerCase().includes(v)));
    }
    const [a, b] = String(req.query.range || '0-19').split('-').map(Number);
    const page = list.slice(a, b + 1);
    const display = Object.values(req.query.forcedisplay || {}).map(String);
    const data = page.map((r) => Object.fromEntries(display.map((id) => [id, r[OPT[id]] === undefined ? null : r[OPT[id]]])));
    res.status(page.length < list.length ? 206 : 200).set('Content-Range', `${a}-${a + page.length - 1}/${list.length}`)
      .json({ totalcount: list.length, count: page.length, data });
  });
  g.get('/apirest.php/:itemtype/:id/Computer_Item', (req, res) => {
    if (req.params.itemtype === 'Computer' && req.params.id === '1') {
      return res.json([{ id: 1, computers_id: 1, itemtype: 'Monitor', items_id: 101 }, { id: 2, computers_id: 1, itemtype: 'Printer', items_id: 201 }]);
    }
    if (req.params.itemtype === 'Monitor' && req.params.id === '101') return res.json([{ id: 1, computers_id: 1, itemtype: 'Monitor', items_id: 101 }]);
    res.json([]);
  });
  g.get('/apirest.php/Computer/:id/Item_SoftwareVersion', (req, res) => res.json([]));
  g.get('/apirest.php/:itemtype/:id', (req, res) => {
    const r = (DATA[req.params.itemtype] || []).find((x) => String(x.id) === req.params.id);
    if (!r) return res.status(404).json(['ERROR_ITEM_NOT_FOUND', 'x']);
    const low = req.params.itemtype.toLowerCase();
    res.json({ id: r.id, name: r.name, serial: r.serial, otherserial: r.otherserial, states_id: r.state, [`${low}types_id`]: r.type,
      manufacturers_id: r.manufacturer, [`${low}models_id`]: r.model, locations_id: r.location, users_id: r.user, entities_id: r.entity,
      size: req.params.itemtype === 'Monitor' ? 24 : undefined });
  });
  return g;
}

async function main() {
  const glpi = fakeGlpi().listen(0);
  const glpiUrl = `http://127.0.0.1:${glpi.address().port}`;
  let cfg = { glpi_base_url: glpiUrl, glpi_app_token: APP_TOKEN, glpi_user_token: USER_TOKEN };
  settingsService.getAll = async () => cfg; // configuracion en memoria, sin tocar la base

  const glpiClient = require(path.join(ROOT, 'src/services/glpiClient'));
  const modules = require(path.join(ROOT, 'src/middleware/modules'));
  modules.moduleEnabled = async () => true;

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
  const get = async (u) => { const r = await fetch(base + u); return { status: r.status, text: await r.text(), r }; };

  try {
    check('URL sin /apirest.php se completa sola', glpiClient.normalizeBaseUrl('https://glpi.empresa.com/') === 'https://glpi.empresa.com/apirest.php');
    check('GLPI 11: la URL de la API nueva (v2.3) se pasa a la Legacy API (v1)',
      glpiClient.normalizeBaseUrl('http://svrmonitor-dp:8081/api.php/v2.3') === 'http://svrmonitor-dp:8081/api.php/v1'
      && glpiClient.normalizeBaseUrl('http://svrmonitor-dp:8081/api.php/v1/') === 'http://svrmonitor-dp:8081/api.php/v1');
    check('IP no autorizada: dice qué IP autorizar en el cliente de API',
      glpiClient.explainGlpiError(400, ['ERROR_NOT_ALLOWED_IP', 'No hay un cliente API activo ... (172.16.1.22)']).includes('llegando desde 172.16.1.22'));
    const t = await glpiClient.testConnection();
    check(`Probar conexión informa lo que ve el usuario: ${JSON.stringify(t.counts)}`, t.counts.computadoras === 30 && t.counts.monitores === 1 && t.counts.impresoras === 1);

    let p = await get('/glpi/inventario');
    check('Pestaña Computadoras con datos y total', p.status === 200 && p.text.includes('PC-001') && p.text.includes('<strong>30</strong>'));
    check('Paginación (25 por página, 2 páginas)', p.text.includes('Página 1 de 2') && !p.text.includes('PC-026'));
    check('Entidades HTML de GLPI decodificadas (Sede Surco > Piso 2)', p.text.includes('Sede Surco &gt; Piso 2') && !p.text.includes('&amp;#62;'));
    check('Búsqueda envía criteria[0][field]=1 y forcedisplay como GLPI espera',
      seen.forcedisplay && Object.values(seen.forcedisplay).includes('45'));
    p = await get('/glpi/inventario?tipo=computadoras&page=2');
    check('Página 2 muestra PC-026..PC-030', p.text.includes('PC-026') && p.text.includes('PC-030'));
    p = await get('/glpi/inventario?tipo=computadoras&q=INV-7');
    check('Buscar por N.º de inventario', p.text.includes('PC-007') && !p.text.includes('PC-001<') && seen.criteria && seen.criteria[1].field === '5');
    p = await get('/glpi/inventario?tipo=monitores');
    check('Pestaña Monitores', p.text.includes('MON-001') && p.text.includes('24MK430'));
    p = await get('/glpi/inventario?tipo=impresoras');
    check('Pestaña Impresoras', p.text.includes('IMP-RECEPCION') && p.text.includes('M404'));

    p = await get('/glpi/inventario/1');
    check('Detalle de computadora (ruta de siempre) con monitores e impresoras conectados',
      p.status === 200 && p.text.includes('MON-001') && p.text.includes('IMP-RECEPCION') && p.text.includes('/glpi/inventario/monitores/101'));
    p = await get('/glpi/inventario/monitores/101');
    check('Detalle de monitor: tamaño y a qué computadora está conectado', p.text.includes('Tamaño (pulgadas)') && p.text.includes('PC-001'));
    p = await get('/glpi/inventario/impresoras/201');
    check('Detalle de impresora', p.status === 200 && p.text.includes('IMP-RECEPCION') && p.text.includes('HP'));

    const x = await fetch(`${base}/glpi/inventario/exportar.xlsx?tipo=computadoras`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await x.arrayBuffer()));
    const sheet = wb.worksheets[0];
    check(`Excel de computadoras con TODAS las páginas (${sheet.rowCount - 1} filas) y columna Sistema operativo`,
      sheet.rowCount === 31 && sheet.getRow(1).values.includes('Sistema operativo') && sheet.getRow(2).values.includes('Windows 11'));

    cfg = { ...cfg, glpi_app_token: 'malo' };
    p = await get('/glpi/inventario');
    check('App-Token incorrecto: explica dónde está el app_token', p.text.includes('App-Token no es válido') && p.text.includes('cliente de API'));
    cfg = { ...cfg, glpi_app_token: APP_TOKEN, glpi_user_token: 'malo' };
    p = await get('/glpi/inventario?tipo=impresoras');
    check('User-Token incorrecto: explica dónde está el token del usuario', p.text.includes('User-Token no es válido') && p.text.includes('Claves de acceso remoto'));
    cfg = { ...cfg, glpi_user_token: USER_TOKEN, glpi_base_url: 'http://127.0.0.1:1' };
    p = await get('/glpi/inventario');
    check('GLPI inalcanzable: mensaje de conexión', p.text.includes('No se pudo conectar con http://127.0.0.1:1/apirest.php'));
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
