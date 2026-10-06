// Prueba de Usuarios de Clinic con tablas propias y claves foraneas:
// importar el libro que exporta Clinic (.xls con hojas USUARIOS, SEDES y
// PERFILES; y .xlsx), perfiles y sedes con su Id de Clinic, sede enlazada al
// catalogo general, area por perfil, historial de cambios, registro manual
// que despues llega en el listado, baja y reactivacion con solicitante,
// filtros y alertas, unificar areas con clave foranea y todas las pantallas.
//
// Los datos de prueba van marcados (IdUsuario 9900xx, usuarios PRUEBA.E2E*,
// perfiles y sedes PRUEBA-E2E, DNI 9900001x) y se borran al final. Pide
// E2E_PERMITIR=1.
//
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/clinic.e2e.js
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');

if (process.env.E2E_PERMITIR !== '1') {
  console.error('Esta prueba escribe (y luego borra) datos marcados en la base configurada. Ejecútela con E2E_PERMITIR=1.');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (name, cond) => results.push([!!cond, name]);
const AREA = 'PRUEBA-E2E Área Ventas';
const AREA2 = 'PRUEBA-E2E Área Comercial';
const SEDE = 'PRUEBA-E2E SEDE NORTE';

// Libro como el de Clinic. Fechas como numero de serie de Excel (asi llegan del .xls).
const serial = (iso) => (Date.parse(`${iso}Z`) / 86400000) + 25569;
function clinicBook(users, { profiles = true } = {}) {
  const wb = XLSX.utils.book_new();
  const head = ['IdUsuario', 'Nombre', 'Usuario', 'IdEstado', 'IdPerfil', 'IdSede', 'Genero', 'UltimaConexion', 'UsuarioRegistra', 'FechaRegistra',
    'UsuarioEdita', 'FechaEdita', 'CorreoElectronico', 'NumeroCelular', 'DNI', 'IdSupervisor', 'Aprobado'];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...users]), 'USUARIOS');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['ID', 'NOMBRE', 'ESTADO', 'DIRECCIÓN', 'HORA INICIO', 'HORA FIN'],
    [99901, SEDE, 1, 'Av. Prueba 123', 0.375, 0.875]]), 'SEDES');
  if (profiles) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['ID', 'PERFIL'], [99901, 'PRUEBA-E2E ESPECIALISTA'], [99902, 'PRUEBA-E2E SUPERVISOR']]), 'PERFILES');
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['ID', 'ESTADO'], [1, 'ACTIVO'], [2, 'INACTIVO']]), 'ESTADO');
  return wb;
}
const recent = serial(new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 19));
const U1 = [990001, 'PRUEBA SUPERVISORA UNO', 'PRUEBA.E2E1', 1, 99902, 99901, 'null', recent, 'PRUEBA REGISTRADOR', serial('2025-10-16T18:35:08'),
  'null', 'null', 'uno@prueba-e2e.local', '914 678 433', '99000011', 'null', '1'];
const U2 = [990002, 'PRUEBA ESPECIALISTA DOS', 'PRUEBA.E2E2 ', 1, 99901, 99901, 'null', serial('2024-01-02T10:00:00'), 'PRUEBA EDITOR',
  serial('2024-01-01T09:00:00'), 'null', 'null', 'correo-malo', 'null', '99000012', 990001, '0'];
const U3 = [990003, 'PRUEBA ESPECIALISTA TRES', 'prueba.e2e2', 2, 99901, 99901, 'null', 'null', 'System', serial('2023-05-05T08:00:00'),
  'null', 'null', 'null', 'null', '99000012', 990001, '3'];
const U4 = [990004, 'PRUEBA SIN USUARIO', '     ', 1, 99901, 99901, 'null', 'null', 'System', serial('2023-05-05T08:00:00'), 'null', 'null', 'null', 'null', 'null', 'null', '0'];
const U5 = [990005, 'PRUEBA PERFIL RARO', 'PRUEBA.E2E5', 1, 99977, 99901, 'null', 'null', 'System', serial('2023-05-05T08:00:00'), 'null', 'null', 'null', 'null', 'null', 'null', '1'];

