// Prueba del historial de asignaciones de celulares: en qué área y sede
// estuvo el equipo en cada asignación, cómo terminó, y qué le pasó antes y
// durante (decomiso por investigación, reparación, baja). Incluye la
// migración 0024 sobre asignaciones anteriores.
//
// Datos marcados que se borran al final (IMEI 99000000000001x, DNI
// 9999991x). Pide E2E_PERMITIR=1.
//
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/celulares_historial.e2e.js
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

const IMEI = ['990000000000011', '990000000000012', '990000000000013'];
const DNI = ['99999911', '99999912', '99999913'];
const results = [];
const check = (name, cond) => results.push([!!cond, name]);
const q = async (sql, params) => (await pool.query(sql, params))[0];

async function cleanup() {
  await q('DELETE FROM mobile_devices WHERE imei IN (?)', [IMEI]);
  await q('DELETE FROM employees WHERE dni IN (?)', [DNI]);
  await q("DELETE FROM audit_log WHERE target LIKE 'Celular 99000000000001%'");
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
  app.use('/celulares', require(path.join(ROOT, 'src/routes/mobileDevices')));
  app.use('/empleados', require(path.join(ROOT, 'src/routes/employees')));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (u, form) => fetch(base + u, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: CSRF, ...form }).toString() });
  const get = async (u) => (await fetch(base + u)).text();
  const dev = async (imei) => (await q('SELECT * FROM mobile_devices WHERE imei = ?', [imei]))[0];
  const asg = async (id) => q('SELECT * FROM mobile_device_assignments WHERE device_id = ? ORDER BY id', [id]);
  const [peru] = await q("SELECT id FROM phone_country_codes WHERE calling_code = '51' LIMIT 1");
  const person = (i, area, sede) => ({ dni: DNI[i], first_name: `Persona${i}`, last_name: 'Historial', area, sede, cargo: 'Analista' });

  try {
    await q("INSERT INTO mobile_devices (imei, asset_code, area, sede, status) VALUES (?, 'A-90011', 'STOCK SISTEMAS', 'PUEBLO LIBRE', 'en_stock'), (?, 'A-90012', 'STOCK SISTEMAS', 'SURCO', 'en_stock')", [IMEI[0], IMEI[1]]);
    const A = await dev(IMEI[0]);

    // 1) Asignado en VENTAS / SURCO
    await post(`/celulares/${A.id}/asignar`, { ...person(0, 'VENTAS', 'SURCO'), assigned_date: '2026-01-10' });
    let a = await asg(A.id);
    check('Al asignar se guarda en qué área y sede estuvo el equipo', a.length === 1 && a[0].area === 'VENTAS' && a[0].sede === 'SURCO' && !a[0].returned_date);
    // Se muda de sede mientras la persona lo tiene
    await post(`/celulares/${A.id}/editar`, { imei: A.imei, area: 'VENTAS', sede: 'MEGA PLAZA', status: 'asignado', asset_code: 'A-90011', phone_country_code_id: String(peru.id) });
    a = await asg(A.id);
    check('Si el equipo cambia de sede mientras alguien lo tiene, la asignación vigente lo refleja', a[0].sede === 'MEGA PLAZA');

    // 2) Decomiso por investigacion, y se resuelve: la asignacion termina
    await post(`/celulares/${A.id}/incidentes`, { tipo: 'decomiso', motivo: 'investigacion', fecha: '2026-02-05', descripcion: 'Investigación interna' });
    const [inc] = await q("SELECT id FROM mobile_device_incidents WHERE device_id = ? AND tipo = 'decomiso'", [A.id]);
    await q('UPDATE mobile_device_incidents SET fecha = ? WHERE id = ?', ['2026-02-05', inc.id]);
    await post(`/celulares/${A.id}/incidentes/${inc.id}/resolver`, {});
    await q("UPDATE mobile_device_incidents SET fecha_resolucion = '2026-02-20' WHERE id = ?", [inc.id]);
    await q("UPDATE mobile_device_assignments SET returned_date = '2026-02-20' WHERE device_id = ? AND estado_final = 'en_decomiso'", [A.id]);
    a = await asg(A.id);
    check('Al resolver el decomiso la asignación se cierra como "Retirado por decomiso"', a[0].returned_date && a[0].estado_final === 'en_decomiso');

    // 3) Nueva persona: "antes" muestra el decomiso por investigacion
    await post(`/celulares/${A.id}/asignar`, { ...person(1, 'BACKOFFICE', 'PUEBLO LIBRE'), assigned_date: '2026-03-01' });
    // 4) Reasignado a una tercera persona
    await post(`/celulares/${A.id}/asignar`, { ...person(2, 'CAPACITACION', 'IZAGUIRRE'), assigned_date: '2026-06-01' });
    a = await asg(A.id);
    check('Reasignar cierra la anterior como "Pasó a otra persona" y abre la nueva con su sede', a.length === 3 && a[1].estado_final === 'reasignado'
      && a[1].returned_date && a[2].sede === 'IZAGUIRRE' && !a[2].returned_date);
    // 5) Devolver a stock
    await post(`/celulares/${A.id}/devolver`, {});
    a = await asg(A.id);
    check('Devolver a stock: "Devuelto a stock"', a[2].estado_final === 'en_stock' && a[2].returned_date);

    let page = await get(`/celulares/${A.id}`);
    // La fila de esa persona (su nombre como primera celda, no en la observacion de otra).
    const fila = (texto) => { const i = page.indexOf(`<td>${texto}</td>`); return i > -1 ? page.slice(i, page.indexOf('</tr>', i)) : ''; };
    check('Historial del celular: área y sede de cada asignación', fila('Persona0 Historial').includes('VENTAS / MEGA PLAZA') && fila('Persona1 Historial').includes('BACKOFFICE / PUEBLO LIBRE'));
    check('Historial: cómo terminó cada una', fila('Persona0 Historial').includes('Retirado por decomiso') && fila('Persona1 Historial').includes('Pasó a otra persona')
      && fila('Persona2 Historial').includes('Devuelto a stock'));
    check('Historial: el decomiso por investigación figura "durante" la primera y "antes" de la segunda',
      fila('Persona0 Historial').includes('Decomiso por investigación 2026-02-05 → resuelto 2026-02-20')
      && fila('Persona1 Historial').includes('Decomiso por investigación 2026-02-05') && fila('Persona2 Historial').includes('Sin incidentes'));

    const [emp] = await q('SELECT id FROM employees WHERE dni = ?', [DNI[1]]);
    page = await get(`/empleados/${emp.id}`);
    check('Ficha del empleado: el historial muestra área/sede, cómo terminó y el decomiso previo', page.includes('BACKOFFICE / PUEBLO LIBRE') && page.includes('Pasó a otra persona')
      && page.includes('Decomiso por investigación 2026-02-05'));

    // 6) Baja por incidente: cierra la asignacion vigente (no queda persona fantasma)
    const B = await dev(IMEI[1]);
    await post(`/celulares/${B.id}/asignar`, { ...person(0, 'VENTAS', 'SURCO'), assigned_date: '2026-04-01' });
    await post(`/celulares/${B.id}/incidentes`, { tipo: 'baja', fecha: '2026-09-01', descripcion: 'Robo' });
    const b = await asg(B.id);
    check('Una baja registrada como incidente también cierra la asignación ("Dado de baja")', (await dev(IMEI[1])).status === 'de_baja' && b[0].returned_date && b[0].estado_final === 'de_baja');

    // --- Migracion 0024 sobre asignaciones anteriores (sin lugar ni cierre)
    await q("INSERT INTO mobile_devices (imei, area, sede, status) VALUES (?, 'LOGISTICA', 'SURCO', 'asignado')", [IMEI[2]]);
    const C = await dev(IMEI[2]);
    const [e2] = await q('SELECT id FROM employees WHERE dni = ?', [DNI[2]]);
    await q("INSERT INTO mobile_device_assignments (device_id, employee_id, holder_name, assigned_date, returned_date) VALUES (?, ?, 'Vieja Uno', '2025-01-01', '2025-06-01'), (?, NULL, 'Vieja Dos', '2025-06-02', NULL)",
      [C.id, e2.id, C.id]);
    const sql = fs.readFileSync(path.join(ROOT, 'sql/migrations/0024_asignaciones_sede_y_cierre.sql'), 'utf8');
    for (const stmt of sql.split(/;\s*\n/).map((x) => x.replace(/^--.*$/gm, '').trim()).filter(Boolean)) await q(stmt);
    const c = await asg(C.id);
    check('Migración 0024: la vigente toma el lugar actual del equipo', c[1].area === 'LOGISTICA' && c[1].sede === 'SURCO');
    check('Migración 0024: la cerrada toma el área y sede de la persona (directorio) y queda como "Pasó a otra persona"', c[0].area === 'CAPACITACION' && c[0].sede === 'IZAGUIRRE'
      && c[0].estado_final === 'reasignado');
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
