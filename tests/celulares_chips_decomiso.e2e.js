// Prueba de extremo a extremo del modulo Celulares: chips (con y sin
// celular, emergencia, doble SIM), suma de costos con filtros y decomiso.
//
// Monta las rutas REALES en una mini-app con una sesion de administrador
// simulada (sin login ni 2FA) y trabaja contra la base configurada, con
// datos de prueba marcados que se borran al final (IMEI 99000000000000x,
// numeros 9000009xx, DNI 999999xx). Por seguridad no corre en produccion
// salvo que se pase E2E_PERMITIR=1 a proposito.
//
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/celulares_chips_decomiso.e2e.js
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

const ROOT = path.join(__dirname, '..');
const pool = require(path.join(ROOT, 'src/db/pool'));
const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));

if (process.env.E2E_PERMITIR !== '1') {
  console.error('Esta prueba escribe (y luego borra) datos marcados en la base configurada. Ejecútela con E2E_PERMITIR=1.');
  process.exit(2);
}

const IMEI = ['990000000000001', '990000000000002'];
const N = ['900000901', '900000902', '900000903', '900000904', '900000905'];
const DNI = ['99999901', '99999902', '99999903'];
const AREA = 'PRUEBA-E2E';
const results = [];
const check = (name, cond) => results.push([!!cond, name]);

async function cleanup() {
  await pool.query('DELETE FROM mobile_lines WHERE phone_number IN (?)', [N]);
  await pool.query('DELETE FROM mobile_devices WHERE imei IN (?)', [IMEI]);
  await pool.query('DELETE FROM employees WHERE dni IN (?)', [DNI]);
  await pool.query(
    "DELETE FROM audit_log WHERE target LIKE '%99000000000000%' OR target LIKE 'Chip 9000009%' OR detail LIKE '%9999990%' OR detail LIKE '%99000000000000%'"
  );
}