async function main() {
  const pool = require(path.join(ROOT, 'src/db/pool'));
  const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));

  const cleanup = async () => {
    await pool.query("DELETE FROM service_requests WHERE module = 'clinic' AND (details_json LIKE '%PRUEBA.E2E%' OR requested_by_name LIKE 'PRUEBA%')");
    await pool.query("UPDATE clinic_users SET supervisor_id = NULL WHERE username LIKE 'PRUEBA.E2E%' OR clinic_id BETWEEN 990000 AND 990999");
    await pool.query("DELETE FROM clinic_users WHERE username LIKE 'PRUEBA.E2E%' OR clinic_id BETWEEN 990000 AND 990999");
    await pool.query("DELETE FROM clinic_imports WHERE file_name LIKE 'prueba_e2e%'");
    await pool.query("DELETE FROM clinic_profiles WHERE name LIKE 'PRUEBA-E2E%' OR clinic_id IN (99901, 99902, 99977)");
    await pool.query("DELETE FROM clinic_sedes WHERE name LIKE 'PRUEBA-E2E%' OR clinic_id = 99901");
    await pool.query("DELETE FROM catalog_items WHERE value LIKE 'PRUEBA-E2E%'");
    await pool.query("DELETE FROM employees WHERE dni IN ('99000011', '99000019', '99000016')");
    await pool.query("DELETE FROM audit_log WHERE target LIKE 'Clinic%PRUEBA%' OR target LIKE 'prueba_e2e%' OR target LIKE 'area: PRUEBA-E2E%' OR detail LIKE '%PRUEBA Gerente%'");
  };
  await cleanup();
  const [[admin]] = await pool.query("SELECT id, email, full_name, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  await pool.query("INSERT INTO employees (dni, first_name, last_name, area, sede, cargo) VALUES ('99000011', 'Supervisora', 'PRUEBA', 'Ventas', 'SURCO', 'Supervisora'), ('99000019', 'Gerente', 'PRUEBA', 'Ventas', 'SURCO', 'Gerente')");
  await pool.query("INSERT INTO catalog_items (catalog_type, value) VALUES ('area', ?), ('area', ?)", [AREA, AREA2]);

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
    Object.assign(res.locals, { currentUser: admin, csrfToken: CSRF, successMessages: req.flash('success'), errorMessages: req.flash('error'), currentPath: req.path,
      currentHost: req.hostname, appName: 'Prueba', enabledModules: new Proxy({}, { get: () => true }), mobileLabels });
    next();
  });
  app.use('/clinic', require(path.join(ROOT, 'src/routes/clinic')));
  app.use('/configuracion/catalogos', require(path.join(ROOT, 'src/routes/catalogs')));
  app.use('/empleados', require(path.join(ROOT, 'src/routes/employees')));
  app.use('/reportes', require(path.join(ROOT, 'src/routes/reports')));
  app.use((err, req, res, next) => { console.error(err); res.status(500).send(`ERROR ${err.message}`); }); // eslint-disable-line no-unused-vars
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const keep = (r) => { const s = r.headers.get('set-cookie'); if (s) cookie = s.split(';')[0]; return r; };
  const get = async (u) => { const r = keep(await fetch(base + u, { headers: { cookie } })); return { status: r.status, text: await r.text(), r }; };
  const form = async (u, data) => {
    const body = new URLSearchParams({ _csrf: CSRF });
    for (const [k, v] of Object.entries(data)) [].concat(v).forEach((x) => body.append(k, x));
    const r = keep(await fetch(base + u, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }));
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  };
  // Subir = revision previa (no guarda nada); confirmar = importar de verdad.
  const review = async (buf, name, employees = 'vincular') => {
    const fd = new FormData();
    fd.append('_csrf', CSRF);
    fd.append('employees', employees);
    fd.append('file', new Blob([buf]), name);
    const r = keep(await fetch(`${base}/clinic/importar`, { method: 'POST', headers: { cookie }, body: fd }));
    const text = await r.text();
    return { status: r.status, text, token: (text.match(/name="token" value="([0-9a-f]{32})"/) || [])[1] };
  };
  const confirmImport = async (token, employees = 'vincular', action = 'confirmar') => {
    const r = await form('/clinic/importar/confirmar', { token, employees, action });
    return { status: r.status, text: r.text, location: r.location };
  };
  const upload = async (buf, name, employees = 'vincular') => {
    const pre = await review(buf, name, employees);
    const done = await confirmImport(pre.token, employees);
    return { ...done, preview: pre };
  };
  const flashOf = async () => ((await get('/clinic/catalogo')).text.match(/alert-(?:danger|success)[^>]*>([\s\S]*?)<\/div>/g) || []).join(' ');
  const user = async (clinicId) => (await pool.query(
    `SELECT c.*, p.name AS perfil, s.name AS sede, o.last_login_at, o.registered_by, o.registered_at FROM clinic_users c
     LEFT JOIN clinic_profiles p ON p.id = c.profile_id LEFT JOIN clinic_sedes s ON s.id = c.sede_id
     LEFT JOIN clinic_user_origin o ON o.clinic_user_id = c.id WHERE c.clinic_id = ?`, [clinicId]))[0][0];
  const eventsOf = async (id) => (await pool.query('SELECT * FROM clinic_user_events WHERE clinic_user_id = ? ORDER BY id', [id]))[0];
  const GERENTE = 'PRUEBA Gerente · DNI 99000019';

  try {
    // ================= Revision previa: no guarda nada =================
    const book1 = XLSX.write(clinicBook([U1, U2, U3, U4, U5]), { type: 'buffer', bookType: 'biff8' });
    const pre = await review(book1, 'prueba_e2e_clinic.xls');
    const [[none]] = await pool.query('SELECT COUNT(*) AS n FROM clinic_users WHERE clinic_id BETWEEN 990000 AND 990999');
    const [[noProf]] = await pool.query('SELECT COUNT(*) AS n FROM clinic_profiles WHERE clinic_id IN (99901, 99902)');
    check('Revisión previa: muestra nuevos, avisos y errores sin guardar nada', pre.status === 200 && pre.token
      && pre.text.includes('Todavía no se guardó nada') && pre.text.includes('Nuevos (4)') && pre.text.includes('PRUEBA SUPERVISORA UNO')
      && pre.text.includes('Errores (1)') && Number(none.n) === 0 && Number(noProf.n) === 0);
    let r0 = await confirmImport(pre.token, 'vincular', 'descartar');
    r0 = await confirmImport(pre.token);
    check('Descartar invalida la revisión (no se puede confirmar después)', r0.status === 302 && r0.location === '/clinic/importar'
      && Number((await pool.query('SELECT COUNT(*) AS n FROM clinic_users WHERE clinic_id BETWEEN 990000 AND 990999'))[0][0].n) === 0);

    // ================= Importar el .xls de Clinic =================
    let imp = await upload(XLSX.write(clinicBook([U1, U2, U3, U4, U5]), { type: 'buffer', bookType: 'biff8' }), 'prueba_e2e_clinic.xls');
    check('Importar .xls: 4 nuevos y 1 error (usuario vacío)', imp.status === 200 && imp.text.includes('Nuevos: 4') && imp.text.includes('Con errores: 1')
      && imp.text.includes('Sin usuario en Clinic (IdUsuario 990004)'));
    check('Importar: avisa usuario repetido, perfil que no venía y correo no válido', imp.text.includes('Usuario repetido en Clinic')
      && imp.text.includes('PRUEBA.E2E2') && imp.text.includes('Id 99977') && imp.text.includes('correo(s) con formato no válido'));
    const [[sede]] = await pool.query('SELECT s.*, g.value AS general FROM clinic_sedes s LEFT JOIN catalog_items g ON g.id = s.sede_item_id WHERE s.clinic_id = 99901');
    check('SEDES: sede con Id, dirección, horario 09:00–21:00 y enlazada al catálogo general', sede && sede.name === SEDE && sede.address === 'Av. Prueba 123'
      && String(sede.opens_at).startsWith('09:00') && String(sede.closes_at).startsWith('21:00') && sede.general === SEDE);
    const [prof] = await pool.query('SELECT clinic_id, name FROM clinic_profiles WHERE clinic_id IN (99901, 99902, 99977) ORDER BY clinic_id');
    check('PERFILES: perfiles con su Id de Clinic (y uno de relleno para el Id que faltaba)', prof.length === 3 && prof[0].name === 'PRUEBA-E2E ESPECIALISTA'
      && prof[2].name.includes('99977'));
    const u1 = await user(990001);
    const u2 = await user(990002);
    const u3 = await user(990003);
    check('Usuario: perfil y sede por clave foránea, DNI vinculado al directorio, contacto', u1 && u1.perfil === 'PRUEBA-E2E SUPERVISOR' && u1.sede === SEDE
      && u1.employee_id && u1.email === 'uno@prueba-e2e.local' && u1.phone === '914 678 433' && u1.approved === 1);
    check('Según Clinic: creado por, fecha de creación y última conexión (fechas de Excel)', u1.registered_by === 'PRUEBA REGISTRADOR'
      && String(u1.registered_at).startsWith('2025-10-16 18:35:08') && u1.last_login_at);
    check('Usuario con espacio invisible se limpia; el repetido con otro Id queda aparte; supervisor por IdSupervisor',
      u2.username === 'PRUEBA.E2E2' && u3.username === 'prueba.e2e2' && u2.id !== u3.id && u2.supervisor_id === u1.id && u3.supervisor_id === u1.id);
    check('Estado y Aprobado de Clinic (2 = inactivo, aprobado 3) y correo no válido descartado', u3.status === 'inactivo' && u3.approved === 3 && u2.email === null);
    check('Historial: una sola entrada de alta por importación (sin evento extra por el supervisor)', (await eventsOf(u2.id)).length === 1);

    // ================= Segunda importación (.xlsx sin hoja de perfiles) =================
    const U2b = [...U2];
    U2b[3] = 2;
    U2b[4] = 99902;
    imp = await upload(XLSX.write(clinicBook([U1, U2b, U3, U5], { profiles: false }), { type: 'buffer', bookType: 'xlsx' }), 'prueba_e2e_clinic.xlsx');
    const ev2 = await eventsOf(u2.id);
    check('Reimportar: solo cambia el que cambió y queda en su historial', imp.text.includes('Nuevos: 0') && imp.text.includes('Con cambios: 1')
      && imp.text.includes('Sin cambios: 3') && ev2.length === 2 && ev2[1].detail.includes('Estado: Activo → Inactivo')
      && ev2[1].detail.includes('Perfil: PRUEBA-E2E ESPECIALISTA → PRUEBA-E2E SUPERVISOR'));

    // ================= Catálogo: área por perfil =================
    const [[pEsp]] = await pool.query('SELECT id FROM clinic_profiles WHERE clinic_id = 99901');
    const [[pSup]] = await pool.query('SELECT id FROM clinic_profiles WHERE clinic_id = 99902');
    const [[area]] = await pool.query("SELECT id FROM catalog_items WHERE catalog_type = 'area' AND value = ?", [AREA]);
    let r = await form(`/clinic/catalogo/perfiles/${pSup.id}`, { clinic_id: '99902', name: 'PRUEBA-E2E SUPERVISOR', area_item_id: String(area.id), active: '1' });
    let page = await get(`/clinic?area=${area.id}`);
    check('Área del perfil: el listado filtra por área y la marca "(del perfil)"', r.status === 302 && page.text.includes('PRUEBA.E2E1')
      && page.text.includes('(del perfil)') && !page.text.includes('PRUEBA.E2E5'));
    r = await form('/clinic/catalogo/perfiles', { name: 'PRUEBA-E2E SUPERVISOR', clinic_id: '' });
    check('Catálogo: perfil con nombre repetido rechazado', (await flashOf()).includes('Ya existe un perfil'));

    // ================= Registro manual (antes de existir en Clinic) =================
    const [[sedeRow]] = await pool.query('SELECT id FROM clinic_sedes WHERE clinic_id = 99901');
    const nuevo = { full_name: 'prueba manual nueve', username: 'PRUEBA.E2E9', profile_id: String(pEsp.id), sede_id: String(sedeRow.id), status: 'activo',
      approved: '1', dni: '99000011', supervisor: 'PRUEBA.E2E1 · PRUEBA SUPERVISORA UNO' };
    r = await form('/clinic/nuevo', nuevo);
    check('Alta manual: sin solicitante no se registra', r.status === 422 && r.text.includes('Indique quién solicitó'));
    r = await form('/clinic/nuevo', { ...nuevo, req_name: GERENTE, req_ref: 'MEMO-9' });
    const [[man]] = await pool.query("SELECT c.*, sr.requested_by_name, sr.entity_id FROM clinic_users c JOIN service_requests sr ON sr.id = c.request_id WHERE c.username = 'PRUEBA.E2E9'");
    check('Alta manual: solicitud vinculada, nombre en mayúsculas, supervisor elegido de la lista', r.status === 302 && man && man.entity_id === man.id
      && man.requested_by_name === 'Gerente PRUEBA' && man.full_name === 'PRUEBA MANUAL NUEVE' && man.supervisor_id === u1.id && man.clinic_id === null);
    r = await form('/clinic/nuevo', { ...nuevo, full_name: 'otro', req_name: GERENTE });
    check('Alta manual: usuario repetido (activo) rechazado', r.status === 422 && r.text.includes('Ya existe el usuario PRUEBA.E2E9'));
    r = await form('/clinic/nuevo', { ...nuevo, username: 'PRUEBA.E2E8', supervisor: 'NO.EXISTE', req_name: GERENTE });
    check('Alta manual: supervisor inexistente rechazado', r.status === 422 && r.text.includes('No hay un usuario'));

    // Llega en el listado de Clinic con su IdUsuario: se enlaza, no se duplica.
    const U9 = [990009, 'PRUEBA MANUAL NUEVE', 'prueba.e2e9', 1, 99901, 99901, 'null', recent, 'PRUEBA EDITOR', recent, 'null', 'null', 'null', 'null', '99000011', 990001, '1'];
    imp = await upload(XLSX.write(clinicBook([U1, U2b, U3, U5, U9]), { type: 'buffer', bookType: 'biff8' }), 'prueba_e2e_clinic2.xls');
    const [linked] = await pool.query("SELECT id, clinic_id, username FROM clinic_users WHERE username IN ('PRUEBA.E2E9', 'prueba.e2e9')");
    check('El registrado aquí se enlaza con su IdUsuario al importar (sin duplicar)', linked.length === 1 && linked[0].id === man.id && linked[0].clinic_id === 990009);
    check('DNI repetido: el aviso y el filtro lo muestran', imp.text.includes('DNI aparecen en más de un usuario')
      && (await get('/clinic?alerta=dni_repetido')).text.includes('>prueba.e2e9<'));

    // ================= Editar, baja y reactivar =================
    r = await form(`/clinic/${man.id}/editar`, { ...nuevo, username: 'prueba.e2e9', area_item_id: String(area.id), phone: '999 111 222' });
    const ev9 = await eventsOf(man.id);
    check('Editar: queda en el historial con nombres (no ids)', r.status === 302 && ev9.some((e) => e.event_type === 'edicion'
      && e.detail.includes(`Área: — → ${AREA}`) && e.detail.includes('Celular: — → 999 111 222')));
    r = await form(`/clinic/${man.id}/baja`, { baja_reason: 'Renuncia', baja_date: '2026-10-05' });
    check('Baja: exige solicitante', (await pool.query('SELECT status FROM clinic_users WHERE id = ?', [man.id]))[0][0].status === 'activo');
    r = await form(`/clinic/${man.id}/baja`, { baja_reason: 'Renuncia', baja_date: '2026-10-05', req_name: GERENTE });
    const item = await require(path.join(ROOT, 'src/services/clinicService')).get(man.id);
    check('Baja: estado, fecha, motivo y solicitud en el historial', item.status === 'baja' && String(item.baja_date).startsWith('2026-10-05')
      && item.baja_reason === 'Renuncia' && (await eventsOf(man.id)).some((e) => e.event_type === 'baja' && e.request_id));
    imp = await upload(XLSX.write(clinicBook([U9]), { type: 'buffer', bookType: 'biff8' }), 'prueba_e2e_clinic3.xls', 'ninguno');
    check('Si Clinic lo sigue mostrando ACTIVO tras la baja, se avisa y no se revierte', imp.text.includes('está DE BAJA aquí pero Clinic lo muestra ACTIVO')
      && (await pool.query('SELECT status FROM clinic_users WHERE id = ?', [man.id]))[0][0].status === 'baja');
    page = await get(`/clinic/${man.id}`);
    check('Ficha: historial, solicitudes, "Según Clinic" y aviso de DNI compartido', page.status === 200 && page.text.includes('Historial')
      && (page.text.match(/Gerente PRUEBA/g) || []).length >= 2 && page.text.includes('Según Clinic') && page.text.includes('también está en'));
    r = await form(`/clinic/${man.id}/reactivar`, { req_name: GERENTE });
    check('Reactivar con solicitante', (await pool.query('SELECT status FROM clinic_users WHERE id = ?', [man.id]))[0][0].status === 'activo'
      && (await eventsOf(man.id)).some((e) => e.event_type === 'reactivacion'));

    // ================= Listado, alertas y orden =================
    page = await get(`/clinic?perfil=${pEsp.id}&estado=inactivo`);
    check('Listado: filtro por perfil y estado', page.status === 200 && page.text.includes('prueba.e2e2') && !page.text.includes('PRUEBA.E2E5'));
    page = await get('/clinic?alerta=sin_conexion&q=PRUEBA');
    check(`Alerta: activos sin entrar en 90 días (incluye al que nunca entró, no al reciente)`, page.text.includes('PRUEBA.E2E5') && !page.text.includes('PRUEBA.E2E1<'));
    page = await get(`/clinic?supervisor=${u1.id}`);
    check('Equipo de un supervisor', page.text.includes('Equipo de PRUEBA.E2E1') && page.text.includes('prueba.e2e2'));
    page = await get('/clinic?alerta=usuario_repetido');
    check('Alerta: usuario repetido', page.text.includes('PRUEBA.E2E2') && page.text.includes('prueba.e2e2'));

    // ================= Claves foráneas: no se borra lo que está en uso =================
    let fkOk = false;
    try { await pool.query('DELETE FROM clinic_profiles WHERE id = ?', [pEsp.id]); } catch (err) { fkOk = err.code === 'ER_ROW_IS_REFERENCED_2'; }
    check('FK: un perfil en uso no se puede borrar', fkOk);
    r = await form(`/configuracion/catalogos/${area.id}/eliminar`, { tipo: 'area' });
    const [[still]] = await pool.query('SELECT id FROM catalog_items WHERE id = ?', [area.id]);
    check('FK: un área en uso no se borra del catálogo (aviso en vez de error)', r.status === 302 && still);
    r = await form('/configuracion/catalogos/unificar', { tipo: 'area', sources: AREA, target: AREA2 });
    const [[area2]] = await pool.query("SELECT id FROM catalog_items WHERE catalog_type = 'area' AND value = ?", [AREA2]);
    const [[movedP]] = await pool.query('SELECT area_item_id FROM clinic_profiles WHERE id = ?', [pSup.id]);
    const [[movedU]] = await pool.query('SELECT area_item_id FROM clinic_users WHERE id = ?', [man.id]);
    check('Unificar áreas mueve las claves foráneas de perfiles y usuarios de Clinic', r.status === 302 && movedP.area_item_id === area2.id
      && movedU.area_item_id === area2.id && !(await pool.query('SELECT id FROM catalog_items WHERE id = ?', [area.id]))[0].length);

    // ================= Empleados: vincular o crear =================
    const U6 = [990006, 'MARIA DEL PILAR PRUEBA QUISPE', 'PRUEBA.E2E6', 1, 99901, 99901, 'null', 'null', 'System', serial('2023-05-05T08:00:00'),
      'null', 'null', 'null', 'null', '99000016', 'null', '3'];
    const book6 = XLSX.write(clinicBook([U1, U6]), { type: 'buffer', bookType: 'biff8' });
    let pv = await review(book6, 'prueba_e2e_clinic6.xls', 'vincular');
    check('Revisión "solo vincular": cuenta el activo con DNI que no está en Empleados y no lo crea', pv.text.includes('99000016')
      && /<div class="fs-5 fw-semibold">1<\/div>activos con DNI que no están en Empleados/.test(pv.text));
    pv = await review(book6, 'prueba_e2e_clinic6.xls', 'crear');
    const [[notYet]] = await pool.query("SELECT COUNT(*) AS n FROM employees WHERE dni = '99000016'");
    check('Revisión "vincular y crear": muestra nombres y apellidos separados, sin crear todavía', pv.text.includes('MARIA DEL PILAR')
      && pv.text.includes('PRUEBA QUISPE') && Number(notYet.n) === 0);
    imp = await confirmImport(pv.token, 'crear');
    const [[emp6]] = await pool.query("SELECT * FROM employees WHERE dni = '99000016'");
    const u6 = await user(990006);
    check('Vincular y crear: empleado marcado "desde Clinic" y vinculado al usuario', emp6 && emp6.source === 'clinic' && emp6.first_name === 'MARIA DEL PILAR'
      && emp6.last_name === 'PRUEBA QUISPE' && emp6.cargo === 'PRUEBA-E2E ESPECIALISTA' && u6.employee_id === emp6.id && imp.text.includes('1 creado(s) en Empleados'));
    page = await get('/clinic?alerta=sin_empleado&q=PRUEBA');
    check('Un empleado creado desde Clinic no cuenta como planilla (sigue en "sin empleado en planilla")', page.text.includes('PRUEBA.E2E6')
      && !page.text.includes(`href="/clinic/${u1.id}">PRUEBA.E2E1<`));
    page = await get('/empleados?origen=clinic');
    check('Empleados: filtro y marca "desde Clinic"', page.status === 200 && page.text.includes('99000016') && page.text.includes('desde Clinic')
      && !page.text.includes('99000011'));
    page = await get(`/clinic/${u6.id}`);
    check('Aprobado 3 = "Pendiente de aprobación"', page.text.includes('Pendiente de aprobación'));
    check('Alerta: activos pendientes de aprobación', (await get('/clinic?alerta=pendiente&q=PRUEBA')).text.includes('PRUEBA.E2E6'));

    // ================= Tablero de conexiones =================
    page = await get('/clinic/conexiones');
    check('Tablero: antigüedad por tramos, por sede y por perfil', page.status === 200 && page.text.includes('Hasta 30 días')
      && page.text.includes('Nunca entró') && page.text.includes(SEDE) && page.text.includes('Candidatos a depurar') && page.text.includes('Sin empleado en planilla'));
    page = await get(`/clinic/conexiones?estado=todos&sede=${sedeRow.id}`);
    check('Tablero filtrado por sede y todos los estados', page.status === 200 && page.text.includes('PRUEBA-E2E ESPECIALISTA'));
    page = await get('/clinic?conexion=nunca&q=PRUEBA');
    check('Listado por tramo de conexión ("Nunca entró")', page.text.includes('PRUEBA.E2E5') && page.text.includes('Última conexión: Nunca entró')
      && !page.text.includes(`href="/clinic/${u1.id}">PRUEBA.E2E1<`));
    page = await get('/clinic?conexion=d30&q=PRUEBA');
    check('Listado por tramo de conexión ("Hasta 30 días")', page.text.includes(`href="/clinic/${u1.id}">PRUEBA.E2E1<`) && !page.text.includes('PRUEBA.E2E5'));

    // ================= Mes a mes: no duplica y reconoce lo remediado =================
    const u5 = await user(990005);
    r = await form(`/clinic/${u5.id}/baja`, { baja_reason: 'Cese', baja_date: '2026-10-06', req_name: GERENTE });
    const mes1 = XLSX.write(clinicBook([U1, U5, U6]), { type: 'buffer', bookType: 'biff8' });
    imp = await upload(mes1, 'prueba_e2e_mes1.xls');
    check('Mes 1: la baja de aquí que Clinic sigue mostrando ACTIVA queda marcada', imp.text.includes('bajas de aquí que Clinic sigue mostrando ACTIVAS')
      && (await get('/clinic?alerta=baja_activa&q=PRUEBA')).text.includes('PRUEBA.E2E5'));
    const U5b = [...U5]; U5b[3] = 2;
    const U6b = [...U6]; U6b[3] = 2;
    const mes2 = XLSX.write(clinicBook([U1, U5b, U6b]), { type: 'buffer', bookType: 'biff8' });
    const pre2 = await review(mes2, 'prueba_e2e_mes2.xls');
    check('Mes 2 (revisión): muestra lo remediado desde la importación anterior', pre2.text.includes('Desde la importación anterior')
      && pre2.text.includes('prueba_e2e_mes1.xls') && /fw-semibold text-success">1<\/div>\s*activos desactivados en Clinic \(1 eran candidatos a depurar\)/.test(pre2.text)
      && /fw-semibold text-success">1<\/div>\s*bajas de aquí ya desactivadas en Clinic/.test(pre2.text));
    imp = await confirmImport(pre2.token);
    const [[st5]] = await pool.query('SELECT c.status, o.clinic_status FROM clinic_users c JOIN clinic_user_origin o ON o.clinic_user_id = c.id WHERE c.clinic_id = 990005');
    check('Mes 2: la baja sigue siendo baja aquí y Clinic ya la muestra inactiva (sale de la alerta)', st5.status === 'baja' && st5.clinic_status === 'inactivo'
      && !(await get('/clinic?alerta=baja_activa&q=PRUEBA')).text.includes('PRUEBA.E2E5'));
    const [[evMes1]] = await pool.query('SELECT COUNT(*) AS n FROM clinic_user_events e JOIN clinic_users c ON c.id = e.clinic_user_id WHERE c.clinic_id BETWEEN 990000 AND 990999');
    const [[nUsers1]] = await pool.query('SELECT COUNT(*) AS n FROM clinic_users WHERE clinic_id BETWEEN 990000 AND 990999');
    imp = await upload(mes2, 'prueba_e2e_mes2b.xls');
    const [[evMes2]] = await pool.query('SELECT COUNT(*) AS n FROM clinic_user_events e JOIN clinic_users c ON c.id = e.clinic_user_id WHERE c.clinic_id BETWEEN 990000 AND 990999');
    const [[nUsers2]] = await pool.query('SELECT COUNT(*) AS n FROM clinic_users WHERE clinic_id BETWEEN 990000 AND 990999');
    check('Reimportar el mismo archivo: nada nuevo, nada cambia, no se duplica historial ni se vuelve a contar lo remediado',
      imp.text.includes('Nuevos: 0') && imp.text.includes('Con cambios: 0') && Number(evMes2.n) === Number(evMes1.n) && Number(nUsers2.n) === Number(nUsers1.n)
      && !imp.text.includes('activos desactivados en Clinic (1'));

    // ================= Orden y filtros por columna (en el servidor) =================
    const order = (html) => [...html.matchAll(/href="\/clinic\/\d+">(PRUEBA\.E2E\d|prueba\.e2e\d)</g)].map((m) => m[1]);
    page = await get('/clinic?q=PRUEBA&orden=usuario&dir=asc');
    const asc = order(page.text);
    page = await get('/clinic?q=PRUEBA&orden=usuario&dir=desc');
    const desc = order(page.text);
    const low = (l) => l.map((x) => x.toLowerCase());
    const sortedAsc = (l) => low(l).every((v, i, a) => !i || a[i - 1] <= v);
    check('Orden por columna en el servidor: usuario ascendente y descendente', asc.length >= 4 && sortedAsc(asc) && sortedAsc([...desc].reverse()) && low(asc)[0] !== low(desc)[0]);
    check('Encabezados con orden y filtro declarados para tablas.js', page.text.includes('data-tabla="servidor"') && page.text.includes('data-orden="conexion"')
      && page.text.includes('data-filtro="perfil"') && page.text.includes('data-filtro-texto="usuario"') && page.text.includes('aria-hidden') === page.text.includes('aria-hidden'));
    page = await get('/clinic?q=PRUEBA&orden=conexion&dir=desc');
    const byLogin = order(page.text);
    check('Orden por última conexión: los recientes primero, los que nunca entraron al final', ['PRUEBA.E2E1', 'prueba.e2e9'].includes(byLogin[0])
      && ['PRUEBA.E2E5', 'PRUEBA.E2E6', 'prueba.e2e2'].includes(byLogin[byLogin.length - 1]));
    page = await get(`/clinic?q=PRUEBA&perfil=${pEsp.id},${pSup.id}&estado=activo,inactivo`);
    check('Filtro por columna con varios valores (perfil y estado)', page.text.includes('PRUEBA.E2E1') && page.text.includes('prueba.e2e2')
      && !page.text.includes('PRUEBA.E2E5') && page.text.includes('Varios (2)'));
    page = await get('/clinic?usuario=e2e6');
    check('Filtro de texto por columna: usuario contiene', page.text.includes('PRUEBA.E2E6') && !page.text.includes('href="/clinic/' + u1.id + '">PRUEBA.E2E1<')
      && page.text.includes('Usuario contiene'));
    page = await get(`/clinic?sup=${encodeURIComponent('SUPERVISORA UNO')}`);
    check('Filtro de texto por columna: supervisor contiene', page.text.includes('prueba.e2e2') && page.text.includes('Supervisor contiene'));
    const xls = await fetch(`${base}/clinic/exportar.xlsx?q=PRUEBA&usuario=e2e6`, { headers: { cookie } });
    const xwb = new ExcelJS.Workbook();
    await xwb.xlsx.load(Buffer.from(await xls.arrayBuffer()));
    check('Exportar respeta los filtros por columna', xwb.worksheets[0].rowCount === 2);

    // ================= Reportes =================
    page = await get('/reportes?modulo=clinic_usuarios&q=PRUEBA');
    check('Reporte "Usuarios de Clinic": antigüedad de conexión, estado en Clinic y vínculo con Empleados', page.status === 200 && page.text.includes('PRUEBA.E2E1')
      && page.text.includes('Antigüedad de conexión') && page.text.includes('Creado desde Clinic') && page.text.includes('Hasta 30 días'));
    page = await get(`/reportes?modulo=clinic_usuarios&q=PRUEBA&f_tramo=${encodeURIComponent('Nunca entró')}`);
    check('Reporte de Clinic filtrado por antigüedad de conexión', page.text.includes('PRUEBA.E2E5') && !page.text.includes('>prueba.e2e9<'));
    const rx = await fetch(`${base}/reportes/exportar.xlsx?modulo=clinic_usuarios&q=PRUEBA`, { headers: { cookie } });
    const rpdf = await fetch(`${base}/reportes/exportar.pdf?modulo=clinic_usuarios&q=PRUEBA`, { headers: { cookie } });
    check('Reporte de Clinic en Excel y PDF', rx.headers.get('content-type').includes('spreadsheetml') && rpdf.headers.get('content-type').includes('pdf'));
    page = await get('/reportes?modulo=personas&q=PRUEBA');
    check('Reporte "Accesos por persona": une celular, Clinic y Microsoft 365 y marca lo que no cuadra', page.status === 200
      && page.text.includes('Supervisora') && page.text.includes('PRUEBA.E2E1 (activo)') && page.text.includes('Más de un usuario de Clinic activo'));

    // ================= Pantallas =================
    const [[lastImp]] = await pool.query("SELECT id FROM clinic_imports WHERE file_name LIKE 'prueba_e2e%' ORDER BY id DESC LIMIT 1");
    const pages = ['/clinic/conexiones?estado=inactivo', '/clinic?alerta=depurar', '/clinic', '/clinic?orden=conexion&pagina=2', '/clinic?alerta=sin_aprobar', '/clinic/nuevo', `/clinic/${man.id}`, `/clinic/${man.id}/editar`,
      `/clinic/${u1.id}`, '/clinic/catalogo', '/clinic/importar', `/clinic/importaciones/${lastImp.id}`, '/configuracion/catalogos/unificar?tipo=area'];
    const bad = [];
    for (const u of pages) {
      const p = await get(u);
      if (p.status !== 200 || p.text.includes('ERROR ')) bad.push(`${u} (${p.status})`);
    }
    check(`Todas las pantallas abren (${pages.length})${bad.length ? ': fallan ' + bad.join(', ') : ''}`, bad.length === 0);
    const xl = await get('/clinic/exportar.xlsx?q=PRUEBA');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await (await fetch(`${base}/clinic/exportar.xlsx?q=PRUEBA`, { headers: { cookie } })).arrayBuffer()));
    const rows = wb.worksheets[0].getSheetValues().filter(Boolean);
    check('Exportar a Excel con perfil, sede y última conexión', xl.r.headers.get('content-type').includes('spreadsheetml') && rows.length >= 6
      && rows.some((x) => x.includes('PRUEBA.E2E1') && x.includes('PRUEBA-E2E SUPERVISOR') && x.includes(SEDE)));
    const tpl = await fetch(`${base}/clinic/importar/plantilla`, { headers: { cookie } });
    const twb = new ExcelJS.Workbook();
    await twb.xlsx.load(Buffer.from(await tpl.arrayBuffer()));
    check('Plantilla con las hojas de Clinic', twb.worksheets.map((w) => w.name).join(',') === 'USUARIOS,SEDES,PERFILES');
  } finally {
    await cleanup();
    server.close();
    await pool.end();
  }
  const fails = results.filter(([ok]) => !ok);
  for (const [ok, name] of results) console.log(`${ok ? 'PASA ' : 'FALLA'}  ${name}`);
  console.log(`\n${results.length - fails.length}/${results.length} pruebas correctas`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
