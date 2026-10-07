// Prueba: al pasar un celular a "en stock" (o "de baja") desde Editar, su
// asignacion vigente se cierra y queda en el historial; la persona deja de
// figurar como usuario actual. Incluye la correccion de datos anteriores
// (migracion 0020).
//
// Monta las rutas REALES con sesion de administrador simulada, contra la
// base configurada, con datos marcados que se borran al final (IMEI
// 99000000000005x, DNI 9999995x). Por eso pide E2E_PERMITIR=1.
//
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/celulares_devolucion.e2e.js
const fs = require('fs');
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
const reportService = require(path.join(ROOT, 'src/services/reportService'));

const IMEI = ['990000000000051', '990000000000052', '990000000000053', '990000000000054'];
const AREA = 'PRUEBA-DEVOLUCION';
const results = [];
const check = (name, cond) => results.push([!!cond, name]);
const q = async (sql, params) => (await pool.query(sql, params))[0];

async function cleanup() {
  await q('DELETE FROM mobile_devices WHERE imei IN (?)', [IMEI]);
  await q("DELETE FROM audit_log WHERE target LIKE 'Celular 99000000000005%' OR (action = 'asignaciones_cerradas_migracion' AND detail LIKE '%99000000000005%')");
}

async function main() {
  const [admin] = await q("SELECT id, email, full_name, role FROM users WHERE role IN ('superadmin', 'admin') ORDER BY role = 'superadmin' DESC, id LIMIT 1");
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
  app.use('/celulares', require(path.join(ROOT, 'src/routes/mobileDevices')));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, form) => fetch(base + url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: CSRF, ...form }).toString() });
  const get = async (url) => (await fetch(base + url)).text();
  const device = async (imei) => (await q('SELECT * FROM mobile_devices WHERE imei = ?', [imei]))[0];
  const assignments = async (id) => q('SELECT * FROM mobile_device_assignments WHERE device_id = ? ORDER BY id', [id]);
  const [peru] = await q("SELECT id FROM phone_country_codes WHERE calling_code = '51' LIMIT 1");
  const edit = (d, status) => post(`/celulares/${d.id}/editar`, { imei: d.imei, area: d.area, status, asset_code: d.asset_code || '', phone_country_code_id: String(peru.id) });

  try {
    await q('INSERT INTO mobile_devices (imei, asset_code, area, status) VALUES (?), (?), (?), (?)',
      [[IMEI[0], 'A-90051', AREA, 'asignado'], [IMEI[1], 'A-90052', AREA, 'asignado'], [IMEI[2], 'A-90053', AREA, 'asignado'], [IMEI[3], 'A-90054', AREA, 'en_stock']]);
    const [A, B, C, D] = [await device(IMEI[0]), await device(IMEI[1]), await device(IMEI[2]), await device(IMEI[3])];
    await q('INSERT INTO mobile_device_assignments (device_id, holder_name, cargo, assigned_date) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)', [
      A.id, 'Persona Que Se Fue', 'Analista', '2026-01-10', B.id, 'Otra Persona', 'Cajera', '2026-02-01',
      C.id, 'Persona En Reparacion', 'Vendedor', '2026-03-01', D.id, 'Persona Fantasma', 'Asesora', '2026-04-01']);
    // Un historial previo de A, para comprobar que no se pierde.
    await q("INSERT INTO mobile_device_assignments (device_id, holder_name, assigned_date, returned_date) VALUES (?, 'Primer Usuario', '2025-06-01', '2026-01-09')", [A.id]);

    // --- Editar el estado a "en stock"
    let r = await edit(A, 'en_stock');
    const asA = await assignments(A.id);
    const closed = asA.find((a) => a.holder_name === 'Persona Que Se Fue');
    check('Pasar a "en stock" desde Editar cierra la asignación vigente (con fecha de hoy y el motivo)', r.status === 302 && (await device(IMEI[0])).status === 'en_stock'
      && closed.returned_date && closed.observacion.includes('Devuelto a stock (cambio de estado)') && asA.every((a) => a.returned_date));
    let page = await get(`/celulares/${A.id}`);
    check('La ficha ya no muestra a la persona como usuario actual, pero el historial guarda a los dos que lo usaron', !/Asignación actual[\s\S]{0,400}Persona Que Se Fue/.test(page)
      && page.includes('Persona Que Se Fue') && page.includes('Primer Usuario'));
    const list = await get(`/celulares?area=${AREA}`);
    const rowA = list.slice(list.indexOf(IMEI[0]), list.indexOf(IMEI[0]) + 1500);
    check('Listado: el celular en stock aparece sin usuario asignado', !rowA.split('</tr>')[0].includes('Persona Que Se Fue'));
    const rep = await reportService.run(reportService.REPORTS.celulares, { f_area: AREA });
    check('Reporte de celulares: sin la persona que ya lo devolvió', !rep.rows.find((x) => x.imei === IMEI[0]).holder_name);
    const [log] = await q("SELECT detail FROM audit_log WHERE target = ? AND action = 'celular_editado' ORDER BY id DESC LIMIT 1", [`Celular ${IMEI[0]}`]);
    check('La auditoría dice de quién se cerró la asignación', log && log.detail.includes('se cerró la asignación de Persona Que Se Fue'));

    // --- De baja: igual; en reparacion: la persona lo sigue teniendo
    await edit(B, 'de_baja');
    const asB = await assignments(B.id);
    check('Dar de baja desde Editar también cierra la asignación', asB[0].returned_date && asB[0].observacion.includes('Cerrada al dar de baja'));
    await edit(C, 'en_reparacion');
    check('En reparación la asignación sigue abierta (el equipo vuelve a la misma persona)', !(await assignments(C.id))[0].returned_date);
    await edit(C, 'asignado');
    check('Volver de reparación a asignado tampoco toca la asignación', !(await assignments(C.id))[0].returned_date);

    // --- Datos anteriores: un celular que ya estaba en stock con asignacion abierta
    await q('UPDATE mobile_devices SET updated_at = ? WHERE id = ?', ['2026-05-15 10:00:00', D.id]);
    const sql = fs.readFileSync(path.join(ROOT, 'sql/migrations/0020_cerrar_asignaciones_en_stock.sql'), 'utf8');
    const conn = await pool.getConnection();
    for (const stmt of sql.split(/;\s*\n/).map((x) => x.replace(/^--.*$/gm, '').trim()).filter(Boolean)) await conn.query(stmt);
    conn.release();
    const asD = (await assignments(D.id))[0];
    check('Corrección de datos (migración 0020): cierra la asignación "fantasma" con la fecha en que se cambió el estado', asD.returned_date === '2026-05-15'
      && asD.observacion.includes('ya estaba en stock'));
    const [mig] = await q("SELECT detail FROM audit_log WHERE action = 'asignaciones_cerradas_migracion' ORDER BY id DESC LIMIT 1");
    check('La corrección deja constancia en la auditoría de qué celulares tocó', mig && mig.detail.includes(IMEI[3]));
    const conn2 = await pool.getConnection();
    for (const stmt of sql.split(/;\s*\n/).map((x) => x.replace(/^--.*$/gm, '').trim()).filter(Boolean)) await conn2.query(stmt);
    conn2.release();
    check('Correr la corrección otra vez no cambia nada (idempotente)', (await assignments(D.id))[0].returned_date === '2026-05-15'
      && !(await assignments(C.id))[0].returned_date);
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