async function main() {
  const [[admin]] = await pool.query("SELECT id, email, full_name, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  const [[peru]] = await pool.query("SELECT id FROM phone_country_codes WHERE calling_code = '51' LIMIT 1");
  const [[taken]] = await pool.query(
    'SELECT (SELECT COUNT(*) FROM mobile_lines WHERE phone_number IN (?)) + (SELECT COUNT(*) FROM mobile_devices WHERE imei IN (?) OR phone_number IN (?)) AS n',
    [N, IMEI, N]
  );
  if (taken.n > 0) await cleanup(); // restos de una corrida anterior interrumpida

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
    res.locals.currentUser = admin;
    res.locals.csrfToken = CSRF;
    res.locals.successMessages = [];
    res.locals.errorMessages = [];
    res.locals.currentPath = req.path;
    res.locals.currentHost = req.hostname;
    res.locals.appName = 'Prueba';
    res.locals.enabledModules = new Proxy({}, { get: () => true });
    res.locals.mobileLabels = mobileLabels;
    next();
  });
  app.get('/__flash', (req, res) => res.json({ error: req.flash('error'), success: req.flash('success') }));
  app.use('/celulares/chips', require(path.join(ROOT, 'src/routes/mobileLines')));
  app.use('/celulares', require(path.join(ROOT, 'src/routes/mobileDevices')));
  app.use('/empleados', require(path.join(ROOT, 'src/routes/employees')));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  async function req(method, url, form) {
    const opts = { method, redirect: 'manual', headers: { cookie } };
    if (form) {
      opts.body = new URLSearchParams({ _csrf: CSRF, ...form }).toString();
      opts.headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const r = await fetch(base + url, opts);
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  }
  const post = async (url, form) => {
    const r = await req('POST', url, form);
    const f = JSON.parse((await req('GET', '/__flash')).text);
    return { ...r, errors: f.error, ok: f.success };
  };
  const q = async (sql, params) => (await pool.query(sql, params))[0];
  const line = async (num) => (await q('SELECT * FROM mobile_lines WHERE phone_number = ?', [num]))[0];
  const device = async (imei) => (await q('SELECT * FROM mobile_devices WHERE imei = ?', [imei]))[0];
  const newDevice = (imei, num) => post('/celulares/nuevo', {
    imei, area: AREA, status: 'en_stock', ...(num ? { has_chip: 'on', phone_number: num, phone_country_code_id: String(peru.id) } : {}),
  });
  const editDevice = async (d, changes) => post(`/celulares/${d.id}/editar`, {
    imei: d.imei, area: d.area, status: d.status, phone_country_code_id: String(peru.id),
    ...(d.has_chip ? { has_chip: 'on' } : {}), phone_number: d.phone_number || '', ...changes,
  });

  try {
    // --- Celular y su chip principal
    let r = await newDevice(IMEI[0], N[0]);
    let A = await device(IMEI[0]);
    let l1 = await line(N[0]);
    check('Crear celular con chip registra el chip, puesto en ese celular', A && l1 && l1.device_id === A.id);
    r = await newDevice(IMEI[1], N[0]);
    check(`Otro celular con el mismo número: rechazado (${(r.errors[0] || '').slice(0, 45)})`, !(await device(IMEI[1])) && /otro celular/.test(r.errors.join(' ')));
    await newDevice(IMEI[1], N[1]);
    let B = await device(IMEI[1]);
    r = await editDevice(A, { phone_number: N[2] });
    l1 = await line(N[0]);
    const l3 = await line(N[2]);
    check('Cambiar el número del celular: el chip anterior vuelve a stock y el nuevo queda en el equipo',
      l1.device_id === null && l3 && l3.device_id === A.id);

    // --- Chip sin celular, emergencia, doble SIM
    r = await post('/celulares/chips/nuevo', { phone_number: N[3], phone_country_code_id: String(peru.id), operadora: 'Entel',
      plan: 'Corporativo', costo_plan: '29.90', iccid: '8951101234567890123', estado: 'activo' });
    let l4 = await line(N[3]);
    check('Crear chip sin celular (en stock) con plan y costo', l4 && l4.device_id === null && Number(l4.costo_plan) === 29.9);
    r = await post('/celulares/chips/nuevo', { phone_number: N[3], phone_country_code_id: String(peru.id) });
    check('Chip con número repetido: rechazado', r.errors.some((e) => /Ya existe un chip/.test(e)));
    r = await post('/celulares/chips/nuevo', { phone_number: N[4], phone_country_code_id: String(peru.id), iccid: '123' });
    check('ICCID inválido: rechazado', r.errors.some((e) => /ICCID/.test(e)) && !(await line(N[4])));

    r = await post(`/celulares/chips/${l4.id}/asignar`, { dni: DNI[0], first_name: 'Prueba', last_name: 'Emergencia', uso: 'emergencia', area: AREA });
    let [asg] = await q('SELECT * FROM mobile_line_assignments WHERE line_id = ? AND returned_date IS NULL', [l4.id]);
    check('Asignar chip como número de emergencia (crea al empleado por DNI)', asg && asg.uso === 'emergencia' && asg.employee_id);
    const [[emp]] = await pool.query('SELECT id FROM employees WHERE dni = ?', [DNI[0]]);
    const empPage = await req('GET', `/empleados/${emp.id}`);
    check('La ficha del empleado muestra su chip de emergencia', empPage.status === 200 && empPage.text.includes(N[3]) && empPage.text.includes('Número de emergencia'));
    r = await editDevice(B, { phone_number: N[3] });
    check('Poner en un celular un número asignado a una persona desde el formulario: rechazado',
      r.errors.some((e) => /asignado a/.test(e)) && (await device(IMEI[1])).phone_number === N[1]);

    r = await post(`/celulares/chips/${l4.id}/poner`, { device: IMEI[0] });
    l4 = await line(N[3]);
    A = await device(IMEI[0]);
    [asg] = await q('SELECT * FROM mobile_line_assignments WHERE line_id = ? ORDER BY id DESC LIMIT 1', [l4.id]);
    check('Poner el chip en un celular que ya tiene número: queda como 2.º chip', l4.device_id === A.id && A.phone_number === N[2]);
    check('Al ponerlo en un celular se cierra su asignación de emergencia', asg.returned_date !== null);
    r = await post(`/celulares/chips/${l3.id}/retirar`, {});
    A = await device(IMEI[0]);
    check('Retirar el chip principal: el 2.º chip pasa a ser el número del celular', A.phone_number === N[3] && A.has_chip === 1 && (await line(N[2])).device_id === null);

    r = await post(`/celulares/chips/${l1.id}/asignar`, { dni: DNI[1], first_name: 'Prueba', last_name: 'Personal', uso: 'personal', area: AREA });
    await post(`/celulares/chips/${l1.id}/editar`, { phone_number: N[0], phone_country_code_id: String(peru.id), costo_plan: '10.50', estado: 'activo' });
    r = await post(`/celulares/chips/${l1.id}/poner`, { device: 'NO-EXISTE' });
    check('Poner en un celular inexistente: error claro', r.errors.some((e) => /No se encontró un celular/.test(e)));

    // --- Filtros combinados y suma
    const list = await req('GET', '/celulares/chips?q=9000009');
    check('Listado de chips responde', list.status === 200);
    const lineService = require(path.join(ROOT, 'src/services/mobileLineService'));
    let s = lineService.summarize(await lineService.listLines({ q: '9000009' }));
    check(`Suma del costo (filtro por número): ${s.total} chips, S/ ${s.costoTotal}`, s.total === 4 && s.costoTotal === 40.4 && s.conCosto === 2 && s.sinCosto === 2);
    s = lineService.summarize(await lineService.listLines({ q: '9000009', operadora: 'Entel' }));
    check('Filtro encadenado + operadora: 1 chip, S/ 29.90', s.total === 1 && s.costoTotal === 29.9);
    s = lineService.summarize(await lineService.listLines({ q: '9000009', ubicacion: 'personal' }));
    check('Filtro encadenado + ubicación "sin celular": el chip asignado a la persona', s.total === 1 && s.porUbicacion.personal === 1);
    s = lineService.summarize(await lineService.listLines({ q: '9000009', ubicacion: 'en_celular', area: AREA }));
    check('Filtro encadenado + en celular + área', s.total === 2);
    s = lineService.summarize(await lineService.listLines({ q: '9000009', costo: 'sin' }));
    check('Filtro "sin costo registrado"', s.total === 2 && s.costoTotal === 0);
    const x = await req('GET', '/celulares/chips/exportar.xlsx?q=9000009');
    check('Exportar chips filtrados a Excel', x.status === 200);
    check('Página del chip responde', (await req('GET', `/celulares/chips/${l4.id}`)).status === 200);
    const detA = await req('GET', `/celulares/${A.id}`);
    check('Detalle del celular muestra sus chips', detA.status === 200 && detA.text.includes('Chips en este celular') && detA.text.includes(N[3]));

    // --- Chip de baja sale del celular
    await post(`/celulares/chips/${l4.id}/editar`, { phone_number: N[3], phone_country_code_id: String(peru.id), operadora: 'Entel', costo_plan: '29.90', estado: 'de_baja' });
    A = await device(IMEI[0]);
    check('Chip dado de baja: sale del celular y el celular queda sin número', (await line(N[3])).device_id === null && A.has_chip === 0 && A.phone_number === null);

    // --- Decomiso
    await post(`/celulares/${B.id}/asignar`, { dni: DNI[2], first_name: 'Prueba', last_name: 'Decomiso', area: AREA });
    r = await post(`/celulares/${B.id}/incidentes`, { tipo: 'decomiso', fecha: '2026-09-29' });
    check('Decomiso sin motivo: rechazado', r.errors.some((e) => /motivo/.test(e)) && (await device(IMEI[1])).status === 'asignado');
    r = await post(`/celulares/${B.id}/incidentes`, { tipo: 'decomiso', motivo: 'inventado', fecha: '2026-09-29' });
    check('Decomiso con motivo inválido: rechazado', (await device(IMEI[1])).status === 'asignado');
    r = await post(`/celulares/${B.id}/incidentes`, { tipo: 'decomiso', motivo: 'denuncia', fecha: '2026-09-29', descripcion: 'Prueba' });
    B = await device(IMEI[1]);
    check('Decomiso por denuncia: el celular queda "en_decomiso"', B.status === 'en_decomiso');
    r = await post(`/celulares/${B.id}/asignar`, { dni: DNI[0], first_name: 'Otra', last_name: 'Persona', area: AREA });
    check('Celular en decomiso: no se puede asignar', r.errors.some((e) => /decomiso/.test(e)));
    r = await editDevice(B, { status: 'en_stock' });
    check('Celular en decomiso: no se saca del decomiso editando el estado', (await device(IMEI[1])).status === 'en_decomiso');
    const lista = await req('GET', '/celulares?status=en_decomiso');
    check('Filtro "En decomiso" en el listado de celulares', lista.text.includes(IMEI[1]) && lista.text.includes('En decomiso'));
    check('Inventario mensual responde con decomisos', (await req('GET', '/celulares/inventario')).text.includes('En decomiso'));
    const [inc] = await q("SELECT * FROM mobile_device_incidents WHERE device_id = ? AND tipo = 'decomiso'", [B.id]);
    check('El decomiso queda en el historial con su motivo', inc && inc.motivo === 'denuncia' && inc.fecha_resolucion === null);
    r = await post(`/celulares/${B.id}/incidentes/${inc.id}/resolver`, {});
    B = await device(IMEI[1]);
    const [open] = await q('SELECT * FROM mobile_device_assignments WHERE device_id = ? AND returned_date IS NULL', [B.id]);
    check('Resolver decomiso: vuelve a stock y se cierra la asignación', B.status === 'en_stock' && !open);
    await post(`/celulares/${B.id}/incidentes`, { tipo: 'decomiso', motivo: 'investigacion', fecha: '2026-09-29' });
    await post(`/celulares/${B.id}/incidentes`, { tipo: 'baja', fecha: '2026-09-30' });
    B = await device(IMEI[1]);
    const [inc2] = await q("SELECT * FROM mobile_device_incidents WHERE device_id = ? AND tipo = 'decomiso' ORDER BY id DESC LIMIT 1", [B.id]);
    check('Decomiso que termina en baja: equipo de baja y el decomiso queda cerrado', B.status === 'de_baja' && inc2.fecha_resolucion !== null);

    // --- Borrar
    await post(`/celulares/${A.id}/eliminar`, {});
    check('Eliminar un celular no borra sus chips (quedan en stock)', !(await device(IMEI[0])) && (await line(N[2])));
    await post(`/celulares/chips/${l1.id}/eliminar`, {});
    check('Eliminar un chip', !(await line(N[0])));
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
