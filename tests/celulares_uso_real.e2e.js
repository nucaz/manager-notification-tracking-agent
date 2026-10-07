// Prueba de extremo a extremo de:
//   - "Uso real de las líneas": en uso / guardado (repuesto, celular en
//     stock, stock) / facturado sin registrar / registrado sin recibo
//   - 3.er chip anotado en un celular que ya tiene 2: pasa a repuesto de
//     quien tiene el celular
//   - sesiones guardadas en la base: sobreviven a un reinicio, se alargan
//     con el uso, "mantener la sesión iniciada" = 30 días, y se cierran si
//     el usuario se desactiva
//
// Trabaja contra la base configurada con datos marcados que se borran al
// final (IMEI 99000000000004x, números 9000004xx, operadora PRUEBA-USO).
// Por eso pide E2E_PERMITIR=1.
//
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/celulares_uso_real.e2e.js
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
const usageService = require(path.join(ROOT, 'src/services/chipUsageService'));
const notesService = require(path.join(ROOT, 'src/services/mobileLineNotesService'));
const reportService = require(path.join(ROOT, 'src/services/reportService'));
const { MariaDbSessionStore } = require(path.join(ROOT, 'src/services/sessionStore'));
const { refreshSessionUser, SESSION_IDLE_MS, SESSION_REMEMBER_MS } = require(path.join(ROOT, 'src/middleware/sessionUser'));
const { completeLogin } = require(path.join(ROOT, 'src/routes/twoFactor'));

const IMEI = ['990000000000041', '990000000000042', '990000000000043'];
const N = Array.from({ length: 10 }, (_, i) => `9000004${String(i + 10)}`); // 900000410 ... 900000419
const OP = 'PRUEBA-USO';
const AREA = 'PRUEBA-USO';
const results = [];
const check = (name, cond) => results.push([!!cond, name]);
const q = async (sql, params) => (await pool.query(sql, params))[0];

async function cleanup() {
  await q('DELETE FROM mobile_lines WHERE phone_number IN (?)', [[...N, '900000420']]);
  await q('DELETE FROM mobile_devices WHERE imei IN (?)', [IMEI]);
  await q('DELETE FROM mobile_bills WHERE operadora = ?', [OP]);
  await q("DELETE FROM users WHERE email = 'sesion-e2e@prueba.invalid'");
  await q("DELETE FROM audit_log WHERE user_email = 'sesion-e2e@prueba.invalid'");
}

