// Prueba de extremo a extremo del Tablero de celulares y chips: indicadores
// para decidir, widgets predefinidos, widgets propios y compartidos, y la
// columna "Chips" (doble SIM) del listado.
//
// Datos marcados que se borran al final (IMEI 99000000000002x, números
// 9000002xx, área PRUEBA-<b>TAB). Pide E2E_PERMITIR=1.
//
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/celulares_tablero.e2e.js
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

if (process.env.E2E_PERMITIR !== '1') {
  console.error('Esta prueba escribe (y luego borra) datos marcados en la base configurada. Ejecútela con E2E_PERMITIR=1.');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const pool = require(path.join(ROOT, 'src/db/pool'));
const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));
const dashboard = require(path.join(ROOT, 'src/services/dashboardService'));

const IMEI = ['990000000000021', '990000000000022'];
const N = ['900000221', '900000222', '900000223'];
const AREA = 'PRUEBA-<b>TAB';
const results = [];
const check = (name, cond) => results.push([!!cond, name]);
const q = async (sql, params) => (await pool.query(sql, params))[0];

async function cleanup() {
  await q('DELETE FROM mobile_lines WHERE phone_number IN (?)', [N]);
  await q('DELETE FROM mobile_devices WHERE imei IN (?)', [IMEI]);
  await q("DELETE FROM users WHERE email IN ('tablero-editor@prueba.invalid', 'tablero-lector@prueba.invalid')");
}

