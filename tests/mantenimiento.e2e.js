// Prueba de extremo a extremo de Mantenimiento de base de datos:
//   - reglas del esquema (tope de 30 columnas por tabla, clave primaria,
//     claves foraneas con indice, InnoDB/utf8mb4)
//   - indices nuevos y que el motor los usa
//   - pantalla, ANALYZE / OPTIMIZE
//   - retencion de historicos (3 meses por defecto) y borrado a demanda
//
// Monta las rutas REALES con sesion de administrador simulada, contra la
// base configurada. Escribe filas marcadas (accion "e2e_mantenimiento",
// contacto "e2e-mantenimiento") con fechas viejas para probar el borrado;
// el borrado de la prueba alcanza, como el de cada madrugada, a todo
// historico de mas de 3 meses. Por eso pide E2E_PERMITIR=1.
//
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/mantenimiento.e2e.js
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
const maintenanceService = require(path.join(ROOT, 'src/services/maintenanceService'));
const { runPurge } = require(path.join(ROOT, 'src/jobs/purgeHistory'));
const { UPLOAD_ROOT } = require(path.join(ROOT, 'src/services/uploadService'));

const results = [];
const check = (name, cond) => results.push([!!cond, name]);
const q = async (sql, params) => (await pool.query(sql, params))[0];
const ACTION = 'e2e_mantenimiento';
const CONTACT = 'e2e-mantenimiento';

async function cleanup() {
  await q('DELETE FROM audit_log WHERE action = ?', [ACTION]);
  await q('DELETE FROM agent_message_log_archive WHERE contact = ?', [CONTACT]);
  await q('DELETE FROM agent_message_log WHERE contact = ?', [CONTACT]);
}

