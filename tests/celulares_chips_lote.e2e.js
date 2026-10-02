// Prueba de extremo a extremo de la carga de chips por lote: ingreso por
// escaneo, importación desde Excel con la plantilla y operadora masiva.
//
// Monta las rutas REALES en una mini-app con una sesion de administrador
// simulada y trabaja contra la base configurada, con datos de prueba
// marcados que se borran al final (numeros 9000009[2-3]x, IMEI
// 990000000000021, ICCID 89510000000000000xx). Por seguridad no corre salvo
// que se pase E2E_PERMITIR=1 a proposito.
//
// La logica que corre en el navegador al escanear (armar la lista) se
// prueba aparte, ejecutando el script de la pantalla sobre un DOM minimo.
//
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/celulares_chips_lote.e2e.js
const path = require('path');
const vm = require('vm');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const pool = require(path.join(ROOT, 'src/db/pool'));
const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));

if (process.env.E2E_PERMITIR !== '1') {
  console.error('Esta prueba escribe (y luego borra) datos marcados en la base configurada. Ejecútela con E2E_PERMITIR=1.');
  process.exit(2);
}

const N = Array.from({ length: 12 }, (_, i) => String(900000921 + i));
const ICC = Array.from({ length: 6 }, (_, i) => `895100000000000000${String(i + 1).padStart(2, '0')}`);
const IMEI = '990000000000021';
const results = [];
const check = (name, cond) => results.push([!!cond, name]);
let auditStart = null; // la auditoria que genere la prueba se borra al final

async function cleanup() {
  await pool.query('DELETE FROM mobile_lines WHERE phone_number IN (?)', [N]);
  await pool.query('DELETE FROM mobile_devices WHERE imei = ?', [IMEI]);
  if (auditStart !== null) {
    await pool.query("DELETE FROM audit_log WHERE id > ? AND (action IN ('chips_importados', 'chips_ingresados_por_escaneo', 'chips_operadora_masiva') OR target LIKE 'Chip 9000009%')", [auditStart]);
  }
}

// DOM minimo para ejecutar el script de la pantalla de escaneo.
function scanPage(html, request) {
  const start = html.indexOf('(function () {', html.indexOf('<script>', html.indexOf('id="scan_rows"')));
  const script = html.slice(start, html.indexOf('</script>', start));
  const els = {};
  const el = (id) => {
    if (!els[id]) {
      els[id] = {
        id, value: '', className: '', hidden: false, disabled: false, checked: false, children: [], listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; }, appendChild(c) { this.children.push(c); }, setAttribute() {}, focus() {},
      };
      Object.defineProperty(els[id], 'textContent', { get() { return this._t || ''; }, set(v) { this._t = String(v); if (v === '') this.children = []; } });
    }
    return els[id];
  };
  let pending = 0;
  const sandbox = {
    document: { getElementById: el, createElement: () => el(`tmp${Math.random()}`) },
    confirm: () => true,
    fetch: (url) => { pending += 1; return request(url).finally(() => { pending -= 1; }); },
  };
  vm.runInNewContext(script, sandbox);
  const tick = () => new Promise((r) => setTimeout(r, 15));
  // Como el lector: escribe el codigo y pulsa Enter; espera a que termine
  // la consulta de "chip existente".
  const scan = async (text) => {
    el('scan_input').value = text;
    el('scan_form').listeners.keydown({ key: 'Enter', target: el('scan_input'), preventDefault() {} });
    do { await tick(); } while (pending > 0);
    await tick();
  };
  const submit = () => { el('scan_form').listeners.submit({ preventDefault() {} }); return el('chips_field').value; };
  return { el, scan, submit };
}

