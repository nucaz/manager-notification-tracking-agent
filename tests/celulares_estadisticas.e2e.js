// Prueba de extremo a extremo de:
//   - Estadísticas de celulares (cuotas del recibo, respaldo de compra,
//     cobrados sin registrar, datos que faltan)
//   - completar marca y modelo desde el recibo
//   - catálogo de modelos por marca y el formulario que filtra por marca
//   - columnas nuevas del listado de celulares y "En recibo" en chips
//
// Datos marcados que se borran al final (IMEI 99000000000003x, números
// 9000003xx, operadora PRUEBA-EST, marca PruebaMarca). Pide E2E_PERMITIR=1.
//
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/celulares_estadisticas.e2e.js
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
const pool = require(path.join(ROOT, 'src/db/pool'));
const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));
const billing = require(path.join(ROOT, 'src/services/deviceBillingService'));
const statsService = require(path.join(ROOT, 'src/services/deviceStatsService'));
const modelService = require(path.join(ROOT, 'src/services/mobileModelService'));

const IMEI = ['990000000000031', '990000000000032', '990000000000033', '990000000000034', '990000000000035'];
const FUERA = '990000000000039'; // cobrado por el recibo y no registrado
const N = ['900000331', '900000332'];
const OP = 'PRUEBA-EST';
const MARCA = 'PruebaMarca';
const AREA = 'PRUEBA-EST';
const results = [];
const check = (name, cond) => results.push([!!cond, name]);
const q = async (sql, params) => (await pool.query(sql, params))[0];

async function cleanup() {
  await q('DELETE FROM attachments WHERE entity_type = ? AND entity_id IN (SELECT id FROM mobile_devices WHERE imei IN (?))', ['mobile_device', IMEI]);
  await q('DELETE FROM mobile_lines WHERE phone_number IN (?)', [N]);
  await q('DELETE FROM mobile_devices WHERE imei IN (?)', [IMEI]);
  await q('DELETE FROM mobile_bills WHERE operadora = ?', [OP]);
  await q('DELETE FROM mobile_models WHERE brand = ?', [MARCA]);
  await q("DELETE FROM catalog_items WHERE catalog_type = 'marca' AND value = ?", [MARCA]);
  await q("DELETE FROM audit_log WHERE action = 'celulares_modelo_desde_recibo' AND created_at > NOW() - INTERVAL 10 MINUTE");
}

