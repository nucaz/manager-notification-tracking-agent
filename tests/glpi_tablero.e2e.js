// Prueba del inventario GLPI con copia local: datos derivados (generacion y
// familia del procesador, antiguedad, Windows 11, tipo de memoria, marca y
// sede), filtros por columna como en Excel, Excel filtrado, y el tablero con
// indicadores y widgets propios (aparte del de celulares).
//
// Usa las rutas REALES con una sesion simulada. Crea equipos marcados
// (glpi_id desde 99990001, nombre ZZ-E2E) en la copia local y los borra al
// final; deja como estaba el estado de la copia. No se conecta a GLPI.
// Pide E2E_PERMITIR=1. Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/glpi_tablero.e2e.js
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const ExcelJS = require('exceljs');

if (process.env.E2E_PERMITIR !== '1') {
  console.error('Esta prueba escribe (y luego borra) datos marcados en la base configurada. Ejecútela con E2E_PERMITIR=1.');
  process.exit(2);
}
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (name, cond) => results.push([!!cond, name]);

async function main() {
  const pool = require(path.join(ROOT, 'src/db/pool'));
  const stats = require(path.join(ROOT, 'src/services/glpiStatsService'));
  const dash = require(path.join(ROOT, 'src/services/dashboardService'));
  const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));
  const TAG = 'ZZ-E2E';
  const BASE_ID = 99990000;
  const SOURCES = ['glpi_computadoras', 'glpi_monitores', 'glpi_impresoras'];
  const [savedState] = await pool.query('SELECT * FROM external_sync_state WHERE source IN (?)', [SOURCES]);
  const [[{ realRows }]] = await pool.query('SELECT COUNT(*) AS realRows FROM glpi_assets WHERE glpi_id < ?', [BASE_ID]);
  const cleanup = async () => {
    await pool.query('DELETE FROM glpi_assets WHERE glpi_id > ?', [BASE_ID]);
    await pool.query('DELETE FROM dashboard_widgets WHERE title LIKE ?', [`${TAG}%`]);
  };
  const restoreState = async () => {
    await pool.query('DELETE FROM external_sync_state WHERE source IN (?)', [SOURCES]);
    for (const r of savedState) await pool.query('INSERT INTO external_sync_state SET ?', [r]);
  };
  await cleanup();
  const [savedAccess] = await pool.query("SELECT role, enabled FROM role_modules WHERE module = 'glpi_inventario'");
  const setAccess = (role, enabled) => pool.query('INSERT INTO role_modules (role, module, enabled) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)', [role, 'glpi_inventario', enabled]);
  const restoreAccess = async () => {
    await pool.query("DELETE FROM role_modules WHERE module = 'glpi_inventario'");
    for (const r of savedAccess) await setAccess(r.role, r.enabled);
  };

  // Equipos de prueba, con textos tal como los entrega GLPI.
  const PCS = [
    ['Lenovo', 'ThinkCentre M720s', 'Desktop', 'Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz', 'DDR4 - 2667 - DIMM', '16 GB', 'Root entity > SEDE PUEBLO LIBRE', 'Microsoft Windows 11 Pro'],
    ['Lenovo', 'ThinkCentre M720s', 'Desktop', 'Intel(R) Core(TM) i5-8500 CPU @ 3.00GHz', 'DDR4 - 2667 - DIMM, DDR4 - 2400 - DIMM', '8 GB', 'Root entity > SEDE PUEBLO LIBRE', 'Microsoft Windows 10 Pro'],
    ['HP', 'ProDesk 400', 'Desktop', 'Intel(R) Core(TM) i3-2100 CPU @ 3.10GHz', 'DDR3 - 1333 - DIMM', '4 GB', 'Root entity > SEDE-SURCO', 'Microsoft Windows 10 Pro'],
    ['Hewlett-Packard', 'Compaq 6200', 'Desktop', 'Intel(R) Core(TM) i5-3470 CPU @ 3.20GHz', 'DDR3 - 1600 - DIMM', '8 GB', 'Root entity > SEDE-SURCO', 'Microsoft Windows 10 Pro'],
    ['Dell Inc.', 'OptiPlex 3080', 'Mini PC', 'Intel(R) Core(TM) i3-10100 CPU @ 3.60GHz', 'DDR4 - 2667 - SODIMM', '8 GB', 'Root entity > SEDE YZAGUIRRE', 'Microsoft Windows 11 Pro'],
    ['ASUSTeK COMPUTER INC.', 'PRIME B550', 'Desktop', 'AMD Ryzen 5 5600GT with Radeon Graphics', 'DDR4 - 3200 - DIMM', '32 GB', 'Root entity > SEDE YZAGUIRRE', 'Microsoft Windows 11 Pro'],
    ['Micro-Star International Co., Ltd.', 'PRO B760', 'Desktop', '12th Gen Intel(R) Core(TM) i7-12700KF', 'DDR5 - 4800 - DIMM', '32 GB', 'Root entity > SEDE PUEBLO LIBRE', 'Microsoft Windows 11 Pro'],
    ['Microsoft Corporation', 'Virtual Machine', 'Hyper-V', 'Intel(R) Xeon(R) CPU E5-2698 v3 @ 2.30GHz', 'Hyper-V Memory', '12 GB', 'Root entity', 'Microsoft Windows Server 2019 Datacenter'],
    ['Lenovo', 'IdeaCentre', 'All in One', 'AMD A8-9600 RADEON R7, 10 COMPUTE CORES 4C+6G', 'DDR4 - 2133 - SODIMM', '8 GB', 'Root entity > SEDE MEGAPLAZA', 'Microsoft Windows 10 Home Single Language'],
    ['Lenovo', 'ThinkCentre M720s', 'Desktop', null, null, null, 'Root entity > SEDE PUEBLO LIBRE', null],
    ['HP', 'ProDesk 600', 'Desktop', 'Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz', 'DDR4 - 2667 - DIMM', '16 GB', 'Root entity > SEDE PUEBLO LIBRE', 'Microsoft Windows 11 Pro'],
    ['Lenovo', 'ThinkCentre M720s', 'Desktop', 'Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz', 'DDR4 - 2667 - DIMM', '8 GB', 'Root entity > SEDE-SURCO', 'Microsoft Windows 10 Pro'],
  ];
  const insert = async (type, rows) => {
    for (const [i, r] of rows.entries()) {
      const id = BASE_ID + (type === 'computadoras' ? 1 : type === 'monitores' ? 101 : 201) + i;
      await pool.query('INSERT INTO glpi_assets SET ?', [{ asset_type: type, glpi_id: id, name: `${TAG}-${type.slice(0, 3).toUpperCase()}-${String(i + 1).padStart(2, '0')}`,
        manufacturer: r[0], model: r[1], type: r[2], processor: r[3], memory_type: r[4], memory: r[5], entity: r[6], os: r[7], serial: `SN${id}`, user_name: i % 2 ? 'Ana Pérez' : 'Luis Gómez' }]);
    }
  };
  await insert('computadoras', PCS);
  await insert('monitores', [['Samsung', 'S24', 'LCD', null, null, null, 'Root entity > SEDE PUEBLO LIBRE', null], ['LG Electronics', '24MK', 'LCD', null, null, null, 'Root entity > SEDE-SURCO', null]]);
  for (const s of SOURCES) {
    await pool.query(`INSERT INTO external_sync_state (source, synced_at, row_count, last_error, last_attempt_at) VALUES (?, NOW(), 0, NULL, NOW())
      ON DUPLICATE KEY UPDATE synced_at = NOW(), last_error = NULL`, [s]);
  }

  const [[superadmin]] = await pool.query("SELECT id, email, full_name, role FROM users WHERE role = 'superadmin' AND active = 1 ORDER BY id LIMIT 1");
  let user = superadmin;
  const as = (role) => { user = { ...superadmin, role }; };
  const CSRF = 'token-de-prueba-glpi-tablero-0123456789abcdef01234567';
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'e2e', resave: false, saveUninitialized: true }));
  app.use(flash());
  app.use((req, res, next) => {
    req.session.user = user;
    req.session.csrfToken = CSRF;
    Object.assign(res.locals, { currentUser: user, realRole: user.role, csrfToken: CSRF, successMessages: req.flash('success'), errorMessages: req.flash('error'), currentPath: req.path,
      currentHost: req.hostname, appName: 'Prueba', enabledModules: new Proxy({}, { get: () => true }), mobileLabels });
    next();
  });
  app.use('/glpi', require(path.join(ROOT, 'src/routes/glpi')));
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
  const names = (html) => [...new Set([...html.matchAll(/ZZ-E2E-COM-(\d\d)/g)].map((m) => m[1]))].sort().join(',');
  const enc = encodeURIComponent;

  try {
    // ---------------- unidades ----------------
    const c1 = stats.cpuInfo('Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz');
    const c2 = stats.cpuInfo('12th Gen Intel(R) Core(TM) i7-12700KF');
    const c3 = stats.cpuInfo('AMD Ryzen 5 5600GT with Radeon Graphics');
    const c4 = stats.cpuInfo('Intel(R) Xeon(R) CPU E5-2698 v3 @ 2.30GHz');
    check('Procesador: familia, generación, modelo y año (Intel por número, por «12th Gen», AMD Ryzen, Xeon)', c1.family === 'Intel Core i7' && c1.generation === 'Intel Core 8.ª gen.' && c1.model === 'Core i7-8700' && c1.year === 2017
      && c2.generation === 'Intel Core 12.ª gen.' && c2.model === 'Core i7-12700KF' && stats.cpuInfo('Intel(R) Core(TM) i3-10100 CPU @ 3.60GHz').generation === 'Intel Core 10.ª gen.'
      && c3.family === 'AMD Ryzen 5' && c3.generation === 'AMD Ryzen serie 5000' && c4.generation === 'Intel Xeon E5 v3' && stats.cpuInfo(null).family === 'Sin dato');
    check('Windows 11: Intel desde la 8.ª gen. y Ryzen desde la serie 2000', c1.win11 === 'Sí' && c3.win11 === 'Sí' && c4.win11 === 'No' && stats.cpuInfo('Intel(R) Core(TM) i3-2100 CPU @ 3.10GHz').win11 === 'No'
      && stats.cpuInfo('AMD A8-9600 RADEON R7, 10 COMPUTE CORES 4C+6G').win11 === 'No');
    const yr = new Date().getFullYear();
    check('Antigüedad por año de la serie', stats.ageBucket(yr - 2) === 'Hasta 3 años' && stats.ageBucket(yr - 5) === '4 a 6 años' && stats.ageBucket(yr - 8) === '7 a 9 años'
      && stats.ageBucket(yr - 12) === '10 años o más' && stats.ageBucket(null) === 'Sin dato');
    const m1 = stats.memInfo('DDR4 - 2667 - DIMM, DDR4 - 2400 - DIMM');
    check('Memoria: tipo, formato, velocidad (la del módulo más lento) y módulos mezclados', m1.type === 'DDR4' && m1.form === 'DIMM (escritorio)' && m1.speed === 'DDR4-2400' && m1.mixed === 'Sí'
      && stats.memInfo('DDR4 - 2667 - SODIMM').form === 'SODIMM (portátil / mini PC)' && stats.memInfo('Hyper-V Memory').type === 'Virtual (Hyper-V)' && stats.memInfo('').type === 'Sin dato');
    check('Marca normalizada y sede sin «Root entity»', stats.brandOf('Dell Inc.') === 'Dell' && stats.brandOf('Hewlett-Packard') === 'HP' && stats.brandOf('ASUSTeK COMPUTER INC.') === 'ASUS'
      && stats.brandOf('Micro-Star International Co., Ltd.') === 'MSI' && stats.sedeOf('Root entity > SEDE-SURCO') === 'SEDE-SURCO' && stats.sedeOf('Root entity') === 'Entidad raíz');

    // ---------------- lista con filtros por columna ----------------
    let page = await get('/glpi/inventario?por=todos');
    check('Lista desde la copia local, con las columnas derivadas', page.status === 200 && page.text.includes('id="inv_origen"') && page.text.includes('Copia de GLPI del')
      && page.text.includes('>Generación del procesador</th>') && page.text.includes('>Tipo de memoria (DDR)</th>') && names(page.text).split(',').length >= 12);
    check('Cada columna trae su filtro: casillas con cantidades o texto «contiene»', page.text.includes('data-filtro="f_manufacturer"') && page.text.includes('data-filtro="f_cpu_generation"')
      && page.text.includes('data-filtro-texto="f_name"') && page.text.includes('data-filtro-texto="f_serial"') && /Intel Core 8\.ª gen\. \(\d+\)/.test(page.text)
      && page.text.includes('Tablero y estadísticas'));
    page = await get(`/glpi/inventario?por=todos&f_cpu_generation=${enc('Intel Core 8.ª gen.')}`);
    check('Filtrar por generación', names(page.text) === '01,02,11,12');
    page = await get(`/glpi/inventario?por=todos&f_mem_type=${enc('DDR3,DDR5')}`);
    check('Varias casillas marcadas en una columna', names(page.text) === '03,04,07');
    page = await get(`/glpi/inventario?por=todos&f_manufacturer=Lenovo&f_cpu_generation=${enc('Intel Core 8.ª gen.')}`);
    check('Filtros en varias columnas a la vez', names(page.text) === '01,02,12' && page.text.includes('2 filtro(s) de columna') && page.text.includes('id="inv_quitar_filtros"'));
    const comma = stats.keyOf('AMD A8-9600 RADEON R7, 10 COMPUTE CORES 4C+6G');
    page = await get(`/glpi/inventario?por=todos&f_processor=${enc(comma)}`);
    check('Un valor que tiene coma también se filtra bien', !comma.includes(',') && names(page.text) === '09');
    page = await get(`/glpi/inventario?por=todos&f_name=${enc('COM-0')}&q=${enc('ana pérez')}`);
    check('Texto «contiene» y búsqueda general juntos (sin distinguir tildes)', names(page.text) === '02,04,06,08');
    page = await get(`/glpi/inventario?por=todos&f_cpu_generation=${enc('(vacío)')}`);
    page = await get(`/glpi/inventario?por=todos&f_cpu_generation=${enc('Sin dato')}`);
    check('Equipos sin procesador registrado: grupo «Sin dato»', names(page.text) === '10');
    page = await get(`/glpi/inventario?por=10&f_manufacturer=Lenovo&orden=memory&dir=desc`);
    check('Orden por memoria (numérico) y la paginación conserva los filtros', page.text.indexOf('ZZ-E2E-COM-01') < page.text.indexOf('ZZ-E2E-COM-02')
      && (page.text.includes('f_manufacturer=Lenovo') || page.text.includes('Página 1 de 1') || !page.text.includes('Página')));
    const big = await get('/glpi/inventario?por=10&f_name=ZZ-E2E');
    check('Paginación con filtro: los enlaces de página llevan el filtro', big.text.includes('Página 1 de 2') && big.text.includes('f_name=ZZ-E2E') && /href="[^"]*page=2[^"]*f_name=ZZ-E2E|href="[^"]*f_name=ZZ-E2E[^"]*page=2/.test(big.text));
    const x = await fetch(`${base}/glpi/inventario/exportar.xlsx?f_mem_type=DDR3`, { headers: { cookie } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await x.arrayBuffer()));
    const sh = wb.worksheets[0];
    const head = sh.getRow(1).values.slice(1);
    const exported = [];
    sh.eachRow((r, i) => { if (i > 1) exported.push(String(r.getCell(head.indexOf('Nombre') + 1).value)); });
    check('Excel: solo lo filtrado, con las columnas derivadas', x.status === 200 && exported.filter((n) => n.startsWith(TAG)).sort().join() === 'ZZ-E2E-COM-03,ZZ-E2E-COM-04'
      && head.includes('Generación del procesador') && head.includes('Tipo de memoria (DDR)'));
    page = await get('/glpi/inventario?tipo=monitores');
    check('Monitores también desde la copia, con filtros', page.text.includes('ZZ-E2E-MON-01') && page.text.includes('data-filtro="f_manufacturer"') && !page.text.includes('Generación del procesador'));

    // ---------------- tablero ----------------
    page = await get('/glpi/inventario/tablero');
    check('Tablero: abre con indicadores y los widgets predefinidos', page.status === 200 && page.text.includes('id="tablero_indicadores"') && page.text.includes('Tablero del inventario GLPI')
      && ['Computadoras por generación del procesador', 'Computadoras por familia de procesador', 'Antigüedad del procesador (para renovar)', 'Procesador compatible con Windows 11',
        'Computadoras por marca', 'Tipo de memoria (DDR)', 'Memoria total por equipo', 'Monitores por marca'].every((t) => page.text.includes(t)) && !page.text.includes('tablero_decisiones'));
    const board = await dash.board(superadmin, 'glpi');
    const preset = (t) => board.presets.find((p) => p.config.title === t).result;
    const gen = preset('Computadoras por generación del procesador');
    const g8 = gen.items.find((i) => i.label === 'Intel Core 8.ª gen.');
    check('Cálculo: generaciones (incluye los equipos de prueba)', g8 && g8.count >= 4 && gen.total >= 12);
    const kp = board.kpis;
    check('Indicadores: total, no compatibles con Windows 11, de 10 años o más y DDR3, con su enlace', kp.length === 4 && kp[0].value >= 12 && kp[1].value >= 4 && kp[2].value >= 3 && kp[3].value >= 2
      && kp[1].href.startsWith('/glpi/inventario/tablero/detalle?') && kp[1].href.includes('groupBy=win11'));
    const brands = preset('Computadoras por marca');
    check('Marcas agrupadas ya normalizadas (HP junta «HP» y «Hewlett-Packard»)', (brands.items.find((i) => i.label === 'HP') || {}).count >= 3 && !brands.items.some((i) => i.label === 'Hewlett-Packard'));
    const det = await get(kp[1].href);
    check('Detalle de una cifra: la lista de equipos, con enlace a cada uno', det.status === 200 && ['03', '04', '08', '09'].every((n) => det.text.includes(`ZZ-E2E-COM-${n}`)) && !det.text.includes('ZZ-E2E-COM-01')
      && det.text.includes(`/glpi/inventario/${BASE_ID + 3}`) && det.text.includes('href="/glpi/inventario/tablero"'));
    const dx = await fetch(`${base}${kp[1].href.replace('/tablero/detalle?', '/tablero/detalle.xlsx?')}`, { headers: { cookie } });
    check('Detalle a Excel', dx.status === 200 && /tablero_glpi_/.test(dx.headers.get('content-disposition') || ''));

    // ---------------- widgets propios ----------------
    await post('/glpi/inventario/tablero/widgets', { title: `${TAG} Lenovo por generación`, dataset: 'glpi_computadoras', groupBy: 'cpu_generacion', metric: 'cantidad', chart: 'tabla', top: '10',
      filter_field: 'marca', filter_value: 'Lenovo' });
    page = await get('/glpi/inventario/tablero');
    const own = (await dash.board(superadmin, 'glpi')).custom.find((w) => w.config.title === `${TAG} Lenovo por generación`);
    check('Widget propio: se arma con un filtro y aparece en el tablero', page.text.includes(`${TAG} Lenovo por generación`) && own
      && own.result.items.some((i) => i.label === 'Intel Core 8.ª gen.' && i.count >= 3) && !own.result.items.some((i) => i.label === 'Intel Core 10.ª gen.'));
    check('Los tableros no se mezclan: el widget no aparece en el de celulares', !(await dash.board(superadmin, 'celulares')).custom.some((w) => w.config.title === `${TAG} Lenovo por generación`));
    await post('/glpi/inventario/tablero/widgets', { title: `${TAG} Intruso`, dataset: 'celulares', groupBy: 'marca', metric: 'cantidad', chart: 'barras', top: '5' });
    check('En el tablero GLPI no se aceptan datos de celulares', !(await pool.query('SELECT id FROM dashboard_widgets WHERE title = ?', [`${TAG} Intruso`]))[0].length);
    check('El formulario ofrece solo los datos del inventario', page.text.includes('"glpi_computadoras"') && !page.text.includes('"chips":'));
    const [[w]] = await pool.query('SELECT id FROM dashboard_widgets WHERE title = ?', [`${TAG} Lenovo por generación`]);
    await post(`/glpi/inventario/tablero/widgets/${w.id}/quitar`);
    check('Quitar un widget propio', !(await pool.query('SELECT id FROM dashboard_widgets WHERE id = ?', [w.id]))[0].length);

    // ---------------- permisos ----------------
    await setAccess('lector', 0);
    as('lector');
    check('Sin acceso al módulo Inventario GLPI: no entra al tablero ni a la lista', (await get('/glpi/inventario/tablero')).location === '/' && (await get('/glpi/inventario')).location === '/'
      && (await get(kp[1].href)).location === '/');
    await setAccess('lector', 1);
    await post('/glpi/inventario/tablero/widgets', { title: `${TAG} Del lector`, dataset: 'glpi_computadoras', groupBy: 'marca', metric: 'cantidad', chart: 'barras', top: '5', shared: '1' });
    const [[mine]] = await pool.query('SELECT shared FROM dashboard_widgets WHERE title = ?', [`${TAG} Del lector`]);
    check('Lector con acceso: ve el tablero y arma widgets para sí (no compartidos)', (await get('/glpi/inventario/tablero')).status === 200 && mine && mine.shared === 0);
    as('superadmin');

    // ---------------- sin copia local ----------------
    await pool.query("UPDATE external_sync_state SET synced_at = NULL WHERE source = 'glpi_impresoras'");
    check('Sin copia de un tipo, el tablero lo avisa', (await get('/glpi/inventario/tablero')).text.includes('Todavía no hay copia local de impresoras'));
    check('Datos reales intactos', (await pool.query('SELECT COUNT(*) AS n FROM glpi_assets WHERE glpi_id < ?', [BASE_ID]))[0][0].n === realRows);
  } finally {
    await cleanup().catch((e) => console.error('limpieza:', e.message));
    await restoreState().catch((e) => console.error('estado:', e.message));
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
