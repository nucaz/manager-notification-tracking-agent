// Prueba de extremo a extremo de Celulares → Recibos: subir un recibo de
// operadora, cruzarlo contra el inventario, registrar los chips faltantes y
// actualizar planes. Incluye el lector de PDF (sobre renglones de texto con
// el formato real de Entel) y el del Excel (archivo armado aqui mismo).
//
// Monta las rutas REALES en una mini-app con una sesion de administrador
// simulada y trabaja contra la base configurada, con datos de prueba
// marcados que se borran al final (numeros 9000009xx, IMEI 99000000000001x,
// recibos 99000000x). No usa ningun recibo real. Por seguridad no corre
// salvo que se pase E2E_PERMITIR=1 a proposito.
//
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/celulares_recibos.e2e.js
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const pool = require(path.join(ROOT, 'src/db/pool'));
const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));
const billService = require(path.join(ROOT, 'src/services/mobileBillService'));
const entelPdf = require(path.join(ROOT, 'src/services/mobileBillParsers/entelPdf'));
const common = require(path.join(ROOT, 'src/services/mobileBillParsers/common'));
const { DIRS } = require(path.join(ROOT, 'src/services/uploadService'));

if (process.env.E2E_PERMITIR !== '1') {
  console.error('Esta prueba escribe (y luego borra) datos marcados en la base configurada. Ejecútela con E2E_PERMITIR=1.');
  process.exit(2);
}

const N = ['900000911', '900000912', '900000913', '900000914', '900000915', '900000916', '900000917'];
const IMEI = ['990000000000011', '990000000000012', '990000000000013'];
const RECIBO = ['990000001', '990000002', '990000003'];
const AREA = 'PRUEBA-E2E';
const results = [];
const check = (name, cond) => results.push([!!cond, name]);

async function cleanup() {
  const [bills] = await pool.query('SELECT archivo_guardado FROM mobile_bills WHERE recibo_nro IN (?)', [RECIBO]);
  bills.forEach((b) => { if (b.archivo_guardado) fs.rmSync(path.join(DIRS.recibos, b.archivo_guardado), { force: true }); });
  await pool.query('DELETE FROM mobile_bills WHERE recibo_nro IN (?)', [RECIBO]);
  await pool.query('DELETE FROM mobile_lines WHERE phone_number IN (?)', [N]);
  await pool.query('DELETE FROM mobile_devices WHERE imei IN (?)', [IMEI]);
  await pool.query("DELETE FROM audit_log WHERE target LIKE 'Recibo Entel 99000000%'");
}