async function main() {
  const [[admin]] = await pool.query("SELECT id, email, full_name, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  const [[peru]] = await pool.query("SELECT id FROM phone_country_codes WHERE calling_code = '51' LIMIT 1");
  await cleanup(); // restos de una corrida anterior interrumpida
  auditStart = (await pool.query('SELECT COALESCE(MAX(id), 0) AS id FROM audit_log'))[0][0].id;

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'prueba-e2e', resave: false, saveUninitialized: true }));
  app.use(flash());
  const CSRF = 'token-de-prueba-e2e-0123456789abcdef0123456789abcdef';
  app.use((req, res, next) => {
    req.session.user = admin;
    req.session.csrfToken = CSRF;
    Object.assign(res.locals, {
      currentUser: admin, csrfToken: CSRF, successMessages: [], errorMessages: [], currentPath: req.path, currentHost: req.hostname,
      appName: 'Prueba', enabledModules: new Proxy({}, { get: () => true }), mobileLabels,
    });
    next();
  });
  app.get('/__flash', (req, res) => res.json({ error: req.flash('error'), success: req.flash('success') }));
  app.use('/celulares/chips', require(path.join(ROOT, 'src/routes/mobileLines')));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  async function req(method, url, body) {
    const opts = { method, redirect: 'manual', headers: { cookie } };
    if (body instanceof FormData) opts.body = body;
    else if (body) {
      opts.body = new URLSearchParams({ _csrf: CSRF, ...body }).toString();
      opts.headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const r = await fetch(base + url, opts);
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const buffer = Buffer.from(await r.arrayBuffer());
    return { status: r.status, location: r.headers.get('location'), text: buffer.toString('utf8'), buffer };
  }
  const post = async (url, body) => {
    const r = await req('POST', url, body);
    const f = JSON.parse((await req('GET', '/__flash')).text);
    return { ...r, errors: f.error, ok: f.success };
  };
  const q = async (sql, params) => (await pool.query(sql, params))[0];
  const chip = async (num) => (await q('SELECT * FROM mobile_lines WHERE phone_number = ?', [num]))[0];
  const browser = (url) => fetch(base + url, { headers: { cookie } });
  const existe = async (qs) => JSON.parse((await req('GET', `/celulares/chips/existe?${qs}`)).text);

  try {
    // --- Pantalla de escaneo: logica del navegador
    let r = await req('GET', '/celulares/chips/escanear');
    check('Pantalla de ingreso por escaneo', r.status === 200 && r.text.includes('Datos del lote') && r.text.includes('scan_input'));
    let page = scanPage(r.text, browser);
    await page.scan(`${ICC[0]}F`);
    check('Escaneo: un ICCID solo queda a la espera de su número (la "F" final del código se descarta)', page.el('scan_count').textContent === '0'
      && /Ahora lea o escriba el número/.test(page.el('scan_status').textContent) && page.el('scan_status').textContent.includes(ICC[0]));
    await page.scan(N[0]);
    check('Escaneo: al leer ICCID y número el chip pasa a la lista', page.el('scan_count').textContent === '1' && page.el('scan_submit').disabled === false);
    await page.scan(N[1]); await page.scan(ICC[1]);
    check('Escaneo: también en el orden número → ICCID', page.el('scan_count').textContent === '2');
    await page.scan(N[0]); await page.scan(ICC[2]);
    check('Escaneo: un número que ya está en la lista no se agrega dos veces', page.el('scan_count').textContent === '2'
      && /ya está en la lista/.test(page.el('scan_status').textContent));
    await page.scan('12345');
    check('Escaneo: un código que no es ni número ni ICCID se rechaza con explicación', /No se reconoce/.test(page.el('scan_status').textContent)
      && page.el('scan_count').textContent === '2');
    page.el('solo_numero').checked = true;
    await page.scan(N[2]);
    check('Escaneo "solo el número": entra directo, sin ICCID', page.el('scan_count').textContent === '3');
    const armado = page.submit();
    check('Escaneo: la lista se envía como un chip por renglón (número;ICCID)', armado === `${N[0]};${ICC[0]}\n${N[1]};${ICC[1]}\n${N[2]};`);

    // --- Registrar lo escaneado
    const lote = { operadora: 'Entel', plan: 'Plan E2E', costo_plan: '31.90', descuento_plan: '15.95', notes: 'lote_e2e sellado' };
    r = await post('/celulares/chips/escanear', { ...lote, chips: armado });
    let c0 = await chip(N[0]);
    check('Registrar el lote escaneado: los 3 chips quedan en stock y vuelve al listado', /^3 chip\(s\) registrados/.test(r.ok[0] || '')
      && r.location === '/celulares/chips?ubicacion=en_stock' && c0 && (await chip(N[1])) && (await chip(N[2])));
    check('Cada chip recibe los datos del lote: operadora, plan, los dos montos, nota y país', c0.operadora === 'Entel' && c0.plan === 'Plan E2E'
      && Number(c0.costo_plan) === 31.9 && Number(c0.descuento_plan) === 15.95 && c0.notes === 'lote_e2e sellado' && c0.iccid === ICC[0]
      && c0.phone_country_code_id === peru.id && c0.device_id === null && c0.estado === 'activo' && (await chip(N[2])).iccid === null);

    // --- Chip existente: se avisa al escribir o escanear, sin esperar a guardar
    let e = await existe(`numero=${N[0]}`);
    check('Consulta "¿existe?": un número ya registrado responde con su estado, ubicación y enlace', e.existe === true && e.numero === N[0]
      && e.detalle === 'Activo · En stock · Entel' && e.url === `/celulares/chips/${c0.id}`);
    check('Consulta "¿existe?": también por ICCID, y un número nuevo responde que no', (await existe(`iccid=${ICC[0]}`)).numero === N[0]
      && (await existe(`numero=${N[11]}`)).existe === false && (await existe('numero=')).existe === false);
    check('Consulta "¿existe?": al editar un chip, su propio número no cuenta como existente', (await existe(`numero=${N[0]}&excepto=${c0.id}`)).existe === false);
    r = await req('GET', '/celulares/chips/escanear');
    page = scanPage(r.text, browser);
    await page.scan(N[0]);
    check('Escaneo de un número ya registrado: avisa "Chip existente" y no lo agrega', page.el('scan_count').textContent === '0'
      && page.el('scan_status').textContent.startsWith(`Chip existente: ${N[0]} — Activo · En stock · Entel`));
    await page.scan(ICC[1]);
    check('Escaneo de un ICCID ya registrado: avisa de qué chip es', page.el('scan_count').textContent === '0'
      && page.el('scan_status').textContent.includes(`ese ICCID ya es del chip ${N[1]}`));
    await page.scan(ICC[3]); await page.scan(N[11]);
    check('Tras un aviso de existente, un chip nuevo se agrega con normalidad', page.el('scan_count').textContent === '1');
    r = await req('GET', '/celulares/chips/nuevo');
    check('Formulario de chip nuevo: incluye el aviso de chip existente', r.status === 200 && r.text.includes('id="existe_numero"')
      && r.text.includes("/celulares/chips/existe?"));

    r = await post('/celulares/chips/escanear', { chips: '' });
    check('Registrar sin chips en la lista: avisa', /No hay chips en la lista/.test(r.errors[0] || ''));

    // --- Lote con errores: se registra lo valido y lo demas vuelve a la lista
    r = await req('POST', '/celulares/chips/escanear', { ...lote, chips: [`${N[0]};${ICC[3]}`, `${N[3]};${ICC[0]}`, '12345678;', `${N[4]};${ICC[4]}`, `${N[4]};`].join('\n') });
    check('Lote con errores: registra el válido y explica cada fallo', r.status === 200 && r.text.includes('1 chip(s) registrados; 4 no se pudieron registrar')
      && r.text.includes('ya existe un chip con ese número') && r.text.includes(`el ICCID ${ICC[0]} ya está registrado en el chip ${N[0]}`)
      && r.text.includes('debe tener 9 dígitos') && r.text.includes('está repetido en este mismo lote') && (await chip(N[4])) && !(await chip(N[3])));
    page = scanPage(r.text, browser);
    check('Los que fallaron vuelven a la lista y se conservan los datos del lote', page.el('scan_count').textContent === '4'
      && r.text.includes('value="Plan E2E"') && r.text.includes('<option value="Entel" selected>'));
    r = await post('/celulares/chips/escanear', { costo_plan: '10', descuento_plan: '20', chips: `${N[3]};` });
    check('Descuento del lote mayor que el costo: no registra', !(await chip(N[3])));

    // --- Importar desde Excel
    r = await req('GET', '/celulares/chips/importar');
    check('Pantalla de importación con las columnas de la plantilla', r.status === 200 && r.text.includes('Descargar plantilla') && r.text.includes('Costo sin descuento') && r.text.includes('Revisar el archivo'));
    r = await req('GET', '/celulares/chips/importar/plantilla');
    const tpl = new ExcelJS.Workbook();
    await tpl.xlsx.load(r.buffer);
    const ts = tpl.worksheets[0];
    check('Plantilla: encabezados esperados y columnas Número e ICCID como texto', ts.getCell('A1').value === 'Número' && ts.getCell('B1').value === 'ICCID'
      && ts.getCell('E1').value === 'Costo sin descuento' && ts.getColumn(1).numFmt === '@' && ts.getColumn(2).numFmt === '@');
    ts.addRow([N[5], ICC[5], 'Claro', 'Plan E2E', 29.9, 9.9, 'Promo 6 meses', 'lote_e2e excel']);
    ts.addRow([Number(N[6]), '', '', '', '', '', '', 'lote_e2e excel']); // numero como numero de Excel, sin mas datos
    ts.addRow([N[5], '', '', '', '', '', '', '']); // repetido en el archivo
    ts.addRow([N[7], 8951000000000000000, '', '', '', '', '', '']); // ICCID como numero: Excel lo recorta
    ts.addRow(['', '', '', '', '', '', '', '']); // fila vacia: se ignora
    ts.addRow(['', ICC[3], 'Entel', '', '', '', '', '']); // sin numero
    ts.addRow([N[0], '', '', '', '', '', '', '']); // ya existe
    const sendFile = async (buffer, name) => {
      const form = new FormData();
      form.append('_csrf', CSRF);
      form.append('file', new Blob([buffer]), name);
      return req('POST', '/celulares/chips/importar', form);
    };
    const tokenOf = (html) => (html.match(/name="token" value="([0-9a-f]+)"/) || [])[1];
    r = await sendFile(Buffer.from(await tpl.xlsx.writeBuffer()), 'chips.xlsx');
    check('Importar: primero muestra la revisión, sin registrar nada', r.status === 200 && r.text.includes('Revisar antes de registrar')
      && r.text.includes('todavía no se registró nada') && !(await chip(N[5])) && !(await chip(N[6])));
    check('Revisión: 2 listos, 1 con advertencia y 3 con error, cada fila con su motivo', r.text.includes('2 listos') && r.text.includes('1 con advertencia')
      && r.text.includes('3 con error') && r.text.includes('está repetido en este mismo lote') && r.text.includes('ICCID ilegible')
      && r.text.includes('Falta el número') && r.text.includes('ya existe un chip con ese número') && r.text.includes('Registrar 3 chip(s) en stock'));
    const token = tokenOf(r.text);
    r = await req('POST', '/celulares/chips/importar/confirmar', { token, operadora: 'Entel', plan: 'Plan relleno', notes: 'lote_e2e relleno' });
    const c5 = await chip(N[5]);
    check('Confirmar: registra los 3 y lista las 3 filas con error', r.status === 200 && r.text.includes('Importados: 3') && r.text.includes('Con errores: 3'));
    check('El chip trae todos sus datos del archivo; lo que se pide completar no pisa lo que el archivo ya traía', c5 && c5.operadora === 'Claro'
      && c5.iccid === ICC[5] && c5.plan === 'Plan E2E' && Number(c5.costo_plan) === 29.9 && Number(c5.descuento_plan) === 9.9
      && c5.descuento_nota === 'Promo 6 meses' && c5.notes === 'lote_e2e excel');
    check('Las filas con datos vacíos se completan; el número escrito como número de Excel también entra', (await chip(N[6])).operadora === 'Entel'
      && (await chip(N[6])).plan === 'Plan relleno' && (await chip(N[6])).notes === 'lote_e2e excel');
    check('El ICCID que Excel recortó no se guarda: el chip entra sin ICCID', (await chip(N[7])) && (await chip(N[7])).iccid === null
      && (await chip(N[7])).notes === 'lote_e2e relleno');
    r = await post('/celulares/chips/importar/confirmar', { token });
    check('Confirmar dos veces la misma revisión: no duplica, pide subir de nuevo', /venció o ya se registró/.test(r.errors[0] || ''));
    await pool.query('UPDATE mobile_lines SET operadora = NULL WHERE phone_number = ?', [N[6]]);

    // Archivo "libre": encabezados en la fila 2, desde la columna B, sin tildes y con una columna de serie
    const libre = new ExcelJS.Workbook();
    const ls = libre.addWorksheet('Hoja1');
    ls.getCell('B2').value = 'IMEIF'; ls.getCell('C2').value = 'ICCID'; ls.getCell('D2').value = 'Numero'; ls.getCell('E2').value = 'Otra cosa';
    ls.getCell('B3').value = 'AB0000000000001'; ls.getCell('C3').value = 8.95100000000001e+19; ls.getCell('D3').value = Number(N[11]);
    ls.getCell('B4').value = 'AB0000000000002'; ls.getCell('C4').value = 8.95100000000001e+19; ls.getCell('D4').value = Number(N[0]);
    r = await sendFile(Buffer.from(await libre.xlsx.writeBuffer()), 'libre.xlsx');
    check('Archivo sin la plantilla: reconoce los encabezados en la fila 2 y sin tildes, y avisa de la columna que no usa', r.status === 200
      && r.text.includes('encabezados en la fila 2') && r.text.includes('Columnas del archivo que no se usan: Otra cosa')
      && r.text.includes('Serie AB0000000000001') && r.text.includes('1 con advertencia') && r.text.includes('1 con error'));
    r = await req('POST', '/celulares/chips/importar/confirmar', { token: tokenOf(r.text) });
    check('La columna de serie queda en las notas del chip', (await chip(N[11])) && (await chip(N[11])).notes === 'Serie AB0000000000001');
    const sinNumero = new ExcelJS.Workbook();
    sinNumero.addWorksheet('H').addRow(['ICCID', 'Plan']);
    r = await post('/celulares/chips/importar', (() => { const f = new FormData(); f.append('_csrf', CSRF); f.append('file', new Blob([Buffer.from([1, 2, 3])]), 'x.xlsx'); return f; })());
    check('Archivo dañado: avisa', /No se pudo abrir el archivo/.test(r.errors[0] || ''));
    const bad = new FormData();
    bad.append('_csrf', CSRF);
    r = await post('/celulares/chips/importar', bad);
    check('Importar sin archivo: avisa', /seleccionar un archivo/.test(r.errors[0] || ''));

    // --- Operadora masiva
    const [dev] = await pool.query("INSERT INTO mobile_devices (imei, phone_country_code_id, phone_number, has_chip, area, status) VALUES (?, ?, ?, 1, 'PRUEBA-E2E', 'en_stock')", [IMEI, peru.id, N[8]]);
    await pool.query('INSERT INTO mobile_lines (phone_country_code_id, phone_number, device_id) VALUES (?, ?, ?)', [peru.id, N[8], dev.insertId]);
    await pool.query('INSERT INTO mobile_lines (phone_number) VALUES (?), (?)', [N[9], N[10]]);
    const ids = [(await chip(N[8])).id, (await chip(N[9])).id, (await chip(N[6])).id];
    r = await req('GET', '/celulares/chips?q=9000009&operadora=__sin__');
    check('Listado filtrado "sin operadora": casillas para marcar y selector de operadora', r.status === 200 && r.text.includes('Asignar a los marcados')
      && r.text.includes(`class="form-check-input chip-mark" value="${ids[1]}"`) && r.text.includes('id="mark_all"')
      && r.text.includes('name="back" value="?q=9000009&amp;operadora=__sin__"') && !r.text.includes(`chip-mark" value="${c0.id}"`));
    r = await post('/celulares/chips/operadora', { ids: ids.join(','), operadora: 'E2E-OPERADORA', back: '?q=9000009&operadora=__sin__' });
    check('Asignar operadora a los marcados: cambia solo esos y vuelve al mismo filtro', /asignada a 3 chip/.test(r.ok[0] || '')
      && r.location === '/celulares/chips?q=9000009&operadora=__sin__' && (await chip(N[9])).operadora === 'E2E-OPERADORA'
      && (await chip(N[6])).operadora === 'E2E-OPERADORA' && (await chip(N[10])).operadora === null && (await chip(N[0])).operadora === 'Entel');
    check('Si el chip es el número principal de un celular, el celular también queda con esa operadora',
      (await q('SELECT operadora FROM mobile_devices WHERE imei = ?', [IMEI]))[0].operadora === 'E2E-OPERADORA');
    r = await post('/celulares/chips/operadora', { ids: '', operadora: 'Entel' });
    check('Operadora masiva sin marcar chips: avisa', /Marque al menos un chip/.test(r.errors[0] || ''));
    r = await post('/celulares/chips/operadora', { ids: String(ids[1]), operadora: '' });
    check('Operadora masiva sin elegir operadora: avisa y no cambia nada', /Elija la operadora/.test(r.errors[0] || '')
      && (await chip(N[9])).operadora === 'E2E-OPERADORA');
    r = await post('/celulares/chips/operadora', { ids: `${ids[1]},abc,${ids[1]}`, operadora: 'Entel', back: 'http://otro-sitio' });
    check('Ids no numéricos se ignoran y una dirección de retorno ajena no se usa', /asignada a 1 chip/.test(r.ok[0] || '')
      && r.location === '/celulares/chips' && (await chip(N[9])).operadora === 'Entel');

    // --- Dar de baja y reactivar
    const lineSvc = require(path.join(ROOT, 'src/services/mobileLineService'));
    const sum = async () => lineSvc.summarize(await lineSvc.listLines({ q: '9000009', operadora: 'Entel' }));
    const antes = await sum();
    r = await req('GET', `/celulares/chips/${c0.id}`);
    check('Detalle del chip: botón "Dar de baja" con fecha y motivo', r.text.includes('Dar de baja este chip') && r.text.includes('name="motivo_baja"'));
    r = await post(`/celulares/chips/${c0.id}/baja`, { fecha_baja: '2026-09-30', motivo_baja: 'Línea cancelada con la operadora' });
    c0 = await chip(N[0]);
    check('Dar de baja: el chip queda de baja con su fecha y motivo', /dado de baja/.test(r.ok[0] || '') && c0.estado === 'de_baja'
      && c0.fecha_baja === '2026-09-30' && c0.motivo_baja === 'Línea cancelada con la operadora');
    let s2 = await sum();
    check('El chip de baja deja de sumar en lo que se paga (y se informa cuánto costaba)', s2.total === antes.total
      && s2.netoTotal === Math.round((antes.netoTotal - 15.95) * 100) / 100 && s2.costoTotal === Math.round((antes.costoTotal - 31.9) * 100) / 100
      && s2.ahorroBajas === 15.95 && s2.porEstado.de_baja === 1);
    r = await req('GET', '/celulares/chips?q=9000009&operadora=Entel');
    check('Listado: muestra los de baja aparte, con su fecha', r.text.includes('de baja no se suman') && r.text.includes('costaban S/ 15.95')
      && r.text.includes('desde 2026-09-30'));
    r = await req('GET', `/celulares/chips/${c0.id}`);
    check('Detalle de un chip de baja: lo indica y ofrece reactivar', r.text.includes('Chip dado de baja desde el 2026-09-30') && r.text.includes('Reactivar')
      && r.text.includes('Se pagaba al mes'));
    r = await post(`/celulares/chips/${c0.id}/baja`, {});
    check('Dar de baja dos veces: avisa', /ya está dado de baja/.test(r.errors[0] || ''));
    e = await existe(`numero=${N[0]}`);
    check('Un número dado de baja sigue apareciendo como existente, con su estado', e.existe && e.detalle.startsWith('De baja'));
    r = await post(`/celulares/chips/${c0.id}/reactivar`, {});
    c0 = await chip(N[0]);
    check('Reactivar: vuelve a activo, sin fecha ni motivo, y a sumar', /reactivado/.test(r.ok[0] || '') && c0.estado === 'activo'
      && c0.fecha_baja === null && c0.motivo_baja === null && (await sum()).netoTotal === antes.netoTotal);
    r = await post(`/celulares/chips/${c0.id}/reactivar`, {});
    check('Reactivar un chip que no está de baja: avisa', /no está dado de baja/.test(r.errors[0] || ''));
    const c8 = await chip(N[8]);
    r = await post(`/celulares/chips/${c8.id}/baja`, {});
    const d8 = (await q('SELECT has_chip, phone_number FROM mobile_devices WHERE imei = ?', [IMEI]))[0];
    check('Baja de un chip puesto en un celular: sale del equipo, que queda sin número; la fecha es hoy', (await chip(N[8])).device_id === null
      && (await chip(N[8])).estado === 'de_baja' && (await chip(N[8])).fecha_baja !== null && d8.has_chip === 0 && d8.phone_number === null);
    r = await post(`/celulares/chips/${c8.id}/editar`, { phone_number: N[8], phone_country_code_id: String(peru.id), estado: 'activo' });
    check('Cambiar el estado a activo desde el formulario también limpia la fecha de baja', (await chip(N[8])).estado === 'activo'
      && (await chip(N[8])).fecha_baja === null);
    r = await post(`/celulares/chips/${c8.id}/editar`, { phone_number: N[8], phone_country_code_id: String(peru.id), estado: 'de_baja' });
    check('Y ponerlo de baja desde el formulario le pone la fecha de hoy', (await chip(N[8])).fecha_baja !== null);

    check('Quedó registrado en la auditoría', (await q("SELECT COUNT(DISTINCT action) AS n FROM audit_log WHERE action IN ('chips_importados', 'chips_ingresados_por_escaneo', 'chips_operadora_masiva', 'chip_dado_de_baja', 'chip_reactivado') AND id > ?", [auditStart]))[0].n === 5);
  } finally {
    server.close();
    await cleanup();
    const left = await q('SELECT COUNT(*) AS n FROM mobile_lines WHERE phone_number IN (?)', [N]);
    check('Limpieza: no quedan datos de prueba', left[0].n === 0);
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
