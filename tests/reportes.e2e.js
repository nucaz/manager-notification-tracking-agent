// Prueba de extremo a extremo de Reportes y del panel principal:
//   - contadores de GLPI (computadoras, monitores, impresoras) en el panel
//   - reportes de celulares, chips, GLPI y repositorios (DevOps sidecar)
//   - exportacion a Excel, CSV y PDF con codigo de barras
//
// Monta las rutas REALES en una mini-app con sesion de administrador
// simulada, contra un GLPI y un sidecar SIMULADOS (la configuracion se
// reemplaza en memoria). Los celulares y chips si se escriben en la base
// configurada, marcados (IMEI 99000000000008x, numeros 9000008xx, area
// PRUEBA-REPORTES) y se borran al final. Por eso pide E2E_PERMITIR=1.
//
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/reportes.e2e.js
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const pool = require(path.join(ROOT, 'src/db/pool'));
const settingsService = require(path.join(ROOT, 'src/services/settingsService'));
const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));
const { code128, _symbols } = require(path.join(ROOT, 'src/services/barcode'));
const { extractLines } = require(path.join(ROOT, 'src/services/mobileBillParsers/pdfText'));

if (process.env.E2E_PERMITIR !== '1') {
  console.error('Esta prueba escribe (y luego borra) datos marcados en la base configurada. Ejecútela con E2E_PERMITIR=1.');
  process.exit(2);
}

const IMEI = ['990000000000081', '990000000000082', '990000000000083'];
const N = ['900000881', '900000882'];
const AREA = 'PRUEBA-REPORTES';
const results = [];
const check = (name, cond) => results.push([!!cond, name]);

async function cleanup() {
  await pool.query('DELETE FROM mobile_lines WHERE phone_number IN (?)', [N]);
  await pool.query('DELETE FROM mobile_devices WHERE imei IN (?)', [IMEI]);
}

// --- GLPI simulado (API clasica): 30 computadoras, 1 monitor, 1 impresora
const DATA = {
  Computer: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `PC-${String(i + 1).padStart(3, '0')}`, serial: `SN5CG${1000 + i}`,
    otherserial: `INV-${i + 1}`, state: i < 28 ? 'En uso' : 'En almacén', type: 'Laptop', manufacturer: 'Lenovo', model: 'ThinkPad',
    location: i % 2 ? 'Sede Surco' : 'Sede Lima', user: 'jperez', entity: 'DEPILZONE' })),
  Monitor: [{ id: 101, name: 'MON-001', serial: 'MSN1', otherserial: 'INV-M1', state: 'En uso', type: 'LED', manufacturer: 'LG', model: '24MK430',
    location: 'Sede Surco', user: 'jperez', entity: 'DEPILZONE' }],
  Printer: [{ id: 201, name: 'IMP-RECEPCION', serial: 'PSN1', otherserial: 'INV-P1', state: 'En uso', type: 'Láser', manufacturer: 'HP', model: 'M404',
    location: 'Recepción', user: '', entity: 'DEPILZONE' }],
};
const OPT = { 1: 'name', 2: 'id', 3: 'location', 4: 'type', 5: 'serial', 6: 'otherserial', 23: 'manufacturer', 31: 'state', 40: 'model', 70: 'user', 80: 'entity', 19: 'date_mod' };
const seen = { glpiSessions: 0 };

function fakeGlpi() {
  const g = express();
  g.get('/apirest.php/initSession', (req, res) => { seen.glpiSessions += 1; res.json({ session_token: 's' }); });
  g.get('/apirest.php/killSession', (req, res) => res.json({}));
  g.get('/apirest.php/getMyProfiles', (req, res) => res.json({ myprofiles: [{ id: 2, name: 'Observer' }] }));
  g.get('/apirest.php/listSearchOptions/:itemtype', (req, res) => res.json({}));
  g.get('/apirest.php/search/:itemtype', (req, res) => {
    const list = DATA[req.params.itemtype] || [];
    const [a, b] = String(req.query.range || '0-19').split('-').map(Number);
    const page = list.slice(a, b + 1);
    const display = Object.values(req.query.forcedisplay || {}).map(String);
    const data = page.map((r) => Object.fromEntries(display.map((id) => [id, r[OPT[id]] === undefined ? null : r[OPT[id]]])));
    res.status(page.length < list.length ? 206 : 200).set('Content-Range', `${a}-${a + page.length - 1}/${list.length}`)
      .json({ totalcount: list.length, count: page.length, data });
  });
  return g;
}

