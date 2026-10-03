// Prueba de extremo a extremo del doble SIM, los chips de repuesto y el
// registro del 2.o chip desde las notas de los celulares.
//
// Monta las rutas REALES con sesion de administrador simulada y trabaja
// contra la base configurada, con datos marcados que se borran al final
// (IMEI 99000000000006x, numeros 9000006xx, DNI 9999996x, operadora
// PRUEBA-OP y su recibo). Por eso pide E2E_PERMITIR=1.
//
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/celulares_doble_sim.e2e.js
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
const lineService = require(path.join(ROOT, 'src/services/mobileLineService'));
const notesService = require(path.join(ROOT, 'src/services/mobileLineNotesService'));
const reportService = require(path.join(ROOT, 'src/services/reportService'));

const IMEI = ['990000000000061', '990000000000062', '990000000000063', '990000000000064', '990000000000065'];
const N = Array.from({ length: 12 }, (_, i) => `9000006${String(i + 10)}`); // 900000610 ... 900000621
const DNI = '99999961';
const AREA = 'PRUEBA-DOBLESIM';
const OP = 'PRUEBA-OP';
const results = [];
const check = (name, cond) => results.push([!!cond, name]);
const q = async (sql, params) => (await pool.query(sql, params))[0];

async function cleanup() {
  await q('DELETE FROM mobile_lines WHERE phone_number IN (?)', [N]);
  await q('DELETE FROM mobile_devices WHERE imei IN (?)', [IMEI]);
  await q('DELETE FROM employees WHERE dni = ?', [DNI]);
  await q('DELETE FROM mobile_bills WHERE operadora = ?', [OP]);
  await q("DELETE FROM audit_log WHERE target LIKE 'Chip 9000006%' OR detail LIKE '%99000000000006%' OR action = 'chips_desde_notas' AND created_at > NOW() - INTERVAL 10 MINUTE");
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
  app.use('/empleados', require(path.join(ROOT, 'src/routes/employees')));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const req = async (method, url, form) => {
    const opts = { method, redirect: 'manual', headers: { cookie } };
    if (form) {
      const body = new URLSearchParams({ _csrf: CSRF });
      Object.entries(form).forEach(([k, v]) => (Array.isArray(v) ? v : [v]).forEach((x) => body.append(k, x)));
      opts.body = body.toString();
      opts.headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const r = await fetch(base + url, opts);
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  };
  const follow = async (r) => (r.location ? req('GET', r.location.split('#')[0]) : r);
  const device = async (imei) => (await q('SELECT * FROM mobile_devices WHERE imei = ?', [imei]))[0];
  const line = async (num) => (await q('SELECT * FROM mobile_lines WHERE phone_number = ?', [num]))[0];
  const chipsOf = async (id) => (await q('SELECT phone_number FROM mobile_lines WHERE device_id = ? ORDER BY phone_number', [id])).map((r) => r.phone_number);

  try {
    // Celulares de prueba: A con su chip principal; B y C sin chip; D y E para las notas.
    await q('INSERT INTO mobile_devices (imei, asset_code, model, area, sede, status, has_chip, phone_number) VALUES (?), (?), (?), (?), (?)', [
      [IMEI[0], 'A-90061', 'A75', AREA, 'Sede Prueba', 'asignado', 1, N[0]], [IMEI[1], 'A-90062', 'A75', AREA, null, 'en_stock', 0, null],
      [IMEI[2], 'A-90063', 'A58', AREA, null, 'en_stock', 0, null], [IMEI[3], 'A-90064', 'A15', AREA, null, 'asignado', 1, N[6]],
      [IMEI[4], 'A-90065', 'A15', AREA, null, 'asignado', 1, N[9]],
    ]);
    const A = await device(IMEI[0]);
    const D = await device(IMEI[3]);
    const E = await device(IMEI[4]);
    await q('INSERT INTO mobile_lines (phone_number, operadora, device_id) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)', [N[0], 'Entel', A.id, N[6], 'Entel', D.id, N[9], 'Entel', E.id]);

    // --- A. Agregar el 2.o chip desde la ficha del celular
    let p = await req('GET', `/celulares/${A.id}`);
    check('Ficha del celular: muestra cuántos chips tiene de 2 y ofrece agregar el 2.º chip', p.status === 200 && p.text.includes('(1 de 2)')
      && p.text.includes('Agregar 2.º chip (doble SIM)') && p.text.includes(`action="/celulares/${A.id}/chips/agregar"`));
    let r = await req('POST', `/celulares/${A.id}/chips/agregar`, { numero: `${N[1].slice(0, 3)} ${N[1].slice(3, 6)} ${N[1].slice(6)}`, operadora: 'Claro', iccid: '' });
    p = await follow(r);
    let l1 = await line(N[1]);
    check('Agregar un número que no existe: se registra como chip y queda como 2.º chip (aunque se escriba con espacios)', l1 && String(l1.device_id) === String(A.id)
      && l1.operadora === 'Claro' && (await device(IMEI[0])).phone_number === N[0] && p.text.includes('registrado y puesto como 2.º chip') && p.text.includes('(2 de 2)'));
    check('Con 2 chips ya no ofrece agregar otro y explica el repuesto', !p.text.includes('Agregar 2.º chip') && p.text.includes('como <strong>repuesto</strong>'));

    // --- B. Tope de 2 chips
    await q('INSERT INTO mobile_lines (phone_number, operadora) VALUES (?, ?)', [N[2], 'Entel']);
    r = await req('POST', `/celulares/${A.id}/chips/agregar`, { numero: N[2] });
    p = await follow(r);
    check('Un 3.er chip desde la ficha del celular: rechazado con explicación', p.text.includes('ya tiene 2 chips') && !(await line(N[2])).device_id);
    r = await req('POST', `/celulares/${A.id}/chips/agregar`, { numero: N[3] });
    check('Un 3.er chip que no existía tampoco se registra a medias', !(await line(N[3])));
    const l2 = await line(N[2]);
    r = await req('POST', `/celulares/chips/${l2.id}/poner`, { device: IMEI[0] });
    p = await follow(r);
    check('Poner un 3.er chip desde la ficha del chip: rechazado igual', p.text.includes('ya tiene 2 chips') && !(await line(N[2])).device_id);
    check('Cambiar el número principal en el formulario del celular sigue permitido (sale el anterior)', (await lineService.deviceChipConflict(N[2], A.id)) === null);

    // --- Hacer principal y retirar
    r = await req('POST', `/celulares/${A.id}/chips/${l1.id}/principal`, {});
    p = await follow(r);
    const A2 = await device(IMEI[0]);
    check('Hacer principal: el 2.º chip pasa a ser el número del celular y el anterior queda como 2.º', A2.phone_number === N[1] && A2.operadora === 'Claro'
      && JSON.stringify(await chipsOf(A.id)) === JSON.stringify([N[0], N[1]]) && p.text.includes('es ahora el número principal'));
    const l0 = await line(N[0]);
    r = await req('POST', `/celulares/${A.id}/chips/${l0.id}/retirar`, {});
    check('Retirar el 2.º chip: queda en stock y el celular conserva su principal', !(await line(N[0])).device_id && (await device(IMEI[0])).phone_number === N[1]
      && (await chipsOf(A.id)).length === 1);
    r = await req('POST', `/celulares/${A.id}/chips/${l2.id}/retirar`, {});
    p = await follow(r);
    check('Retirar un chip que no está en ese celular: rechazado', p.text.includes('Ese chip no está en este celular'));
    await req('POST', `/celulares/${A.id}/chips/agregar`, { numero: N[0] });
    check('Agregar un chip que ya existe en stock: se toma ese (no se duplica)', (await q('SELECT COUNT(*) AS n FROM mobile_lines WHERE phone_number = ?', [N[0]]))[0].n === 1
      && String((await line(N[0])).device_id) === String(A.id));

    // --- C. Numero 2 en listado, Excel y reporte
    p = await req('GET', `/celulares?area=${encodeURIComponent(AREA)}`);
    check('Listado de celulares: columna "Número 2" con el 2.º chip', p.text.includes('<th data-col="numero2">Número 2</th>') && p.text.includes(`<td data-col="numero2">${N[0]}</td>`));
    const x = await fetch(`${base}/celulares/exportar.xlsx?area=${encodeURIComponent(AREA)}`, { headers: { cookie } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await x.arrayBuffer()));
    const sheet = wb.worksheets[0];
    const head = sheet.getRow(1).values;
    let rowA = null;
    sheet.eachRow((row) => { if (row.values.includes(IMEI[0])) rowA = row; });
    check('Excel de celulares: columna "Número 2 (doble SIM)" al final (la plantilla de importación no cambia)', x.status === 200 && head.indexOf('Número 2 (doble SIM)') === head.length - 1
      && head[1] === 'IMEI' && rowA && rowA.getCell(head.indexOf('Número 2 (doble SIM)')).value === N[0]);
    const rep = await reportService.run(reportService.REPORTS.celulares, { f_area: AREA });
    const repA = rep.rows.find((row) => row.imei === IMEI[0]);
    check('Reporte de celulares: "Número 2" en pantalla y Excel, y los dos números en el PDF', repA.numero_2 === N[0] && repA.numeros === `${N[1]}\n${N[0]}`
      && reportService.REPORTS.celulares.columns.some((c) => c.key === 'numero_2') && reportService.REPORTS.celulares.print.some((c) => c.key === 'numeros'));

    // --- E. Chips de repuesto a una persona
    for (const n of [N[2], N[3], N[4]]) {
      if (!(await line(n))) await q('INSERT INTO mobile_lines (phone_number, operadora) VALUES (?, ?)', [n, 'Entel']);
      const ln = await line(n);
      r = await req('POST', `/celulares/chips/${ln.id}/asignar`, { uso: 'repuesto', dni: DNI, first_name: 'Persona', last_name: 'Repuesto', area: AREA, assigned_date: '2026-10-01' });
    }
    p = await follow(r);
    const [emp] = await q('SELECT id FROM employees WHERE dni = ?', [DNI]);
    const asignados = await q("SELECT COUNT(*) AS n FROM mobile_line_assignments WHERE employee_id = ? AND uso = 'repuesto' AND returned_date IS NULL", [emp.id]);
    check('Una persona puede tener chips de repuesto, más allá de los 2 de su celular (3 aquí)', asignados[0].n === 3 && p.text.includes('chip de repuesto'));
    const ep = await req('GET', `/empleados/${emp.id}`);
    check('Ficha del empleado: lista sus chips sin celular con el uso "Repuesto"', ep.text.includes('Chips a su cargo sin celular (3)') && ep.text.includes('Repuesto (lo guarda una persona)')
      && [N[2], N[3], N[4]].every((n) => ep.text.includes(n)));
    const chips = lineService.summarize(await lineService.listLines({ area: AREA }));
    const conRepuesto = await lineService.listLines({ ubicacion: 'repuesto' });
    check('Chips: la ubicación "Repuesto" se cuenta aparte y se puede filtrar', conRepuesto.filter((x2) => N.includes(x2.phone_number)).length === 3 && chips.porUbicacion.repuesto === 3
      && mobileLabels.lineUbicacion('repuesto').label === 'Repuesto (lo guarda una persona)');
    const cp = await req('GET', `/celulares/chips/${(await line(N[5])) ? (await line(N[5])).id : l2.id}`);
    check('El formulario de asignar del chip ofrece el uso "Repuesto"', cp.text.includes('value="repuesto"'));

    // --- D. 2.o chip desde las notas, cruzado con el recibo
    await q('UPDATE mobile_devices SET notes = ? WHERE id = ?', [`N° 2 (uso WhatsApp): ${N[7].slice(0, 3)} ${N[7].slice(3, 6)} ${N[7].slice(6)}`, D.id]);
    await q('UPDATE mobile_devices SET notes = ? WHERE id = ?', [`WhatsApp +51 ${N[8]} - Yape ${N[9]} - IMEI ${IMEI[4]}`, E.id]);
    await q('UPDATE mobile_devices SET notes = ? WHERE id = ?', [`Antes: ${N[0]} (lo tiene A-90061)`, (await device(IMEI[1])).id]);
    await q('UPDATE mobile_devices SET notes = ? WHERE id = ?', [`N° 2 (uso WhatsApp): ${N[10]}`, (await device(IMEI[2])).id]);
    const bill = await q("INSERT INTO mobile_bills (operadora, recibo_nro, fecha_emision, total_pagar, origen) VALUES (?, 'E2E-0001', '2026-09-30', 100, 'excel')", [OP]);
    await q('INSERT INTO mobile_bill_lines (bill_id, phone_number, plan, cargo_fijo, descuento, monto_total) VALUES (?), (?), (?)',
      [[bill.insertId, N[7], 'Plan WhatsApp', 19.9, 0, 19.9], [bill.insertId, N[8], 'Plan WhatsApp', 19.9, 0, 19.9], [bill.insertId, N[11], 'Plan suelto', 9.9, 0, 9.9]]);

    const data = await notesService.candidates();
    const mine = data.items.filter((i) => [IMEI[1], IMEI[2], IMEI[3], IMEI[4]].includes(i.device.imei));
    const of = (n) => mine.find((i) => i.number === n);
    check('Halla los números en las notas con cualquier formato (espacios, +51) y no confunde un IMEI ni el propio número del celular',
      of(N[7]) && of(N[8]) && of(N[10]) && !mine.some((i) => i.number === N[9] && i.device.imei === IMEI[4]) && !mine.some((i) => i.number.length !== 9));
    check('Cruce con el recibo: los que se facturan y no existen como chip salen como faltantes, con su plan y costo', of(N[7]).billed.missing && of(N[7]).billed.plan === 'Plan WhatsApp'
      && Number(of(N[7]).billed.cargo) === 19.9 && of(N[7]).action === 'crear' && !of(N[10]).billed);
    check('Un número que ya está en otro celular no se puede registrar (y dice dónde está)', of(N[0]).action === null && of(N[0]).reason.includes('A-90061'));
    const st = data.bills.find((b) => b.bill.operadora === OP);
    check('Inventario real: líneas facturadas, registradas y faltantes del último recibo', st.total === 3 && st.registered === 0 && st.missing === 3);

    p = await req('GET', '/celulares/chips/desde-notas');
    const boxOf = (key) => (new RegExp(`value="${key}"[^>]*>`).exec(p.text) || [''])[0];
    check('Pantalla de revisión: los faltantes del recibo vienen marcados; los que no figuran, sin marcar; los imposibles, sin casilla',
      p.status === 200 && boxOf(`${D.id}:${N[7]}`).includes('checked') && boxOf(`${E.id}:${N[8]}`).includes('checked')
      && boxOf(`${(await device(IMEI[2])).id}:${N[10]}`) && !boxOf(`${(await device(IMEI[2])).id}:${N[10]}`).includes('checked')
      && !p.text.includes(`value="${(await device(IMEI[1])).id}:${N[0]}"`) && p.text.includes('id="tabla_inventario_real"'));

    r = await req('POST', '/celulares/chips/desde-notas', { items: [`${D.id}:${N[7]}`, `${E.id}:${N[8]}`, `${(await device(IMEI[1])).id}:${N[0]}`] });
    p = await follow(r);
    const c7 = await line(N[7]);
    check('Registrar: crea el chip con la operadora, el plan y el costo del recibo, y lo pone como 2.º chip del celular', c7 && String(c7.device_id) === String(D.id)
      && c7.operadora === OP && c7.plan === 'Plan WhatsApp' && Number(c7.costo_plan) === 19.9 && (await device(IMEI[3])).phone_number === N[6]
      && c7.notes.startsWith('Registrado desde las notas del celular A-90064'));
    check('La nota del celular se conserva tal cual', (await device(IMEI[3])).notes.startsWith('N° 2 (uso WhatsApp)'));
    check('Lo que no se podía registrar (ya está en otro celular) se informa y no se toca', p.text.includes('2 chip(s) registrados como 2.º chip')
      && p.text.includes('1 no se pudieron registrar') && p.text.includes('Está registrado en otro celular (A-90061)') && String((await line(N[0])).device_id) === String(A.id));
    const after = (await notesService.candidates()).bills.find((b) => b.bill.operadora === OP);
    check('Tras registrarlos, el recibo tiene 2 faltantes menos', after.registered === 2 && after.missing === 1);
    const again = (await notesService.candidates()).items.find((i) => i.number === N[7]);
    check('Un número ya registrado en su celular deja de ofrecerse', again && again.action === null && again.reason.includes('Ya está registrado'));
    const e8 = await line(N[8]);
    check('Una nota con dos números: se registra el que se marcó y el principal del equipo no se toca', String(e8.device_id) === String(E.id) && (await device(IMEI[4])).phone_number === N[9]);
    const [log] = await q("SELECT detail FROM audit_log WHERE action = 'chips_desde_notas' ORDER BY id DESC LIMIT 1");
    check('El registro desde notas queda en la auditoría, con cuántos eran faltantes del recibo', log && log.detail.startsWith('2 figuraban como faltantes'));
  } finally {
    server.close();
    await cleanup();
    const [left] = await q('SELECT (SELECT COUNT(*) FROM mobile_lines WHERE phone_number IN (?)) + (SELECT COUNT(*) FROM mobile_devices WHERE imei IN (?)) AS n', [N, IMEI]);
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