async function main() {
  const [admin] = await q("SELECT id, email, full_name, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  await cleanup();
  const mk = async (email, role) => ({ id: (await q("INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, 'x', ?)", [email, email, role])).insertId, email, full_name: email, role });
  const editor = await mk('tablero-editor@prueba.invalid', 'editor');
  const lector = await mk('tablero-lector@prueba.invalid', 'lector');

  let user = admin;
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'e2e', resave: false, saveUninitialized: true }));
  app.use(flash());
  const CSRF = 'token-de-prueba-e2e-0123456789abcdef0123456789abcdef';
  app.use((req, res, next) => {
    req.session.user = user;
    req.session.csrfToken = CSRF;
    Object.assign(res.locals, { currentUser: user, csrfToken: CSRF, successMessages: req.flash('success'), errorMessages: req.flash('error'),
      currentPath: req.path, currentHost: req.hostname, appName: 'Prueba', enabledModules: new Proxy({}, { get: () => true }), mobileLabels });
    next();
  });
  app.use('/celulares', require(path.join(ROOT, 'src/routes/mobileDevices')));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const keep = (r) => { const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return r; };
  const get = async (u) => (keep(await fetch(base + u, { headers: { cookie } }))).text();
  const post = async (u, form) => keep(await fetch(base + u, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: CSRF, ...form }).toString() }));

  try {
    // --- Validacion y calculo de widgets
    const bad = (c) => { try { dashboard.validate(c); return false; } catch (_) { return true; } };
    check('Un widget solo acepta datos, campos, medidas y filtros del catálogo', bad({ dataset: 'usuarios', groupBy: 'x', metric: 'cantidad' })
      && bad({ dataset: 'celulares', groupBy: 'password', metric: 'cantidad' }) && bad({ dataset: 'celulares', groupBy: 'marca', metric: 'sum(costo)' })
      && bad({ dataset: 'chips', groupBy: 'sede', metric: 'cantidad', filter: { field: 'drop table', value: 'x' } })
      && !bad({ dataset: 'chips', groupBy: 'sede', metric: 'costo', filter: { field: 'operadora', value: 'Entel' } }));
    const v = dashboard.validate({ dataset: 'celulares', groupBy: 'marca', metric: 'cantidad', top: 999, chart: 'pastel' });
    check('Tope de filas entre 3 y 50; gráfico desconocido pasa a barras; título por defecto', v.top === 50 && v.chart === 'barras' && v.title === 'Celulares por marca');
    const rows = [{ k: 'A', _costo: 10 }, { k: 'A', _costo: 5 }, { k: 'B', _costo: 1 }, { k: 'C', _costo: 2 }, { k: 'D', _costo: 3 }];
    const c1 = dashboard.compute({ groupBy: 'k', metric: 'cantidad', top: 3 }, rows);
    const c2 = dashboard.compute({ groupBy: 'k', metric: 'costo', top: 3 }, rows);
    check('Cálculo: cantidades ordenadas, "Otros" con el resto, y sumas de montos', c1.items[0].label === 'A' && c1.items[0].value === 2 && c1.items[3].label === 'Otros (1)'
      && c1.total === 5 && c2.money && c2.items[0].value === 15 && c2.total === 21);
    check('Fin de cuotas por tramos', dashboard.tramoCuotas(0).startsWith('Última') && dashboard.tramoCuotas(2) === 'Termina en 1 a 3 meses' && dashboard.tramoCuotas(null) === 'Sin cuotas en el recibo');

    // --- Datos: un celular con 2 chips y otro sin chip
    await q('INSERT INTO mobile_devices (imei, asset_code, brand, model, area, sede, status, has_chip, phone_number) VALUES (?), (?)',
      [[IMEI[0], 'A-90021', 'ZTE', 'A76', AREA, 'SEDE TAB', 'asignado', 1, N[0]], [IMEI[1], 'A-90022', 'ZTE', 'A76', AREA, 'SEDE TAB', 'en_stock', 0, null]]);
    const [d1] = await q('SELECT id FROM mobile_devices WHERE imei = ?', [IMEI[0]]);
    await q('INSERT INTO mobile_device_assignments (device_id, holder_name, assigned_date) VALUES (?, ?, CURDATE())', [d1.id, 'Persona Tablero']);
    await q('INSERT INTO mobile_lines (phone_number, operadora, costo_plan, device_id) VALUES (?, ?, 20, ?), (?, ?, 15, ?), (?, ?, 10, NULL)',
      [N[0], 'Entel', d1.id, N[1], 'Entel', d1.id, N[2], 'Entel']);

    const board = await dashboard.board(admin);
    const preset = (t) => board.presets.find((p) => p.config.title === t);
    const [[cnt]] = await pool.query('SELECT COUNT(*) AS n FROM mobile_devices');
    const [[chipCnt]] = await pool.query('SELECT COUNT(*) AS n FROM mobile_lines');
    check('Predefinidos: celulares por marca, por chips, por sede, fin de cuotas, chips por sede, uso real, áreas, personas y stock por modelo',
      board.presets.length === 9 && preset('Celulares por marca').result.total === cnt.n && preset('Chips por sede').result.total === chipCnt.n);
    check('"Celulares por cantidad de chips" cuenta los doble SIM', preset('Celulares por cantidad de chips').result.items.some((i) => i.label === '2 chips (doble SIM)' && i.value >= 1));
    const personas = dashboard.compute({ ...preset('Personas con más chips').config, top: 100000 }, await dashboard.DATASETS.chips.rows());
    check('"Personas con más chips" suma los chips de cada persona (los 2 de su celular)', preset('Personas con más chips').result.items.length >= 1
      && personas.items.some((i) => i.label === 'Persona Tablero' && i.value === 2));
    check('"Áreas con chips" usa el costo mensual de los chips en uso', preset('Áreas con chips (costo mensual)').result.items.some((i) => i.label === AREA && i.value === 35));
    check('Indicadores para decidir: stock, renovación, chips guardados, doble SIM', board.decisions.stock.count >= 1 && board.decisions.dobleSim >= 1
      && board.decisions.guardados.count >= 1 && typeof board.decisions.renovar.count === 'number');

    // --- Pantalla
    let page = await get('/celulares/tablero');
    check('Pantalla del tablero: indicadores, widgets predefinidos y formulario para armar uno', page.includes('id="tablero_decisiones"') && page.includes('Celulares por marca')
      && page.includes('class="dona"') && page.includes('class="barras"') && page.includes('id="form_widget"'));
    check('Los valores de los filtros van escapados dentro del script (sin HTML inyectable)', page.includes('PRUEBA-\\u003cb>TAB') && !/var VALUES = [^\n]*<b>TAB/.test(page));

    // --- Widgets propios y compartidos
    let r = await post('/celulares/tablero/widgets', { title: 'A76 por sede', dataset: 'celulares', groupBy: 'sede', metric: 'cantidad', chart: 'tabla', top: '10',
      filter_field: 'modelo', filter_value: 'ZTE A76', shared: '1' });
    const [w1] = await q("SELECT * FROM dashboard_widgets WHERE title = 'A76 por sede' AND user_id = ?", [admin.id]);
    check('Crear un widget (admin, compartido): queda guardado con su configuración', r.status === 302 && w1 && w1.shared === 1 && JSON.parse(w1.config).filter.value === 'ZTE A76');
    page = await get('/celulares/tablero');
    check('El widget propio se muestra con su resultado', page.includes('A76 por sede') && page.includes('SEDE TAB') && page.includes('Compartido'));
    await post('/celulares/tablero/widgets', { dataset: 'celulares', groupBy: 'no-existe', metric: 'cantidad' });
    page = await get('/celulares/tablero');
    check('Un widget mal armado se rechaza con explicación', page.includes('Elija por qué campo agrupar'));

    user = lector;
    cookie = '';
    await post('/celulares/tablero/widgets', { title: 'Mío del lector', dataset: 'chips', groupBy: 'operadora', metric: 'costo', chart: 'barras', top: '5', shared: '1' });
    const [w2] = await q("SELECT * FROM dashboard_widgets WHERE title = 'Mío del lector'", []);
    check('Un lector puede armar widgets para sí, pero no compartirlos', w2 && w2.shared === 0);
    page = await get('/celulares/tablero');
    check('El lector ve el widget compartido del admin y el suyo', page.includes('A76 por sede') && page.includes('Mío del lector'));
    r = await post(`/celulares/tablero/widgets/${w1.id}/quitar`, {});
    check('Nadie quita un widget ajeno', (await q('SELECT COUNT(*) AS n FROM dashboard_widgets WHERE id = ?', [w1.id]))[0].n === 1);

    user = editor;
    cookie = '';
    page = await get('/celulares/tablero');
    check('Otro usuario no ve el widget personal del lector', page.includes('A76 por sede') && !page.includes('Mío del lector'));
    user = admin;
    cookie = '';
    await post(`/celulares/tablero/widgets/${w2.id}/quitar`, {});
    check('Ni siquiera un admin quita un widget personal ajeno', (await q('SELECT COUNT(*) AS n FROM dashboard_widgets WHERE id = ?', [w2.id]))[0].n === 1);
    await post(`/celulares/tablero/widgets/${w1.id}/quitar`, {});
    check('Quien lo creó lo quita', (await q('SELECT COUNT(*) AS n FROM dashboard_widgets WHERE id = ?', [w1.id]))[0].n === 0);

    // --- Listado: columna Chips
    page = await get(`/celulares?area=${encodeURIComponent(AREA)}`);
    check('Listado de celulares: columna "Chips" para filtrar los de doble SIM', page.includes('<th data-col="chips">Chips</th>') && page.includes('<td data-col="chips">2 (doble SIM)</td>')
      && page.includes('<td data-col="chips">Sin chip</td>') && page.includes('href="/celulares/tablero"'));
  } finally {
    server.close();
    await cleanup(); // los widgets de los usuarios de prueba se borran con ellos
    await q("DELETE FROM dashboard_widgets WHERE title = 'A76 por sede'");
    check('Limpieza: no quedan datos de prueba', (await q('SELECT COUNT(*) AS n FROM mobile_devices WHERE imei IN (?)', [IMEI]))[0].n === 0);
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