async function main() {
  const [admin] = await q("SELECT id, email, full_name, role FROM users WHERE role IN ('superadmin', 'admin') ORDER BY role = 'superadmin' DESC, id LIMIT 1");
  await cleanup();
  try {
    // --- Datos: A asignado con 2 chips; B en stock con 1 chip; C asignado con su chip y una nota con un 3.er numero
    await q('INSERT INTO mobile_devices (imei, asset_code, area, status, has_chip, phone_number, notes) VALUES (?), (?), (?)', [
      [IMEI[0], 'A-90041', AREA, 'asignado', 1, N[0], null], [IMEI[1], 'A-90042', AREA, 'en_stock', 1, N[2], null],
      [IMEI[2], 'A-90043', AREA, 'asignado', 1, N[8], `N° 2 (uso WhatsApp): ${N[9]}`]]);
    const dev = async (imei) => (await q('SELECT * FROM mobile_devices WHERE imei = ?', [imei]))[0];
    const [A, B, C] = [await dev(IMEI[0]), await dev(IMEI[1]), await dev(IMEI[2])];
    await q('INSERT INTO mobile_device_assignments (device_id, holder_name, assigned_date) VALUES (?, ?, CURDATE()), (?, ?, CURDATE())', [A.id, 'Usuaria Activa', C.id, 'Usuario Con Tres']);
    await q(`INSERT INTO mobile_lines (phone_number, operadora, costo_plan, estado, device_id) VALUES
      (?, ?, 30, 'activo', ?), (?, ?, 30, 'activo', ?), (?, ?, 30, 'activo', ?), (?, ?, 30, 'activo', NULL), (?, ?, 30, 'activo', NULL),
      (?, ?, 30, 'activo', NULL), (?, ?, 30, 'de_baja', NULL), (?, ?, 12.5, 'activo', ?)`,
    [N[0], OP, A.id, N[1], OP, A.id, N[2], OP, B.id, N[3], OP, N[4], OP, N[5], OP, N[6], OP, N[8], 'Otra', C.id]);
    // segunda linea en C para que tenga 2 chips
    await q("INSERT INTO mobile_lines (phone_number, operadora, costo_plan, device_id) VALUES ('900000420', ?, 5, ?)", [OP, C.id]);
    const line = async (n) => (await q('SELECT * FROM mobile_lines WHERE phone_number = ?', [n]))[0];
    // N[4] repuesto de una persona; N[5] emergencia; N[3] en stock
    await q("INSERT INTO mobile_line_assignments (line_id, holder_name, uso, assigned_date) VALUES (?, 'Guarda Repuesto', 'repuesto', CURDATE()), (?, 'Emergencias', 'emergencia', CURDATE())",
      [(await line(N[4])).id, (await line(N[5])).id]);
    // Recibo: factura N0..N5 (19.90 con 5.00 de descuento en N0), una linea que no esta en el inventario (N7) y el 3.er chip de C (N9)
    const bill = await q("INSERT INTO mobile_bills (operadora, recibo_nro, fecha_emision, total_pagar, origen) VALUES (?, 'USO-0001', '2026-09-30', 0, 'excel')", [OP]);
    await q('INSERT INTO mobile_bill_lines (bill_id, phone_number, plan, cargo_fijo, descuento, monto_total) VALUES ?', [[
      [bill.insertId, N[0], 'Plan A', 19.9, -5, 14.9], [bill.insertId, N[1], 'Plan A', 19.9, 0, 19.9], [bill.insertId, N[2], 'Plan A', 19.9, 0, 19.9],
      [bill.insertId, N[3], 'Plan A', 19.9, 0, 19.9], [bill.insertId, N[4], 'Plan A', 19.9, 0, 19.9], [bill.insertId, N[5], 'Plan A', 19.9, 0, 19.9],
      [bill.insertId, N[7], 'Plan B', 25, 0, 25], [bill.insertId, N[9], 'Plan W', 9.9, 0, 9.9]]]);

    // --- Uso real
    let u = await usageService.usage();
    const mine = (key) => u.categories[key].items.filter((i) => N.includes(i.number) || i.number === '900000420').map((i) => i.number).sort();
    check('En uso: los chips de un celular con usuario y el número de emergencia', JSON.stringify(mine('uso_celular')) === JSON.stringify(['900000420', N[0], N[1], N[8]].sort())
      && JSON.stringify(mine('uso_emergencia')) === JSON.stringify([N[5]]));
    check('Guardado: el repuesto, el chip de un celular que está en stock y el chip en stock', JSON.stringify(mine('guardado_repuesto')) === JSON.stringify([N[4]])
      && JSON.stringify(mine('guardado_celular')) === JSON.stringify([N[2]]) && JSON.stringify(mine('guardado_stock')) === JSON.stringify([N[3]]));
    check('El chip de baja no suma a lo que se paga', JSON.stringify(mine('baja')) === JSON.stringify([N[6]]) && u.categories.baja.monthly === 0);
    const item = (key, n) => u.categories[key].items.find((i) => i.number === n);
    check('El monto sale del recibo (cargo fijo menos su descuento), no del costo registrado', item('uso_celular', N[0]).monthly === 14.9 && item('uso_celular', N[0]).fromBill
      && item('guardado_repuesto', N[4]).monthly === 19.9);
    check('Si un chip no figura en el recibo, se usa su costo registrado y se lista aparte', item('uso_celular', N[8]).monthly === 12.5 && !item('uso_celular', N[8]).fromBill
      && u.notBilled.some((i) => i.number === N[8]) && u.notBilled.some((i) => i.number === '900000420'));
    check('Facturado y sin registrar: lo que el recibo cobra y no está en el inventario', u.unlocated.some((i) => i.number === N[7] && i.monthly === 25 && i.recibo === 'USO-0001'));
    check('Totales: lo guardado incluye el repuesto, el celular en stock y el stock (19.90 cada uno)', u.categories.guardado_repuesto.items.length >= 1
      && Math.abs(u.categories.guardado_repuesto.monthly - u.categories.guardado_repuesto.items.reduce((t, i) => t + (i.monthly || 0), 0)) < 0.01
      && u.totals.guardado.count >= 3 && u.totals.pct.uso + u.totals.pct.guardado + u.totals.pct.unlocated > 99.8);

    // --- Pantalla y Excel
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.join(ROOT, 'views'));
    app.use(express.urlencoded({ extended: true }));
    app.use(session({ secret: 'e2e', resave: false, saveUninitialized: true }));
    app.use(flash());
    app.use((req, res, next) => {
      req.session.user = admin;
      Object.assign(res.locals, { currentUser: admin, csrfToken: 'x', successMessages: [], errorMessages: [], currentPath: req.path, currentHost: req.hostname,
        appName: 'Prueba', enabledModules: new Proxy({}, { get: () => true }), mobileLabels });
      next();
    });
    app.use('/celulares/chips', require(path.join(ROOT, 'src/routes/mobileLines')));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await (await fetch(`${base}/celulares/chips/uso`)).text();
    check('Pantalla "Uso real": se paga, en uso, guardado (se paga y no se usa) y facturado sin registrar', page.includes('id="uso_resumen"')
      && page.includes('Guardado: se paga y no se usa') && page.includes('Facturado y sin registrar') && page.includes(N[4]) && page.includes('Guarda Repuesto')
      && page.includes('Celular en stock') && page.includes(`/celulares/chips?ubicacion=repuesto`));
    const x = await fetch(`${base}/celulares/chips/uso/exportar.xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await x.arrayBuffer()));
    const names = wb.worksheets.map((w) => w.name).join();
    let found = false;
    wb.getWorksheet('Guardados').eachRow((r) => { if (r.values.includes(N[4]) && r.values.includes('Guarda Repuesto')) found = true; });
    check('Excel del uso real: resumen, guardados, en uso, facturado sin registrar y registrado sin recibo', x.status === 200
      && names === 'Resumen,Guardados,En uso,Facturado sin registrar,Registrado sin recibo' && found);
    const listPage = await (await fetch(`${base}/celulares/chips`)).text();
    check('El listado de chips enlaza al uso real', listPage.includes('href="/celulares/chips/uso"'));
    const rep = await reportService.run(reportService.REPORTS.chips, { q: '9000004' });
    check('Reporte de chips: columna "Uso real" y desglose por uso real', rep.rows.find((r) => r.phone_number === N[4]).uso_real === 'Guardado'
      && rep.rows.find((r) => r.phone_number === N[0]).uso_real === 'En uso' && rep.summary.groups[0].label === 'Por uso real');

    // --- 3.er chip anotado: repuesto de quien tiene el celular
    const cand = (await notesService.candidates()).items.find((i) => i.number === N[9]);
    check('Un 3.er número anotado en un celular con 2 chips se ofrece como repuesto de quien lo tiene', cand && cand.action === 'repuesto' && cand.device.holder === 'Usuario Con Tres');
    const { done } = await notesService.register([cand.key], admin.id);
    const l9 = await line(N[9]);
    const [asg] = await q('SELECT * FROM mobile_line_assignments WHERE line_id = ? AND returned_date IS NULL', [l9.id]);
    check('Registrado: chip con el plan del recibo, fuera del celular y asignado como repuesto a esa persona', done.length === 1 && !l9.device_id && l9.plan === 'Plan W'
      && asg.uso === 'repuesto' && asg.holder_name === 'Usuario Con Tres' && asg.observacion.includes('A-90043'));
    u = await usageService.usage();
    check('Y en el uso real pasa a "Guardado (repuesto)"', u.categories.guardado_repuesto.items.some((i) => i.number === N[9] && i.holder === 'Usuario Con Tres'));
    server.close();

    // --- Sesiones en la base
    const store = new MariaDbSessionStore({ prune: false });
    const [ins] = await pool.query("INSERT INTO users (full_name, email, password_hash, role) VALUES ('Sesion E2E', 'sesion-e2e@prueba.invalid', 'x', 'lector')");
    const user = { id: ins.insertId, full_name: 'Sesion E2E', email: 'sesion-e2e@prueba.invalid', role: 'lector' };
    const makeApp = () => {
      const a = express();
      a.use(session({ secret: 'e2e-sesion', store: new MariaDbSessionStore({ prune: false }), resave: false, saveUninitialized: false, rolling: true,
        cookie: { httpOnly: true, sameSite: 'lax', maxAge: SESSION_IDLE_MS } }));
      a.use(flash());
      a.use(refreshSessionUser);
      a.get('/entrar', (req, res) => completeLogin(req, res, user, { via: 'prueba', remember: req.query.recordar === '1' }));
      a.get('/yo', (req, res) => res.json({ user: req.session.user || null }));
      a.get('/', (req, res) => res.send('inicio'));
      a.get('/login', (req, res) => res.send('login'));
      return a.listen(0);
    };
    let s1 = makeApp();
    const url = (srv, p) => `http://127.0.0.1:${srv.address().port}${p}`;
    let r = await fetch(url(s1, '/entrar?recordar=1'), { redirect: 'manual' });
    const setCookie = r.headers.get('set-cookie') || '';
    const cookie = setCookie.split(';')[0];
    const expires = new Date((/Expires=([^;]+)/.exec(setCookie) || [])[1]);
    check('"Mantener la sesión iniciada": la cookie dura 30 días', Math.abs(expires.getTime() - Date.now() - SESSION_REMEMBER_MS) < 60 * 1000);
    const sid = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
    const [row1] = await q('SELECT expires FROM sessions WHERE sid = ?', [sid]);
    check('La sesión queda guardada en la base de datos', !!row1);
    s1.close();
    let s2 = makeApp(); // "reinicio" de la aplicacion: otro proceso, otro almacen, misma base
    r = await fetch(url(s2, '/yo'), { headers: { cookie } });
    check('Tras reiniciar la aplicación la sesión sigue abierta', (await r.json()).user && true);
    await q('UPDATE sessions SET expires = expires - INTERVAL 1 DAY WHERE sid = ?', [sid]);
    const [before] = await q('SELECT expires FROM sessions WHERE sid = ?', [sid]);
    await fetch(url(s2, '/yo'), { headers: { cookie } });
    const [after] = await q('SELECT expires FROM sessions WHERE sid = ?', [sid]);
    check('Cada uso alarga la sesión (vence por inactividad, no a hora fija)', new Date(after.expires) > new Date(before.expires));
    r = await fetch(url(s2, '/entrar'), { redirect: 'manual' });
    const short = new Date((/Expires=([^;]+)/.exec(r.headers.get('set-cookie') || '') || [])[1]);
    check('Sin marcar "mantener", la sesión dura 12 horas sin uso', Math.abs(short.getTime() - Date.now() - SESSION_IDLE_MS) < 60 * 1000);
    await q("UPDATE users SET role = 'editor' WHERE id = ?", [user.id]);
    await q('UPDATE sessions SET data = JSON_SET(data, "$.userCheckedAt", 0) WHERE sid = ?', [sid]);
    r = await fetch(url(s2, '/yo'), { headers: { cookie } });
    check('Un cambio de rol se aplica a la sesión abierta sin volver a ingresar', (await r.json()).user.role === 'editor');
    await q('UPDATE users SET active = 0 WHERE id = ?', [user.id]);
    await q('UPDATE sessions SET data = JSON_SET(data, "$.userCheckedAt", 0) WHERE sid = ?', [sid]);
    r = await fetch(url(s2, '/yo'), { headers: { cookie }, redirect: 'manual' });
    check('Si el usuario se desactiva, su sesión abierta se cierra en la siguiente solicitud', r.status === 302 && r.headers.get('location') === '/login');
    await q('INSERT INTO sessions (sid, expires, data) VALUES (?, NOW() - INTERVAL 1 MINUTE, ?)', ['e2e-vencida', '{"cookie":{}}']);
    const pruned = await store.prune();
    check('Las sesiones vencidas se borran solas', pruned >= 1 && (await q("SELECT COUNT(*) AS n FROM sessions WHERE sid = 'e2e-vencida'"))[0].n === 0);
    s2.close();
    await q('DELETE FROM sessions WHERE sid = ? OR data LIKE ?', [sid, '%sesion-e2e@prueba.invalid%']);
  } finally {
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