// --- Sidecar simulado (HTTP Basic, como el real)
function fakeSidecar() {
  const s = express();
  s.use((req, res, next) => {
    const ok = req.get('Authorization') === `Basic ${Buffer.from('panel:clave-de-prueba').toString('base64')}`;
    return ok ? next() : res.status(401).json({ detail: 'Credenciales inválidas' });
  });
  s.get('/api/repos', (req, res) => res.json([
    { id: 1, name: 'gestor-licencias', github_url: 'https://github.com/ejemplo/gestor-licencias', local_path: '/data/repos/a', sync_interval_minutes: 30,
      active: true, last_synced_at: '2026-10-01T08:15:42.123456', last_sync_status: 'ok' },
    { id: 2, name: 'biometrico', github_url: 'https://github.com/ejemplo/biometrico', local_path: '/data/repos/b', sync_interval_minutes: 60,
      active: false, last_synced_at: null, last_sync_status: null },
  ]));
  s.get('/api/repos/:id/reports/latest', (req, res) => res.json(req.params.id === '1'
    ? { repo: 'gestor-licencias', found: true, report_date: '2026-09-30', ai_provider_used: 'gemini', report_markdown: '# x' }
    : { repo: 'biometrico', found: false }));
  return s;
}

async function main() {
  const [[admin]] = await pool.query("SELECT id, email, full_name, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  await cleanup(); // restos de una corrida anterior interrumpida

  const glpi = fakeGlpi().listen(0);
  const sidecar = fakeSidecar().listen(0);
  const glpiUrl = `http://127.0.0.1:${glpi.address().port}`;
  let cfg = { glpi_base_url: glpiUrl, glpi_app_token: 'a', glpi_user_token: 'u',
    devops_sidecar_url: `http://127.0.0.1:${sidecar.address().port}`, devops_sidecar_user: 'panel', devops_sidecar_password: 'clave-de-prueba' };
  settingsService.getAll = async () => cfg; // configuracion en memoria, sin tocar la guardada
  const reportService = require(path.join(ROOT, 'src/services/reportService'));
  const modules = require(path.join(ROOT, 'src/middleware/modules'));
  modules.moduleEnabled = async () => true;

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'e2e', resave: false, saveUninitialized: true }));
  app.use(flash());
  app.use((req, res, next) => {
    req.session.user = admin;
    Object.assign(res.locals, { currentUser: admin, csrfToken: 'x', successMessages: [], errorMessages: [], currentPath: req.path,
      currentHost: req.hostname, appName: 'Prueba', enabledModules: new Proxy({}, { get: () => true }), mobileLabels });
    next();
  });
  app.get('/__flash', (req, res) => res.json({ error: req.flash('error') }));
  app.use('/', require(path.join(ROOT, 'src/routes/dashboard')));
  app.use('/reportes', require(path.join(ROOT, 'src/routes/reports')));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const raw = async (u) => {
    const r = await fetch(base + u, { redirect: 'manual', headers: { cookie } });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return r;
  };
  const get = async (u) => { const r = await raw(u); return { status: r.status, text: await r.text() }; };
  const file = async (u) => { const r = await raw(u); return { status: r.status, type: r.headers.get('content-type'), name: r.headers.get('content-disposition'), buffer: Buffer.from(await r.arrayBuffer()) }; };
  const count = (text, needle) => text.split(needle).length - 1;

  try {
    // --- Codigo de barras (Code 128)
    check('Code 128: dígito de control correcto (vector conocido "PJJ123C" → 55)', _symbols('PJJ123C').slice(-2)[0] === 55);
    const imeiCode = _symbols('356938035643809');
    check('Un IMEI (15 dígitos) va en juego C de dos en dos, y el dígito suelto en juego B', imeiCode[0] === 105 && imeiCode[1] === 35
      && imeiCode.length === 1 + 7 + 2 + 2 && imeiCode[8] === 100 && imeiCode[9] === '9'.charCodeAt(0) - 32);
    const bars = code128('A-00868');
    check('Las barras no se solapan y dejan zona en blanco a los lados', bars.bars[0][0] === 10 && bars.bars.every((b, i) => i === 0 || b[0] > bars.bars[i - 1][0] + bars.bars[i - 1][1] - 0.001)
      && bars.modules === 10 + 11 * 9 + 13 + 10);
    check('Texto que el código no admite (vacío, con ñ) no genera barras', code128('') === null && code128(null) === null && code128('ÑU-1') === null);

    // --- Panel principal
    await pool.query(
      'INSERT INTO mobile_devices (imei, asset_code, brand, model, area, sede, status) VALUES (?), (?), (?)',
      [[IMEI[0], 'A-90081', 'Samsung', 'A15', AREA, 'Sede Ñandú', 'asignado'], [IMEI[1], 'A-90082', 'Oppo', 'A58', AREA, 'Sede Ñandú', 'en_stock'],
        [IMEI[2], null, 'Xiaomi', 'Redmi 13', AREA, null, 'en_stock']]
    );
    const [[dev]] = await pool.query('SELECT id FROM mobile_devices WHERE imei = ?', [IMEI[0]]);
    await pool.query('INSERT INTO mobile_device_assignments (device_id, holder_name, cargo, assigned_date) VALUES (?, ?, ?, ?)', [dev.id, 'Persona De Prueba', 'Analista', '2026-01-10']);
    await pool.query('INSERT INTO mobile_lines (phone_number, iccid, operadora, plan, costo_plan, descuento_plan, estado, device_id) VALUES (?), (?)',
      [[N[0], '8951100000000000081', 'Entel', 'Plan 29.90', 29.9, 5, 'activo', dev.id], [N[1], null, 'Claro', null, null, null, 'de_baja', null]]);
    const [[chipsVivos]] = await pool.query("SELECT COUNT(*) AS n FROM mobile_lines WHERE estado <> 'de_baja'");

    let p = await get('/');
    const panel = p.text.slice(p.text.indexOf('id="panel_glpi"'));
    check('Panel: muestra cuántas computadoras (30), monitores (1) e impresoras (1) hay en GLPI, con enlace a cada listado', p.status === 200
      && /Computadoras[\s\S]{0,200}>30</.test(panel) && /Monitores[\s\S]{0,200}>1</.test(panel) && /Impresoras[\s\S]{0,200}>1</.test(panel)
      && panel.includes('/glpi/inventario?tipo=monitores'));
    check('Panel: muestra los chips vigentes (sin contar los de baja)', new RegExp(`Chips[\\s\\S]{0,200}>${chipsVivos.n}<`).test(p.text));
    const sessions = seen.glpiSessions;
    await get('/');
    check('Panel: el conteo de GLPI se guarda (no se consulta a GLPI en cada visita)', seen.glpiSessions === sessions);
    cfg = { ...cfg, glpi_base_url: 'http://127.0.0.1:9' }; // nadie escucha ahi
    p = await get('/');
    check('Panel con GLPI caído: carga igual y muestra "—" en vez de un número', p.status === 200 && p.text.includes('id="panel_glpi"')
      && count(p.text.slice(p.text.indexOf('id="panel_glpi"')), 'rounded-pill" title=') === 3);
    cfg = { ...cfg, glpi_base_url: '' };
    p = await get('/');
    check('Panel sin GLPI configurado: no aparece la sección de GLPI', p.status === 200 && !p.text.includes('id="panel_glpi"'));
    cfg = { ...cfg, glpi_base_url: glpiUrl };

    // --- Reportes: pantalla
    p = await get('/reportes?modulo=server');
    check('Reporte de servidores: encabezados en castellano (ya no "asset_type", "support_expiration_date")', p.status === 200
      && p.text.includes('<th>Tipo de activo</th>') && p.text.includes('<th>Vence el soporte</th>') && !p.text.includes('asset_type') && !p.text.includes('support_expiration_date'));
    check('La lista de reportes ofrece celulares, chips, GLPI y repositorios', ['Celulares (equipos)', 'Chips (líneas)', 'Computadoras (GLPI)', 'Monitores (GLPI)',
      'Impresoras (GLPI)', 'Repositorios (DevOps)'].every((l) => p.text.includes(l)));

    const qs = `f_area=${encodeURIComponent(AREA)}`;
    p = await get(`/reportes?modulo=celulares&${qs}`);
    check('Reporte de celulares: cantidad total y desglose por estado y por sede', p.text.includes('id="reporte_total">3<')
      && /En stock <strong>2<\/strong>/.test(p.text) && /Asignado <strong>1<\/strong>/.test(p.text) && /Sede Ñandú <strong>2<\/strong>/.test(p.text) && /Sin dato <strong>1<\/strong>/.test(p.text));
    check('Reporte de celulares: datos del equipo y de quien lo tiene', p.text.includes(IMEI[0]) && p.text.includes('A-90081') && p.text.includes('Persona De Prueba') && p.text.includes('Analista'));
    p = await get(`/reportes?modulo=celulares&${qs}&f_estado=${encodeURIComponent('En stock')}&q=oppo`);
    check('Filtros combinados (área + estado + búsqueda sin distinguir mayúsculas)', p.text.includes('id="reporte_total">1<') && p.text.includes(IMEI[1]) && !p.text.includes(IMEI[0]));
    p = await get(`/reportes?modulo=celulares&${qs}&q=nandu`);
    check('La búsqueda no distingue acentos ("nandu" encuentra "Sede Ñandú")', p.text.includes('id="reporte_total">2<'));
    check('Los enlaces de exportación llevan los filtros que se están viendo', p.text.includes(`/reportes/exportar.pdf?modulo=celulares&amp;q=nandu&amp;f_area=${AREA}`)
      && p.text.includes('/reportes/exportar.xlsx?modulo=celulares&amp;q=nandu'));

    // --- Excel
    let f = await file(`/reportes/exportar.xlsx?modulo=celulares&${qs}`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(f.buffer);
    const resumen = wb.getWorksheet('Resumen');
    const datos = wb.getWorksheet('Datos');
    const resumenRows = [];
    resumen.eachRow((row) => resumenRows.push(row.values.slice(1).join('|')));
    check('Excel: hoja "Resumen" con el total y la cantidad por estado y por sede', f.status === 200 && resumenRows.includes('Total de registros|3')
      && resumenRows.includes('En stock|2') && resumenRows.includes('Asignado|1') && resumenRows.includes('Sede Ñandú|2') && resumenRows.some((r) => r.includes(`Área: ${AREA}`)));
    const head = datos.getRow(1).values;
    const cellOf = (rowNumber, label) => datos.getRow(rowNumber).getCell(head.indexOf(label)).value;
    const imeiRow = [2, 3, 4].find((n) => cellOf(n, 'IMEI') === IMEI[0]);
    check('Excel: hoja "Datos" con una fila por celular; el IMEI va como texto (no se redondea)', datos.rowCount === 4 && imeiRow
      && cellOf(imeiRow, 'Código') === 'A-90081' && cellOf(imeiRow, 'Asignado a') === 'Persona De Prueba' && cellOf(imeiRow, 'Estado') === 'Asignado');

    // --- PDF con codigo de barras
    f = await file(`/reportes/exportar.pdf?modulo=celulares&${qs}`);
    let lines = await extractLines(f.buffer);
    let all = lines.join('\n');
    check('PDF de celulares: es un PDF, con título, total y desglose', f.status === 200 && f.type === 'application/pdf' && f.buffer.slice(0, 5).toString() === '%PDF-'
      && /reporte_celulares_\d{4}-\d{2}-\d{2}\.pdf/.test(f.name) && all.includes('Reporte: Celulares (equipos)') && all.includes('Total: 3 registro(s)')
      && all.includes('Por estado: En stock 2 · Asignado 1') && all.includes(`Filtros: Área: ${AREA}`));
    check('PDF: cada fila lleva su código de barras (el IMEI, legible debajo) y los datos para ubicar el equipo', IMEI.every((i) => all.includes(i))
      && all.includes('Código de barras (IMEI)') && all.includes('A-90081') && all.includes('Persona De Prueba') && all.includes('Samsung A15'));
    check('PDF: cierra con el espacio para la verificación física y numera las páginas', all.includes('Encontrados: ________ de 3') && all.includes('Verificado por:')
      && all.includes('Página 1 de 1'));
    f = await file(`/reportes/exportar.pdf?modulo=celulares&${qs}&barras=asset_code`);
    all = (await extractLines(f.buffer)).join('\n');
    check('PDF: se puede elegir otro dato para el código de barras (código interno); sin dato, lo dice', all.includes('Código de barras (Código interno)')
      && all.includes('Sin código interno') && !all.includes('Código de barras (IMEI)'));

    // --- Chips
    p = await get('/reportes?modulo=chips&q=9000008');
    check('Reporte de chips: cantidad por operadora, estado y ubicación; costo, descuento y lo que se paga', p.text.includes('id="reporte_total">2<')
      && /Entel <strong>1<\/strong>/.test(p.text) && /Claro <strong>1<\/strong>/.test(p.text) && /De baja <strong>1<\/strong>/.test(p.text)
      && /En un celular <strong>1<\/strong>/.test(p.text) && p.text.includes('>29.90<') && p.text.includes('>5.00<') && p.text.includes('>24.90<') && p.text.includes('A-90081'));
    f = await file('/reportes/exportar.pdf?modulo=chips&q=9000008&barras=iccid');
    all = (await extractLines(f.buffer)).join('\n');
    check('PDF de chips con el ICCID como código de barras', all.includes('Código de barras (ICCID)') && all.includes('8951100000000000081') && all.includes('Sin iccid') && all.includes(N[0]));
    f = await file('/reportes/exportar.csv?modulo=chips&q=9000008');
    const csv = f.buffer.toString('utf8');
    check('CSV de chips: encabezados en castellano y una línea por chip', f.type.includes('text/csv') && csv.charCodeAt(0) === 0xFEFF
      && csv.split('\n')[0].includes('Número,Operadora,ICCID,Plan,Estado,Ubicación') && csv.split('\n').length === 3);

    // --- GLPI
    p = await get('/reportes?modulo=glpi_computadoras');
    check('Reporte GLPI de computadoras: 30, con desglose por estado y entidad, y filtros sacados de los datos', p.text.includes('id="reporte_total">30<')
      && /En uso <strong>28<\/strong>/.test(p.text) && /En almacén <strong>2<\/strong>/.test(p.text) && /DEPILZONE <strong>30<\/strong>/.test(p.text)
      && p.text.includes('<option value="Sede Surco"') && p.text.includes('PC-030'));
    p = await get(`/reportes?modulo=glpi_computadoras&f_location=${encodeURIComponent('Sede Surco')}`);
    check('Reporte GLPI filtrado por ubicación', p.text.includes('id="reporte_total">15<') && p.text.includes('PC-002') && !p.text.includes('>PC-001<'));
    f = await file('/reportes/exportar.pdf?modulo=glpi_computadoras');
    lines = await extractLines(f.buffer);
    all = lines.join('\n');
    check('PDF de computadoras: 30 filas en 2 páginas, con el encabezado de columnas repetido y el n.º de serie como código de barras', all.includes('Página 2 de 2')
      && count(all, 'Código de barras (N.º de serie)') === 2 && Array.from({ length: 30 }, (_, i) => `SN5CG${1000 + i}`).every((s) => all.includes(s))
      && all.includes('Lenovo / ThinkPad') && all.includes('Encontrados: ________ de 30'));
    f = await file('/reportes/exportar.xlsx?modulo=glpi_impresoras');
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(f.buffer);
    check('Excel de impresoras (GLPI)', wb2.getWorksheet('Datos').rowCount === 2 && wb2.getWorksheet('Datos').getRow(2).values.includes('IMP-RECEPCION')
      && wb2.getWorksheet('Datos').getRow(2).values.includes('PSN1'));
    p = await get('/reportes?modulo=glpi_monitores');
    check('Reporte GLPI de monitores', p.text.includes('id="reporte_total">1<') && p.text.includes('MON-001'));

    // --- Repositorios (DevOps sidecar)
    p = await get('/reportes?modulo=repositorios');
    check('Reporte de repositorios: se conecta al sidecar y muestra sincronización y última auditoría', p.text.includes('id="reporte_total">2<')
      && p.text.includes('gestor-licencias') && p.text.includes('2026-10-01 08:15') && p.text.includes('2026-09-30 (gemini)')
      && p.text.includes('Nunca') && p.text.includes('Sin auditorías') && /Sí <strong>1<\/strong>/.test(p.text));
    f = await file('/reportes/exportar.pdf?modulo=repositorios');
    all = (await extractLines(f.buffer)).join('\n');
    check('PDF de repositorios (sin código de barras ni casillas)', all.includes('Reporte: Repositorios (DevOps)') && all.includes('gestor-licencias')
      && !all.includes('Código de barras') && !all.includes('Verificado por'));
    cfg = { ...cfg, devops_sidecar_password: 'otra' };
    p = await get('/reportes?modulo=repositorios');
    check('Sidecar que rechaza las credenciales: la pantalla lo explica en vez de fallar', p.status === 200 && p.text.includes('No se pudo cargar este reporte')
      && p.text.includes('HTTP 401'));
    const r = await raw('/reportes/exportar.xlsx?modulo=repositorios');
    const fl = JSON.parse((await get('/__flash')).text);
    check('Exportar con el sidecar caído: vuelve a la pantalla con el motivo', r.status === 302 && r.headers.get('location') === '/reportes?modulo=repositorios'
      && fl.error[0].includes('No se pudo generar el reporte'));
    cfg = { ...cfg, devops_sidecar_user: '', devops_sidecar_password: '' };
    p = await get('/reportes?modulo=repositorios');
    check('Sidecar sin configurar: dice dónde completarlo', p.text.includes('DevOps Sidecar no esta configurado'));

    // --- Permisos
    const lector = reportService.available({ role: 'lector' }, { celulares: false, glpi_inventario: true });
    check('Un rol sin el módulo Celulares no ve sus reportes; Repositorios es solo para administradores', !lector.celulares && !lector.chips
      && lector.glpi_computadoras && !lector.repositorios && lector.license && reportService.available({ role: 'admin' }, {}).repositorios);
    p = await get('/reportes?modulo=no-existe');
    check('Un reporte desconocido cae en el primero de la lista', p.status === 200 && p.text.includes('<option value="license" selected>'));
  } finally {
    server.close();
    glpi.close();
    sidecar.close();
    await cleanup();
    const [[left]] = await pool.query('SELECT (SELECT COUNT(*) FROM mobile_devices WHERE imei IN (?)) + (SELECT COUNT(*) FROM mobile_lines WHERE phone_number IN (?)) AS n', [IMEI, N]);
    check('Limpieza: no quedan datos de prueba', left.n === 0);
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