async function main() {
  const [admin] = await q("SELECT id, email, full_name, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  await cleanup();
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'e2e', resave: false, saveUninitialized: true }));
  app.use(flash());
  const CSRF = 'token-de-prueba-e2e-0123456789abcdef0123456789abcdef';
  app.use((req, res, next) => {
    req.session.user = admin;
    req.session.csrfToken = CSRF;
    Object.assign(res.locals, { currentUser: admin, csrfToken: CSRF, successMessages: req.flash('success'), errorMessages: req.flash('error'),
      currentPath: req.path, currentHost: req.hostname, appName: 'Prueba', enabledModules: new Proxy({}, { get: () => true }), mobileLabels });
    next();
  });
  app.use('/celulares/chips', require(path.join(ROOT, 'src/routes/mobileLines')));
  app.use('/celulares', require(path.join(ROOT, 'src/routes/mobileDevices')));
  app.use('/configuracion/catalogos', require(path.join(ROOT, 'src/routes/catalogs')));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const keep = (r) => { const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return r; };
  const get = async (u) => (keep(await fetch(base + u, { headers: { cookie } }))).text();
  const post = async (u, form) => {
    const body = new URLSearchParams({ _csrf: CSRF });
    Object.entries(form).forEach(([k, v]) => (Array.isArray(v) ? v : [v]).forEach((x) => body.append(k, x)));
    const r = keep(await fetch(base + u, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }));
    return { status: r.status, location: r.headers.get('location') };
  };

  try {
    // --- Catalogo de modelos por marca
    await q("INSERT INTO catalog_items (catalog_type, value) VALUES ('marca', ?)", [MARCA]);
    let r = await post('/configuracion/catalogos/modelos/nuevo', { brand: MARCA, model: 'PX9' });
    await post('/configuracion/catalogos/modelos/nuevo', { brand: MARCA, model: 'PX9 Max' });
    let page = await get('/configuracion/catalogos?tipo=modelo');
    check('Catálogo: se agregan modelos ligados a su marca y se listan con cuántos celulares los usan', r.status === 302 && page.includes('id="modelos_por_marca"')
      && page.includes('<td>PX9</td>') && page.includes('<td>PX9 Max</td>') && page.includes(`<option value="${MARCA}">`));
    await post('/configuracion/catalogos/modelos/nuevo', { brand: MARCA, model: 'PX9' });
    page = await get('/configuracion/catalogos?tipo=modelo');
    check('Un modelo repetido o con caracteres no válidos se rechaza', page.includes('ya está en el catálogo')
      && (await q('SELECT COUNT(*) AS n FROM mobile_models WHERE brand = ? AND model = ?', [MARCA, 'PX9']))[0].n === 1);
    await post('/configuracion/catalogos/modelos/nuevo', { brand: MARCA, model: 'PX9<script>' });
    check('Modelo con caracteres no permitidos: no se guarda', (await q('SELECT COUNT(*) AS n FROM mobile_models WHERE brand = ?', [MARCA]))[0].n === 2);
    const [px] = await q('SELECT id FROM mobile_models WHERE brand = ? AND model = ?', [MARCA, 'PX9 Max']);
    await post(`/configuracion/catalogos/modelos/${px.id}/activar`, { active: '0' });
    check('Un modelo se puede desactivar', (await q('SELECT active FROM mobile_models WHERE id = ?', [px.id]))[0].active === 0);
    await post(`/configuracion/catalogos/modelos/${px.id}/activar`, { active: '1' });
    const migrated = await q("SELECT COUNT(*) AS n FROM mobile_models WHERE brand <> ?", [MARCA]);
    check('La migración trajo los pares marca/modelo que ya usaban los celulares', migrated[0].n >= 1);

    // --- Formulario del celular: modelos de la marca elegida
    page = await get('/celulares/nuevo');
    check('Formulario del celular: cada modelo lleva su marca y se filtra al elegir la marca', page.includes(`<option value="PX9" data-marca="${MARCA}"`)
      && page.includes("brand.addEventListener('change', sync)"));

    // --- Datos: celulares con y sin respaldo, y un recibo con cuotas
    await q('INSERT INTO mobile_devices (imei, asset_code, brand, model, area, status, has_chip, phone_number, purchase_date) VALUES (?), (?), (?), (?), (?)', [
      [IMEI[0], 'A-90031', MARCA, 'PX9', AREA, 'asignado', 1, N[0], null], [IMEI[1], 'A-90032', null, null, AREA, 'en_stock', 1, N[1], null],
      [IMEI[2], null, null, null, AREA, 'asignado', 0, null, '2026-01-15'], [IMEI[3], 'A-90034', 'OtraMarca', null, AREA, 'asignado', 0, null, null],
      [IMEI[4], 'A-90035', null, 'Viejo1', AREA, 'asignado', 0, null, null]]);
    const dev = async (imei) => (await q('SELECT * FROM mobile_devices WHERE imei = ?', [imei]))[0];
    const D4 = await dev(IMEI[3]);
    await q("INSERT INTO attachments (entity_type, entity_id, doc_type, original_name, stored_path, mime_type, size_bytes) VALUES ('mobile_device', ?, 'contrato', 'c.pdf', 'x/c.pdf', 'application/pdf', 1)", [(await dev(IMEI[2])).id]);
    await q('INSERT INTO mobile_lines (phone_number, operadora, device_id) VALUES (?, ?, ?), (?, ?, ?)', [N[0], OP, (await dev(IMEI[0])).id, N[1], OP, (await dev(IMEI[1])).id]);
    const bill = await q("INSERT INTO mobile_bills (operadora, recibo_nro, fecha_emision, total_pagar, origen) VALUES (?, 'EST-0001', '2026-09-30', 0, 'excel')", [OP]);
    await q('INSERT INTO mobile_bill_lines (bill_id, phone_number, plan, cargo_fijo, monto_total) VALUES (?, ?, ?, ?, ?)', [bill.insertId, N[0], 'Plan', 20, 20]);
    await q('INSERT INTO mobile_bill_charges (bill_id, descripcion, imei, modelo, cuota_nro, cuota_total, monto) VALUES ?', [[
      [bill.insertId, 'Cuota equipo', IMEI[0], `${MARCA.toUpperCase()} FONE PX9 128GB NEGRO`, 5, 18, 45.9],
      [bill.insertId, 'Cuota equipo', IMEI[1], `${MARCA.toUpperCase()} FONE PX9 MAX 256GB`, 18, 18, 60],
      [bill.insertId, 'Cuota equipo', IMEI[3], `${MARCA.toUpperCase()} FONE PX9 128GB`, 2, 12, 30],
      [bill.insertId, 'Cuota equipo', IMEI[4], `${MARCA.toUpperCase()} FONE PX9 128GB`, 1, 12, 30],
      [bill.insertId, 'Cuota equipo', FUERA, 'ZTE BLADE A76', 3, 18, 39.9]]]);

    // --- Datos del recibo por celular
    const deco = await billing.decorate(await q('SELECT * FROM mobile_devices WHERE imei IN (?) ORDER BY imei', [IMEI]));
    const of = (imei) => deco.find((d) => d.imei === imei);
    check('Equipo en cuotas: cuota n de m y monto al mes del último recibo', of(IMEI[0]).equipo_recibo === 'Cuota 5 de 18 · S/ 45.90' && of(IMEI[2]).equipo_recibo === 'No');
    check('Línea en recibo: Sí / No / Sin número', of(IMEI[0]).linea_recibo === 'Sí' && of(IMEI[1]).linea_recibo === 'No' && of(IMEI[2]).linea_recibo === 'Sin número');
    check('Respaldo de compra: recibo, fecha de compra, contrato adjunto o ninguno', of(IMEI[0]).respaldo === 'recibo' && of(IMEI[2]).respaldo === 'compra'
      && (await billing.decorate([{ ...of(IMEI[2]), purchase_date: null }]))[0].respaldo === 'documento');

    // --- Estadisticas
    const s = await statsService.stats();
    const mine = s.rows.filter((d) => IMEI.includes(d.imei));
    check('Cuotas: cuántos equipos se pagan en cuotas y cuánto al mes (incluye los de prueba)', s.cuotas.count >= 4 && s.cuotas.monthly >= 165.8
      && mine.filter((d) => d.cuota).length === 4);
    check('En cuotas y sin usuario: el equipo en stock que se sigue pagando', s.cuotas.sinUsuario >= 1 && s.cuotas.sinUsuarioMonthly >= 60);
    check('En su última cuota', s.cuotas.ultimas >= 1);
    check('Cobrados y no registrados: el IMEI que el recibo cobra y no está en Celulares', s.unregistered.items.some((c) => c.imei === FUERA && c.monto === 39.9));
    check('Datos que faltan: sin marca, sin modelo, sin código y sin respaldo', s.quality.sinMarca >= 3 && s.quality.sinModelo >= 3 && s.quality.sinCodigo >= 1);
    // --- Completar desde el recibo
    const sug = s.suggestions.items.filter((i) => IMEI.includes(i.imei));
    const sOf = (imei) => sug.find((i) => i.imei === imei);
    check('Sugerencia: marca y modelo del recibo cuando el modelo está en el catálogo (el más largo que coincide)', sOf(IMEI[1]) && sOf(IMEI[1]).brand === MARCA
      && sOf(IMEI[1]).model === 'PX9 Max');
    check('No sugiere si el celular ya tiene otra marca, y solo completa lo vacío', !sOf(IMEI[3]) && s.suggestions.unknown.some((u) => u.imei === IMEI[3])
      && sOf(IMEI[4]) && sOf(IMEI[4]).model === null && sOf(IMEI[4]).brand === MARCA);
    check('Con un modelo que no está en el catálogo no adivina', modelService.matchDescription('APPLE IPHONE 17 PROMX 256GB', [{ brand: 'Apple', model: 'iPhone 17 Pro' }]) === null
      && modelService.matchDescription('APPLE IPHONE 17 PRO MAX 256GB', [{ brand: 'Apple', model: 'iPhone 17 Pro' }, { brand: 'Apple', model: 'iPhone 17 Pro Max' }]).model === 'iPhone 17 Pro Max');
    r = await post('/celulares/estadisticas/completar-modelos', { ids: [String(sOf(IMEI[1]).id), String(sOf(IMEI[4]).id)] });
    const d2 = await dev(IMEI[1]);
    const d5 = await dev(IMEI[4]);
    check('Completar: llena marca y modelo vacíos y respeta el modelo ya cargado', r.status === 302 && d2.brand === MARCA && d2.model === 'PX9 Max' && d5.brand === MARCA && d5.model === 'Viejo1'
      && (await dev(IMEI[3])).brand === 'OtraMarca');
    const [log] = await q("SELECT detail FROM audit_log WHERE action = 'celulares_modelo_desde_recibo' ORDER BY id DESC LIMIT 1");
    check('Queda en la auditoría', log && log.detail.includes('A-90032'));

    page = await get('/celulares/estadisticas');
    check('Pantalla de estadísticas: totales, cuotas, sin usuario, cobrados sin registrar, datos faltantes y desgloses', page.includes('id="estadisticas_resumen"')
      && page.includes('Equipos en cuotas (recibo)') && page.includes('Cobrados y no registrados') && page.includes(FUERA) && page.includes('id="calidad_datos"')
      && page.includes('id="por_respaldo"') && page.includes('id="por_modelo"'));
    const x = await fetch(`${base}/celulares/estadisticas/exportar.xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await x.arrayBuffer()));
    let row0 = null;
    wb.getWorksheet('Celulares').eachRow((rw) => { if (rw.values.includes(IMEI[0])) row0 = rw.values; });
    check('Excel de estadísticas: resumen, celulares con sus datos del recibo, y cobrados sin registrar', x.status === 200
      && wb.worksheets.map((w) => w.name).join() === 'Resumen,Celulares,Cobrados sin registrar' && row0 && row0.includes('Cuota 5 de 18 · S/ 45.90') && row0.includes('En cuotas (recibo)'));

    // --- Listados
    page = await get(`/celulares?area=${AREA}`);
    check('Listado de celulares: columnas Marca, Equipo en recibo, Línea en recibo y Respaldo (para filtrar)', page.includes('<th data-col="marca">Marca</th>')
      && page.includes('<th data-col="cuota">Equipo en recibo</th>') && page.includes('Cuota 5 de 18 · S/ 45.90') && page.includes('Fecha de compra')
      && page.includes('href="/celulares/estadisticas"'));
    page = await get(`/celulares/chips?q=9000003`);
    check('Listado de chips: columna "En recibo"', page.includes('<th>En recibo</th>') && /900000331[\s\S]*?<td>Sí<\/td>/.test(page) && /900000332[\s\S]*?<td>No<\/td>/.test(page));
  } finally {
    server.close();
    await cleanup();
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