// Excel con la misma estructura que entrega Entel (encabezado en 4 filas).
async function entelExcel({ recibo, total, lines, charges, extraSheetName, emision }) {
  const wb = new ExcelJS.Workbook();
  const res = wb.addWorksheet('Resumen');
  [['Razón Social:', 'EMPRESA DE PRUEBA SAC'], ['Recibo Nº:', recibo], ['Emisión del recibo:', emision || new Date(Date.UTC(2026, 8, 22))],
    ['Cuenta:', '9.99999999'], ['Inicio del Periodo:', 46288], ['Fin del Periodo:', '22/10/2026'], ['RUC:', '20999999999'],
    ['Recibo del Mes:', total], ['ÚLTIMO DIA DE PAGO:', new Date(Date.UTC(2026, 9, 5))]].forEach((r) => res.addRow(r));
  const sh = wb.addWorksheet(extraSheetName || '9.99999999');
  sh.addRow(['Recibo Nº', 'Cuenta', 'Número Entel', 'Plan Tarifario', 'MONTOS EN S/']);
  sh.addRow([null, null, null, null, 'Cargo Fijo', 'Prom. y Dsctos.', 'Otros Servicios Contratados', null, null, 'Consumos Adicionales',
    ...Array(8).fill(null), 'MONTO TOTAL']);
  sh.addRow([null, null, null, null, null, null, 'Paquetes Contratados']);
  sh.addRow([null, null, null, null, null, null, null, null, 'Otros Cargos']);
  lines.forEach((l) => sh.addRow([recibo, '9.99999999', l[0], l[1], l[2], l[3], ...Array(12).fill(0), l[4]]));
  const oc = wb.addWorksheet('Otros Cargos y Abonos');
  oc.addRow(['Otros Cargos y Abonos', 'TOTAL S/']);
  charges.forEach((c) => oc.addRow(c));
  oc.addRow(['', charges.reduce((s, c) => s + c[1], 0)]);
  wb.addWorksheet('Otros Cargos y Abonos (con IGV)').addRow(['Otros Cargos y Abonos (Ya gravados con IGV)', 'TOTAL S/']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const LINES = [
  [N[0], 'Empresa CORP 2.0 42.9', 42.9, -21.45, 21.45], // chip en un celular asignado
  [N[1], 'Empresa CORP 2.0 31.9', 31.9, -15.95, 15.95], // chip en stock
  [N[2], 'Empresa CORP 2.0 31.9', 31.9, -15.95, 15.95], // no esta en el inventario
  [N[3], 'Empresa CORP 2.0 79.9', 79.9, -39.95, 39.95], // no esta en el inventario
  [N[4], 'Empresa CORP 2.0 31.9', 31.9, -15.95, 15.95], // chip dado de baja
];
const CHARGES = [
  [`Cuota Diferida - ZTE BLADE A76 256GB BK 5G - IMEI: ${IMEI[0]} - Folio Venta: F999-00000001`, 16.11],
  [`Cuota Diferida - ZTE BLADE A75 256GB 5G BK - IMEI: ${IMEI[1]} - Folio Venta: F999-00000002`, 18],
  [`Cuota Diferida - APPLE IPHONE 17 PRO 256GB SLV - IMEI: ${IMEI[2]} - Folio Venta: F999-00000003`, 250.02],
];
const TOTAL = 109.25 + 284.13;

// Renglones de texto con el formato del PDF de Entel (ver pdfText.js).
const PDF_LINES = [
  '¡Hola! Te enviamos tu recibo del mes', 'EMPRESA DE PRUEBA SAC', 'Entel Perú S.A. Av De Prueba 123', 'RUC: 20106897914',
  'Página 1 de 9',
  'Recibo Nº : S002-990000002 Inicio del Periodo : 23/Sep/2026 Nº de Cuenta : 9.99999999',
  'Emisión : 22/Sep/2026 Fin del Periodo : 22/Oct/2026 Nº Doc (RUC) : 20999999999',
  'Total a pagar', 'S/ 1,234.56', 'Vencimiento', '05/Oct/2026 S/ 74.80 S/ 0.00 S/ 0.00 -S/ 37.40 S/ 33.33 S/ 5.00',
  'Resumen',
  `${N[0]} Empresa CORP 2.0 42.9 42.90 0.00 0.00 -21.45 0.00 0.00 21.45`,
  `${N[1]} Empresa CORP 2.0 31.9 31.90 0.00 3.50 -15.95 0.00 0.00 19.45`,
  'Cuenta', 'Cliente 0.00 0.00 0.00 0.00 33.33 0.00 33.33',
  'Cuenta Cliente 0.00 0.00 0.00 0.00 33.33 0.00 33.33',
  'Total 74.80 0.00 3.50 -37.40 33.33 0.00 74.23',
  'Conceptos detallados Período Unidad Monto S/ (Incl. IGV)',
  `${N[0]} (Empresa CORP 2.0 42.9) 21.45`, 'Plan 23-ago al 22-sep 30 días 42.90', 'Descuentos -21.45',
  'Descuento 50% Cargo Fijo 23-ago al 22-sep 30 días -21.45',
  `${N[1]} (Empresa CORP 2.0 31.9) 19.45`, 'Plan 23-ago al 22-sep 30 días 31.90', 'Descuentos -15.95',
  'MA01 - Descuentos por fidelizacion 50% x 18m (11/18) 23-ago al 22-sep 30 días -15.95',
  'Cuenta Cliente 33.33', 'Equipos 33.33',
  `Cuota Diferida - ZTE BLADE A76 256GB BK 5G - IMEI: ${IMEI[0]} -`,
  'Página 2 de 9', 'Mira aquí el detalle', 'tu recibo', 'Conceptos detallados Período Unidad Monto S/ (Incl. IGV)',
  'Folio Venta: F999-00000001 5/18 16.11',
  `Cuota Diferida - ZTE BLADE A75 256GB 5G BK - IMEI: ${IMEI[1]} - Folio Venta: F999-00000002 17/18 17.22`,
  'Saldos Anteriores 5.00', 'Recibo(s) anterior(es) 5.00', 'Abonos / Cargos varios al 22/09/2026 0.00',
  'Conceptos facturables', 'Cargo Fijo (incluye prorrateo): Monto de Renta Mensual y consumo proporcional 12.00',
];

async function main() {
  const [[admin]] = await pool.query("SELECT id, email, full_name, role FROM users WHERE role IN ('superadmin', 'admin') ORDER BY role = 'superadmin' DESC, id LIMIT 1");
  const [[peru]] = await pool.query("SELECT id FROM phone_country_codes WHERE calling_code = '51' LIMIT 1");
  await cleanup(); // restos de una corrida anterior interrumpida

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
  app.use('/celulares/recibos', require(path.join(ROOT, 'src/routes/mobileBills')));
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
  const upload = (buffer, name) => {
    const form = new FormData();
    form.append('_csrf', CSRF);
    form.append('file', new Blob([buffer]), name);
    return post('/celulares/recibos/subir', form);
  };
  const q = async (sql, params) => (await pool.query(sql, params))[0];
  const chip = async (num) => (await q('SELECT * FROM mobile_lines WHERE phone_number = ?', [num]))[0];
  const bill = async (nro) => (await q('SELECT * FROM mobile_bills WHERE recibo_nro = ?', [nro]))[0];

  try {
    // --- Lectores (sin base de datos)
    check('Fechas: Date, serie de Excel, 22/10/2026 y 22/Sep/2026', common.isoDate(new Date(Date.UTC(2026, 8, 22))) === '2026-09-22'
      && common.isoDate(46288) === '2026-09-23' && common.isoDate('22/10/2026') === '2026-10-22' && common.isoDate('05/Oct/2026') === '2026-10-05'
      && common.isoDate('99/99/2026') === null);
    check('El número de recibo es el mismo con serie (PDF) y sin serie (Excel)', common.reciboNumber('S002-990000001') === '990000001'
      && common.reciboNumber(990000001) === '990000001');
    check('PDF: se reconoce como recibo de Entel', entelPdf.detect(PDF_LINES) && !entelPdf.detect(['Factura de otra empresa', 'Recibo Nº : 1']));
    const pdf = entelPdf.parse(PDF_LINES);
    check('PDF: encabezado (recibo, cuenta, RUC, fechas, total, razón social)', pdf.recibo_nro === RECIBO[1] && pdf.cuenta === '9.99999999'
      && pdf.ruc === '20999999999' && pdf.fecha_emision === '2026-09-22' && pdf.periodo_inicio === '2026-09-23' && pdf.periodo_fin === '2026-10-22'
      && pdf.fecha_vencimiento === '2026-10-05' && pdf.total_pagar === 1234.56 && pdf.razon_social === 'EMPRESA DE PRUEBA SAC');
    check('PDF: una fila por número, sin tomar "Cuenta Cliente" ni "Total" como líneas', pdf.lines.length === 2
      && pdf.lines[0].cargo_fijo === 42.9 && pdf.lines[0].descuento === -21.45 && pdf.lines[0].monto_total === 21.45
      && pdf.lines[1].otros === 3.5 && pdf.lines[1].monto_total === 19.45);
    check('PDF: tipo de descuento y avance de la fidelización (11/18)', pdf.lines[0].descuento_tipo === 'Descuento 50% Cargo Fijo'
      && pdf.lines[0].descuento_cuotas === null && pdf.lines[1].descuento_tipo === 'MA01 - Descuentos por fidelizacion 50% x 18m'
      && pdf.lines[1].descuento_cuota === 11 && pdf.lines[1].descuento_cuotas === 18);
    check('PDF: cuotas de equipos, también la partida en dos renglones y con salto de página', pdf.charges.length === 2
      && pdf.charges[0].imei === IMEI[0] && pdf.charges[0].folio === 'F999-00000001' && pdf.charges[0].cuota_nro === 5
      && pdf.charges[0].cuota_total === 18 && pdf.charges[0].monto === 16.11 && pdf.charges[0].modelo === 'ZTE BLADE A76 256GB BK 5G'
      && pdf.charges[1].imei === IMEI[1] && pdf.charges[1].cuota_nro === 17 && pdf.charges[1].monto === 17.22);
    check('PDF: saldo anterior, y el glosario del final no se cuenta como cargo', pdf.saldo_anterior === 5);
    const rd = billService.recurringDiscount;
    check('Descuento mensual: del porcentaje si el recibo lo dice (línea prorrateada), si no del monto, nunca más que el cargo fijo',
      rd({ cargo_fijo: 31.9, descuento: -28.18, descuento_tipo: 'Descuento 50% Cargo Fijo' }) === 15.95
      && rd({ cargo_fijo: 31.9, descuento: -15.95, descuento_tipo: null }) === 15.95
      && rd({ cargo_fijo: 31.9, descuento: -40, descuento_tipo: null }) === 31.9 && rd({ cargo_fijo: 31.9, descuento: 0, descuento_tipo: null }) === 0);

    // --- Inventario de partida
    const [d1] = await pool.query(
      "INSERT INTO mobile_devices (imei, phone_country_code_id, phone_number, has_chip, area, sede, status) VALUES (?, ?, ?, 1, ?, 'SEDE-E2E', 'asignado')",
      [IMEI[0], peru.id, N[0], AREA]
    );
    await pool.query("INSERT INTO mobile_devices (imei, has_chip, area, status) VALUES (?, 0, ?, 'en_stock')", [IMEI[1], AREA]);
    await pool.query("INSERT INTO mobile_device_assignments (device_id, holder_name) VALUES (?, 'Persona De Prueba')", [d1.insertId]);
    await pool.query('INSERT INTO mobile_lines (phone_country_code_id, phone_number, device_id) VALUES (?, ?, ?)', [peru.id, N[0], d1.insertId]);
    await pool.query("INSERT INTO mobile_lines (phone_number, operadora) VALUES (?, 'Entel')", [N[1]]);
    await pool.query("INSERT INTO mobile_lines (phone_number, operadora, estado) VALUES (?, 'Entel', 'de_baja')", [N[4]]);
    await pool.query("INSERT INTO mobile_lines (phone_number, operadora) VALUES (?, 'Entel')", [N[5]]); // no facturado
    await pool.query("INSERT INTO mobile_lines (phone_number, operadora) VALUES (?, 'Claro')", [N[6]]); // otra operadora

    // --- Subir el Excel
    const xlsx = await entelExcel({ recibo: RECIBO[0], total: TOTAL, lines: LINES, charges: CHARGES });
    let r = await upload(xlsx, 'EXCEL-990000001.xlsx');
    let b = await bill(RECIBO[0]);
    check('Subir el Excel de Entel: se guarda el recibo y va a su cruce', r.status === 302 && b && r.location === `/celulares/recibos/${b.id}`
      && /5 líneas y 3 equipos/.test(r.ok[0] || ''));
    check('Encabezado del Excel: operadora, cuenta, fechas, total y origen', b.operadora === 'Entel' && b.cuenta === '9.99999999'
      && b.fecha_emision === '2026-09-22' && b.periodo_inicio === '2026-09-23' && b.periodo_fin === '2026-10-22'
      && b.fecha_vencimiento === '2026-10-05' && Number(b.total_pagar) === 393.38 && b.origen === 'excel' && b.uploaded_by === admin.id);
    check('Totales leídos: líneas 109.25 y cuotas 284.13 (la fila de total no se cuenta)', Number(b.total_lineas) === 109.25
      && Number(b.total_cargos) === 284.13);
    check('El archivo original queda guardado', fs.existsSync(path.join(DIRS.recibos, b.archivo_guardado)));
    r = await req('GET', `/celulares/recibos/${b.id}/archivo`);
    check('Se puede descargar el archivo original', r.status === 200 && r.buffer.equals(xlsx));

    // --- Cruce
    let rec = await billService.reconcile(await billService.getBill(b.id));
    const res = (rows, key, v) => rows.find((x) => x[key] === v) || {};
    check('Líneas: 1 coincide, 2 observadas, 2 faltantes, con sus montos', rec.stats.lineas.coincide.cantidad === 1
      && rec.stats.lineas.observado.cantidad === 2 && rec.stats.lineas.faltante.cantidad === 2 && rec.stats.lineas.faltante.monto === 55.9
      && rec.stats.lineas.monto === 109.25);
    check('Línea en un celular asignado: coincide y trae usuario, sede e IMEI', res(rec.lineas, 'phone_number', N[0]).resultado === 'coincide'
      && res(rec.lineas, 'phone_number', N[0]).holder === 'Persona De Prueba' && res(rec.lineas, 'phone_number', N[0]).imei === IMEI[0]
      && res(rec.lineas, 'phone_number', N[0]).sede === 'SEDE-E2E');
    check('Chip en stock y chip de baja que se facturan: observados, con el motivo', /en stock/.test(res(rec.lineas, 'phone_number', N[1]).detalle)
      && /dado de baja/.test(res(rec.lineas, 'phone_number', N[4]).detalle));
    check('Equipos: IMEI asignado coincide, sin número observado, desconocido faltante', res(rec.equipos, 'imei', IMEI[0]).resultado === 'coincide'
      && res(rec.equipos, 'imei', IMEI[1]).resultado === 'observado' && res(rec.equipos, 'imei', IMEI[2]).resultado === 'faltante'
      && rec.stats.equipos.faltante.monto === 250.02);
    check('Inventario → recibo: chip no facturado es faltante; el dado de baja y el de otra operadora no se comparan',
      res(rec.inventario, 'phone_number', N[5]).resultado === 'faltante' && res(rec.inventario, 'phone_number', N[0]).resultado === 'coincide'
      && !rec.inventario.some((x) => x.phone_number === N[4] || x.phone_number === N[6]) && rec.stats.otrasOperadoras >= 1);
    check('Inventario → recibo: equipo sin número cuyo IMEI sí tiene cuota', /sí tiene cuota/.test(res(rec.inventario, 'imei', IMEI[1]).detalle || ''));
    check('Resumen por plan, con los faltantes de cada uno', rec.stats.porPlan.length === 3
      && res(rec.stats.porPlan, 'plan', 'Empresa CORP 2.0 31.9').lineas === 3 && res(rec.stats.porPlan, 'plan', 'Empresa CORP 2.0 79.9').faltantes === 1);

    // --- Pantallas y exportacion
    r = await req('GET', '/celulares/recibos');
    check('Lista de recibos: muestra el recibo y sus 2 líneas sin inventariar', r.status === 200 && r.text.includes(RECIBO[0])
      && r.text.includes('resultado=faltante" class="badge bg-danger text-decoration-none">2<'));
    r = await req('GET', `/celulares/recibos/${b.id}`);
    check('Pantalla del cruce', r.status === 200 && r.text.includes('Registrar los 2 números faltantes como chips') && r.text.includes(N[2])
      && !r.text.includes('no cuadra'));
    r = await req('GET', `/celulares/recibos/${b.id}?vista=lineas&resultado=faltante&q=79.9`);
    check('Filtros combinados (resultado + texto)', r.text.includes(N[3]) && !r.text.includes(`>${N[2]}<`) && r.text.includes('1 fila(s)'));
    r = await req('GET', `/celulares/recibos/${b.id}?vista=equipos`);
    check('Vista de equipos', r.status === 200 && r.text.includes(IMEI[2]) && r.text.includes('IMEI no figura en el inventario'));
    r = await req('GET', `/celulares/recibos/${b.id}?vista=inventario`);
    check('Vista de inventario', r.status === 200 && r.text.includes(N[5]));
    r = await req('GET', `/celulares/recibos/${b.id}/exportar.xlsx`);
    const out = new ExcelJS.Workbook();
    await out.xlsx.load(r.buffer);
    check('Exportar a Excel: hojas de estadísticas, faltantes y los tres cruces', r.status === 200
      && ['Estadísticas', 'Faltantes', 'Recibo', 'Equipos recibo', 'Inventario vs recibo'].every((n) => out.getWorksheet(n))
      && out.getWorksheet('Recibo').rowCount === 6 && String(out.getWorksheet('Recibo').getCell('A2').value) === N[0]);

    // --- Volver a subir el mismo recibo
    r = await upload(xlsx, 'EXCEL-990000001.xlsx');
    const again = await bill(RECIBO[0]);
    check('Subir de nuevo el mismo recibo lo reemplaza, sin duplicar', /reemplazado/.test(r.ok[0] || '') && again.id === b.id
      && (await q('SELECT COUNT(*) AS n FROM mobile_bill_lines WHERE bill_id = ?', [b.id]))[0].n === 5
      && !fs.existsSync(path.join(DIRS.recibos, b.archivo_guardado)) && fs.existsSync(path.join(DIRS.recibos, again.archivo_guardado)));

    // --- Registrar los faltantes como chips
    r = await post(`/celulares/recibos/${b.id}/crear-chips`, { numbers: '' });
    check('Registrar marcados sin marcar nada: avisa y no crea', r.errors.length === 1 && !(await chip(N[2])));
    r = await post(`/celulares/recibos/${b.id}/crear-chips`, { numbers: `${N[2]},${N[0]},000` });
    let c3 = await chip(N[2]);
    check('Registrar solo los marcados: crea ese chip y nada más', /^1 chip/.test(r.ok[0] || '') && c3 && !(await chip(N[3])));
    check('El chip nuevo guarda los dos montos: costo sin descuento 31.90 y descuento 15.95, con su detalle', Number(c3.costo_plan) === 31.9
      && Number(c3.descuento_plan) === 15.95 && c3.descuento_nota === `Promociones y descuentos (recibo ${RECIBO[0]})`);
    check('El chip nuevo queda en stock con operadora, plan, país y nota del recibo', c3.operadora === 'Entel'
      && c3.plan === 'Empresa CORP 2.0 31.9' && c3.estado === 'activo' && c3.device_id === null
      && c3.phone_country_code_id === peru.id && c3.notes === `Creado desde el recibo Entel N.º ${RECIBO[0]}` && c3.created_by === admin.id);
    r = await post(`/celulares/recibos/${b.id}/crear-chips`, { todos: '1' });
    check('Registrar todos los faltantes: crea los que quedaban', /^1 chip/.test(r.ok[0] || '') && Number((await chip(N[3])).costo_plan) === 79.9
      && Number((await chip(N[3])).descuento_plan) === 39.95);
    r = await post(`/celulares/recibos/${b.id}/crear-chips`, { todos: '1' });
    check('Repetirlo no duplica chips', /No había números faltantes/.test(r.ok[0] || '')
      && (await q('SELECT COUNT(*) AS n FROM mobile_lines WHERE phone_number IN (?)', [N]))[0].n === 7);
    rec = await billService.reconcile(await billService.getBill(b.id));
    check('El cruce se recalcula: ya no hay faltantes (pasan a observados: chips en stock)', rec.stats.lineas.faltante.cantidad === 0
      && rec.stats.lineas.observado.cantidad === 4);

    // --- Actualizar plan y costo
    r = await post(`/celulares/recibos/${b.id}/actualizar-planes`, {});
    const c1 = await chip(N[0]);
    const dev = (await q('SELECT operadora FROM mobile_devices WHERE imei = ?', [IMEI[0]]))[0];
    check('Actualizar planes: copia plan, costo sin descuento, descuento y operadora vacía al chip y a su celular',
      /chip\(s\) actualizados/.test(r.ok[0] || '') && c1.plan === 'Empresa CORP 2.0 42.9' && Number(c1.costo_plan) === 42.9
      && Number(c1.descuento_plan) === 21.45 && c1.operadora === 'Entel' && dev.operadora === 'Entel');
    const lineSvc = require(path.join(ROOT, 'src/services/mobileLineService'));
    const tot = lineSvc.summarize(await lineSvc.listLines({ q: '9000009', operadora: 'Entel', costo: 'con' }));
    check('Listado de chips: suma sin descuento (186.60), descuento (93.30) y lo que se paga (93.30)', tot.costoTotal === 186.6
      && tot.descuentoTotal === 93.3 && tot.netoTotal === 93.3 && tot.conDescuento === 4);
    check('Actualizar planes no toca el chip dado de baja ni el no facturado', (await chip(N[4])).plan === null && (await chip(N[5])).plan === null);
    r = await post(`/celulares/recibos/${b.id}/actualizar-planes`, {});
    check('Repetirlo informa que no había cambios', /ya tenían/.test(r.ok[0] || ''));

    // --- Archivos que no se aceptan
    const antes = (await q('SELECT COUNT(*) AS n FROM mobile_bills'))[0].n;
    r = await upload(Buffer.from('hola'), 'recibo.txt');
    check('Archivo que no es PDF ni Excel: se rechaza con mensaje', /PDF o en Excel/.test(r.errors[0] || ''));
    const otro = new ExcelJS.Workbook();
    otro.addWorksheet('Hoja1').addRow(['Nombre', 'Monto']);
    r = await upload(Buffer.from(await otro.xlsx.writeBuffer()), 'cualquiera.xlsx');
    check('Excel de otro formato: se rechaza indicando los formatos admitidos', /No se reconoce el formato/.test(r.errors[0] || '')
      && /Entel/.test(r.errors[0] || ''));
    r = await upload(Buffer.from('%PDF-1.4 roto'), 'roto.pdf');
    check('PDF dañado: se rechaza con mensaje', /No se pudo abrir el PDF/.test(r.errors[0] || ''));
    r = await upload(await entelExcel({ recibo: RECIBO[2], total: 1, lines: [LINES[0], LINES[0]], charges: [] }), 'repetido.xlsx');
    check('Recibo con un número repetido: no se carga nada', /más de una vez/.test(r.errors[0] || '') && !(await bill(RECIBO[2])));
    check('Ningún archivo rechazado dejó un recibo', (await q('SELECT COUNT(*) AS n FROM mobile_bills'))[0].n === antes);

    // --- Recibo que no cuadra
    r = await upload(await entelExcel({ recibo: RECIBO[2], total: TOTAL + 10, lines: LINES, charges: CHARGES }), 'descuadre.xlsx');
    const b3 = await bill(RECIBO[2]);
    r = await req('GET', `/celulares/recibos/${b3.id}`);
    check('Recibo cuyo total no cuadra con lo leído: se carga y lo advierte', r.text.includes('El recibo no cuadra por S/ 10.00'));

    // --- Mes siguiente: que entro y que salio
    r = await upload(await entelExcel({
      recibo: RECIBO[1], total: 93.3 + 34.11, emision: new Date(Date.UTC(2026, 9, 22)),
      lines: [...LINES.slice(0, 4), [N[5], 'Empresa CORP 2.0 31.9', 31.9, -15.95, 15.95]], charges: CHARGES.slice(0, 2),
    }), 'octubre.xlsx');
    const b2 = await bill(RECIBO[1]);
    const ch = (await billService.reconcile(await billService.getBill(b2.id))).stats.cambios;
    check('Cambios respecto al recibo anterior: 1 línea nueva, 1 que ya no se factura, 1 equipo que dejó de cobrarse', ch
      && ch.altas.join() === N[5] && ch.bajas.join() === N[4] && ch.equiposTerminados.join() === IMEI[2] && ch.equiposNuevos.length === 0);
    r = await req('GET', `/celulares/recibos/${b2.id}?vista=lineas&cambio=alta`);
    check('Pantalla: resumen de cambios y filtro de líneas nuevas', r.text.includes('Respecto al recibo anterior') && r.text.includes('1 fila(s)')
      && r.text.includes(N[5]) && r.text.includes(`números que ya no se facturan`));
    const evo = (await billService.monthlyEvolution()).filter((e) => RECIBO.includes(e.recibo_nro));
    const e2 = evo.find((e) => e.recibo_nro === RECIBO[1]);
    check('Evolución mensual: líneas, monto sin descuento, cambios y variación del total', e2 && e2.lineas === 5 && Number(e2.cargo_fijo) === 218.5
      && e2.cambios.altas === 1 && e2.cambios.bajas === 1 && e2.cambios.equiposTerminados === 1 && e2.variacion === -275.97);
    r = await req('GET', '/celulares/recibos');
    check('Lista de recibos: tabla de evolución mes a mes', r.status === 200 && r.text.includes('Evolución mes a mes') && r.text.includes('2026-10-22'));

    // --- El PDF manda sobre el Excel
    await pool.query("UPDATE mobile_bills SET origen = 'pdf' WHERE id = ?", [b.id]);
    r = await upload(xlsx, 'EXCEL-990000001.xlsx');
    check('Recibo ya cargado desde PDF: el Excel no lo pisa', /ya está cargado desde su PDF/.test(r.errors[0] || '')
      && (await bill(RECIBO[0])).origen === 'pdf');

    // --- Eliminar
    const guardado = (await bill(RECIBO[0])).archivo_guardado;
    r = await post(`/celulares/recibos/${b.id}/eliminar`, {});
    check('Eliminar el recibo borra sus filas y su archivo, no el inventario', !(await bill(RECIBO[0]))
      && (await q('SELECT COUNT(*) AS n FROM mobile_bill_lines WHERE bill_id = ?', [b.id]))[0].n === 0
      && !fs.existsSync(path.join(DIRS.recibos, guardado)) && (await chip(N[2])));
    r = await req('GET', `/celulares/recibos/${b.id}`);
    check('Recibo inexistente: vuelve a la lista', r.status === 302 && r.location === '/celulares/recibos');
    await pool.query('DELETE FROM mobile_bills WHERE recibo_nro = ?', [RECIBO[1]]);
    check('Quedó registrado en la auditoría', (await q("SELECT COUNT(DISTINCT action) AS n FROM audit_log WHERE target LIKE 'Recibo Entel 99000000%'"))[0].n === 5);
  } finally {
    server.close();
    await cleanup();
    const left = await q('SELECT (SELECT COUNT(*) FROM mobile_lines WHERE phone_number IN (?)) + (SELECT COUNT(*) FROM mobile_bills WHERE recibo_nro IN (?)) AS n', [N, RECIBO]);
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