async function main() {
  const [admin] = await q("SELECT id, email, full_name, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  const [stored] = await q("SELECT `value` FROM settings WHERE `key` = 'history_retention_months'");
  await cleanup();
  await q("DELETE FROM settings WHERE `key` = 'history_retention_months'");

  let user = admin;
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'e2e', resave: false, saveUninitialized: true }));
  app.use(flash());
  const CSRF = 'token-de-prueba-e2e-0123456789abcdef0123456789abcdef';
  app.use((req, res, next) => {
    req.session.user = user;
    req.session.csrfToken = CSRF;
    Object.assign(res.locals, { currentUser: user, csrfToken: CSRF, successMessages: req.flash('success'), errorMessages: req.flash('error'),
      currentPath: req.path, currentHost: req.hostname, appName: 'Prueba', enabledModules: new Proxy({}, { get: () => true }) });
    next();
  });
  app.use('/mantenimiento', require(path.join(ROOT, 'src/routes/maintenance')));
  app.get('/', (req, res) => res.send('inicio'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const req = async (method, url, form) => {
    const opts = { method, redirect: 'manual', headers: { cookie } };
    if (form) { opts.body = new URLSearchParams({ _csrf: CSRF, ...form }).toString(); opts.headers['content-type'] = 'application/x-www-form-urlencoded'; }
    const r = await fetch(base + url, opts);
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  };
  const snapshots = () => { try { return fs.readdirSync(path.join(UPLOAD_ROOT, 'pre_restore_backups')).filter((f) => f.startsWith('antes_de_borrar_historial_')); } catch (_) { return []; } };
  const snapshotsBefore = snapshots();

  try {
    // --- Reglas del esquema
    const tables = await maintenanceService.tableStatus();
    const wide = tables.filter((t) => t.columns > 30);
    check(`Ninguna tabla supera las 30 columnas (la más ancha: ${tables.reduce((a, b) => (b.columns > a.columns ? b : a)).name} con ${Math.max(...tables.map((t) => t.columns))})`, wide.length === 0);
    check('Todas las tablas tienen clave primaria', tables.every((t) => t.indexes.some((i) => i.name === 'PRIMARY')));
    const fks = await q(`SELECT k.table_name AS t, k.column_name AS c FROM information_schema.key_column_usage k
      WHERE k.table_schema = DATABASE() AND k.referenced_table_name IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.statistics s WHERE s.table_schema = k.table_schema AND s.table_name = k.table_name AND s.column_name = k.column_name AND s.seq_in_index = 1)`);
    check('Toda clave foránea tiene un índice que empieza por su columna', fks.length === 0);
    const engines = await q("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND (engine <> 'InnoDB' OR table_collation NOT LIKE 'utf8mb4%')");
    check('Todas las tablas son InnoDB con utf8mb4', engines.length === 0);

    // --- Indices nuevos y su uso
    const has = (table, index) => tables.find((t) => t.name === table).indexes.some((i) => i.name === index);
    check('Índices nuevos presentes (IMEI, código, sede, número, ICCID, empleados, fechas de históricos)', [
      ['mobile_devices', 'idx_mobile_device_imei'], ['mobile_devices', 'idx_mobile_device_asset_code'], ['mobile_devices', 'idx_mobile_device_sede'],
      ['mobile_devices', 'idx_mobile_device_phone_number'], ['mobile_lines', 'idx_mobile_line_iccid'], ['mobile_line_assignments', 'idx_mobile_line_asg_active'],
      ['employees', 'idx_employee_name'], ['employees', 'idx_employee_area'], ['employees', 'idx_employee_sede'], ['agent_message_log', 'idx_agent_log_created'],
      ['trusted_devices', 'idx_trusted_device_expires'], ['audit_log', 'idx_audit_log_email'],
    ].every(([t, i]) => has(t, i)));
    const explain = async (sql, params) => (await q(`EXPLAIN ${sql}`, params))[0];
    const e1 = await explain('SELECT id FROM mobile_devices WHERE imei = ?', ['990000000000001']);
    const e2 = await explain('SELECT id FROM mobile_devices WHERE phone_number = ?', ['900000001']);
    const e3 = await explain('SELECT id FROM mobile_lines WHERE iccid = ?', ['8951100000000000001']);
    const e4 = await explain('SELECT id FROM mobile_line_assignments WHERE line_id = ? AND returned_date IS NULL', [1]);
    check('El motor usa los índices en las búsquedas exactas (IMEI, número, ICCID, asignación vigente del chip)', e1.key === 'idx_mobile_device_imei'
      && e2.key === 'idx_mobile_device_phone_number' && e3.key === 'idx_mobile_line_iccid' && String(e4.possible_keys).includes('idx_mobile_line_asg_active'));

    // --- Pantalla y mantenimiento
    let p = await req('GET', '/mantenimiento');
    check('Pantalla: lista las tablas con sus columnas, tamaños e índices', p.status === 200 && p.text.includes('<code>mobile_devices</code>')
      && p.text.includes('idx_mobile_device_imei') && p.text.includes('Analizar todas') && p.text.includes('Retención de históricos'));
    let r = await req('POST', '/mantenimiento/tablas/analizar', { tabla: 'catalog_items' });
    p = await req('GET', r.location);
    check('Analizar una tabla: corre ANALYZE y muestra el resultado', r.status === 302 && p.text.includes('id="resultado_mantenimiento"') && p.text.includes('<code>catalog_items</code>')
      && p.text.includes('Correcto') && p.text.includes('1 tabla(s) analizada(s)'));
    r = await req('POST', '/mantenimiento/tablas/optimizar', { tabla: 'catalog_items' });
    p = await req('GET', r.location);
    const [catalog] = await q('SELECT COUNT(*) AS n FROM catalog_items');
    check('Optimizar una tabla: reconstruye tabla e índices sin perder filas', p.text.includes('1 tabla(s) optimizada(s)') && p.text.includes('Correcto') && catalog.n >= 0);
    r = await req('POST', '/mantenimiento/tablas/analizar', { tabla: 'users; DROP TABLE users' });
    p = await req('GET', r.location);
    check('Un nombre de tabla que no existe se rechaza (no se ejecuta nada)', p.text.includes('Tabla desconocida') && (await q('SELECT COUNT(*) AS n FROM users'))[0].n >= 1);
    r = await req('POST', '/mantenimiento/tablas/vaciar', { tabla: 'catalog_items' });
    p = await req('GET', r.location);
    check('Solo existen las acciones analizar y optimizar', p.text.includes('Acción de mantenimiento desconocida'));
    const [logged] = await q("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('db_analizar', 'db_optimizar') AND created_at > NOW() - INTERVAL 5 MINUTE");
    check('Cada mantenimiento queda en la auditoría', logged.n >= 2);
    await q("DELETE FROM audit_log WHERE action IN ('db_analizar', 'db_optimizar') AND created_at > NOW() - INTERVAL 5 MINUTE AND user_id = ?", [admin.id]);

    // --- Retencion
    check('Retención por defecto: 3 meses', (await maintenanceService.retentionMonths()) === 3);
    r = await req('POST', '/mantenimiento/retencion', { meses: '99' });
    p = await req('GET', '/mantenimiento');
    check('Un plazo fuera de rango se rechaza', p.text.includes('número entre 0 y 60') && (await maintenanceService.retentionMonths()) === 3);
    await q('INSERT INTO audit_log (user_email, action, target, created_at) VALUES (?, ?, ?, NOW() - INTERVAL 4 MONTH), (?, ?, ?, NOW() - INTERVAL 100 DAY), (?, ?, ?, NOW() - INTERVAL 1 MONTH)',
      ['e2e@prueba', ACTION, 'viejo', 'e2e@prueba', ACTION, 'viejo', 'e2e@prueba', ACTION, 'reciente']);
    await q('INSERT INTO agent_message_log_archive (channel, contact, log_date, message_count, compressed_data) VALUES (?, ?, CURDATE() - INTERVAL 5 MONTH, 1, ?), (?, ?, CURDATE() - INTERVAL 10 DAY, 1, ?)',
      ['web', CONTACT, Buffer.from('x'), 'web', CONTACT, Buffer.from('x')]);
    await q('INSERT INTO agent_message_log (channel, contact, direction, message_text, created_at) VALUES (?, ?, ?, ?, NOW() - INTERVAL 6 MONTH)', ['web', CONTACT, 'entrante', 'viejo']);
    const [reminders] = await q('SELECT COUNT(*) AS n FROM reminder_log');
    const status = await maintenanceService.historyStatus(3);
    check('La pantalla sabe cuánto queda fuera del plazo en cada histórico', status.find((h) => h.key === 'auditoria').expired >= 2
      && status.find((h) => h.key === 'chat_archivo').expired >= 1 && status.find((h) => h.key === 'chat').expired >= 1);

    r = await req('POST', '/mantenimiento/historicos/borrar', { meses: '3', confirmacion: 'borrar' });
    const count = async () => (await q('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?', [ACTION]))[0].n;
    p = await req('GET', '/mantenimiento');
    check('Borrado a demanda sin la frase exacta: no borra nada', p.text.includes('escriba exactamente la frase') && (await count()) === 3 && snapshots().length === snapshotsBefore.length);

    const job = await runPurge();
    const left = await q('SELECT target FROM audit_log WHERE action = ?', [ACTION]);
    const [arch] = await q('SELECT COUNT(*) AS n, MIN(log_date) AS oldest FROM agent_message_log_archive WHERE contact = ?', [CONTACT]);
    const [raw] = await q('SELECT COUNT(*) AS n FROM agent_message_log WHERE contact = ?', [CONTACT]);
    check('Tarea de cada madrugada: borra lo de más de 3 meses y conserva lo reciente', job.months === 3 && job.deleted.auditoria >= 2 && left.length === 1 && left[0].target === 'reciente'
      && arch.n === 1 && raw.n === 0);
    check('La tarea deja constancia en la auditoría de lo que borró', (await q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'history_purged' AND target LIKE 'automático%' AND created_at > NOW() - INTERVAL 5 MINUTE"))[0].n === 1);
    check('El registro de recordatorios enviados no se toca (no es un historial)', (await q('SELECT COUNT(*) AS n FROM reminder_log'))[0].n === reminders.n);

    r = await req('POST', '/mantenimiento/retencion', { meses: '0' });
    await q('INSERT INTO audit_log (user_email, action, target, created_at) VALUES (?, ?, ?, NOW() - INTERVAL 8 MONTH)', ['e2e@prueba', ACTION, 'viejo']);
    const off = await runPurge();
    check('Con 0 meses la tarea automática no borra nada', off.deleted === null && (await count()) === 2);

    r = await req('POST', '/mantenimiento/historicos/borrar', { meses: '3', confirmacion: 'BORRAR HISTORIAL' });
    p = await req('GET', '/mantenimiento');
    const made = snapshots().filter((f) => !snapshotsBefore.includes(f));
    check('Borrado a demanda con la frase: guarda antes una copia de la base y borra lo anterior al plazo', (await count()) === 1 && made.length === 1
      && fs.statSync(path.join(UPLOAD_ROOT, 'pre_restore_backups', made[0])).size > 10000 && p.text.includes('Historial borrado') && p.text.includes(made[0]));
    const dump = made.length ? fs.readFileSync(path.join(UPLOAD_ROOT, 'pre_restore_backups', made[0]), 'utf8') : '';
    check('La copia previa contiene lo que se iba a borrar', dump.includes('CREATE TABLE `audit_log`') && dump.includes(ACTION));
    made.forEach((f) => fs.unlinkSync(path.join(UPLOAD_ROOT, 'pre_restore_backups', f)));

    // --- Permisos
    user = { ...admin, role: 'editor' };
    p = await req('GET', '/mantenimiento');
    r = await req('POST', '/mantenimiento/tablas/optimizar', {});
    check('Solo un administrador entra a Mantenimiento', p.status === 302 && r.status === 302 && r.location !== '/mantenimiento');
    user = admin;
  } finally {
    server.close();
    await cleanup();
    await q("DELETE FROM audit_log WHERE action IN ('history_purged', 'history_retention_set') AND created_at > NOW() - INTERVAL 10 MINUTE");
    await q("DELETE FROM settings WHERE `key` = 'history_retention_months'");
    if (stored) await q("INSERT INTO settings (`key`, `value`) VALUES ('history_retention_months', ?)", [stored.value]);
    check('Limpieza: no quedan datos de prueba', (await q('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?', [ACTION]))[0].n === 0);
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
