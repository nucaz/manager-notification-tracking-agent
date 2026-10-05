// EXPLAIN de las consultas tipicas del asistente sobre una base de PRUEBA
// grande (cientos de miles de filas): ninguna debe recorrer completa una
// tabla grande. Usa una base aparte (BENCH_DB, por defecto licencias_bench)
// con las mismas tablas e indices que la real (CREATE TABLE ... LIKE), la
// llena con datos inventados y la vacia al final. Nunca toca la base real.
//
// Preparar una vez, como root en el contenedor de la base:
//   CREATE DATABASE IF NOT EXISTS licencias_bench;
//   GRANT ALL ON licencias_bench.* TO 'licencias'@'%';
// Uso (dentro del contenedor de la aplicacion): E2E_PERMITIR=1 node tests/asistente_indices.e2e.js
const path = require('path');
const mysql = require('mysql2/promise');

if (process.env.E2E_PERMITIR !== '1') {
  console.error('Ejecútela con E2E_PERMITIR=1 (crea y llena tablas en la base de prueba BENCH_DB).');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const env = require(path.join(ROOT, 'src/config/env'));
const data = require(path.join(ROOT, 'src/services/assistantData'));

const BENCH = process.env.BENCH_DB || 'licencias_bench';
const N = Number(process.env.BENCH_ROWS || 300000);
const results = [];
const check = (name, cond, extra) => results.push([!!cond, name + (cond || !extra ? '' : ` — ${extra}`)]);
const BIG = new Set(['mobile_devices', 'mobile_lines', 'mobile_device_assignments', 'mobile_device_incidents', 'audit_log', 'software_licenses', 'glpi_assets', 'employees', 'mobile_line_assignments']);

// Datos inventados, repartidos como los reales (pocas sedes, areas, estados...).
const FILL = [
  `INSERT INTO mobile_devices (id, imei, asset_code, brand, model, phone_number, operadora, status, area, sede, purchase_date)
   SELECT seq, CONCAT('35', LPAD(seq, 13, '0')), CONCAT('B-', LPAD(seq, 6, '0')), ELT(1 + seq % 5, 'ZTE', 'Samsung', 'Oppo', 'Xiaomi', 'Motorola'),
     ELT(1 + seq % 7, 'A75', 'A15', 'A58', 'Redmi 13', 'G24', 'A05', 'Blade'), CONCAT('9', LPAD(seq, 8, '0')), ELT(1 + seq % 3, 'Entel', 'Claro', 'Movistar'),
     ELT(1 + seq % 10, 'asignado', 'asignado', 'asignado', 'asignado', 'asignado', 'asignado', 'en_stock', 'en_stock', 'en_reparacion', 'de_baja'),
     ELT(1 + seq % 12, 'CLINICA', 'BACKOFFICE', 'CONEXXION', 'C-MANAGER', 'VENTAS', 'LOGISTICA', 'SISTEMAS', 'MARKETING', 'RRHH', 'CONTABILIDAD', 'CALIDAD', 'GERENCIA'),
     ELT(1 + seq % 8, 'PUEBLO LIBRE', 'SURCO', 'MEGA PLAZA', 'IZAGUIRRE', 'SAN MIGUEL', 'LOS OLIVOS', 'CHORRILLOS', 'ATE'), CURDATE() - INTERVAL (seq % 1500) DAY
   FROM seq_1_to_${N}`,
  `INSERT INTO mobile_device_assignments (device_id, holder_name, cargo, assigned_date, returned_date, area, sede)
   SELECT seq, CONCAT('Persona ', seq), ELT(1 + seq % 4, 'Asesor', 'Supervisor', 'Analista', 'Jefe'), CURDATE() - INTERVAL (seq % 900) DAY,
     IF(seq % 3 = 0, CURDATE() - INTERVAL (seq % 300) DAY, NULL), 'CLINICA', 'SURCO'
   FROM seq_1_to_${N}`,
  `INSERT INTO employees (dni, first_name, last_name, area, sede)
   SELECT CONCAT('7', LPAD(seq, 7, '0')), CONCAT('Nombre', seq), CONCAT('Apellido', seq), ELT(1 + seq % 12, 'CLINICA', 'BACKOFFICE', 'CONEXXION', 'VENTAS', 'SISTEMAS', 'RRHH', 'LOGISTICA', 'CALIDAD', 'MARKETING', 'GERENCIA', 'C-MANAGER', 'CONTABILIDAD'),
     ELT(1 + seq % 8, 'PUEBLO LIBRE', 'SURCO', 'MEGA PLAZA', 'IZAGUIRRE', 'SAN MIGUEL', 'LOS OLIVOS', 'CHORRILLOS', 'ATE')
   FROM seq_1_to_${Math.round(N / 10)}`,
  `INSERT INTO mobile_lines (id, phone_number, operadora, iccid, plan, estado, device_id, costo_plan, descuento_plan)
   SELECT seq, CONCAT('9', LPAD(seq, 8, '0')), ELT(1 + seq % 3, 'Entel', 'Claro', 'Movistar'), CONCAT('8951', LPAD(seq, 15, '0')), ELT(1 + seq % 4, 'Plan 29.90', 'Plan 39.90', 'Plan 49.90', 'Plan 69.90'),
     ELT(1 + seq % 10, 'activo', 'activo', 'activo', 'activo', 'activo', 'activo', 'activo', 'activo', 'suspendido', 'de_baja'), IF(seq % 2 = 0, seq, NULL),
     ELT(1 + seq % 4, 29.90, 39.90, 49.90, 69.90), IF(seq % 5 = 0, 5, NULL)
   FROM seq_1_to_${N}`,
  `INSERT INTO mobile_line_assignments (line_id, holder_name, uso, assigned_date, employee_id)
   SELECT seq, CONCAT('Persona ', seq), ELT(1 + seq % 3, 'personal', 'emergencia', 'repuesto'), CURDATE() - INTERVAL (seq % 400) DAY, 1 + seq % ${Math.round(N / 10)}
   FROM seq_1_to_${N} WHERE seq % 2 = 1 AND seq % 5 <> 1`,
  `INSERT INTO mobile_device_incidents (device_id, tipo, motivo, fecha, costo, descripcion)
   SELECT 1 + (seq * 7) % ${N}, ELT(1 + seq % 4, 'reparacion', 'accidente', 'baja', 'decomiso'), IF(seq % 4 = 3, ELT(1 + seq % 3, 'denuncia', 'investigacion', 'observado'), NULL),
     CURDATE() - INTERVAL (seq % 1200) DAY, (seq % 50) * 10, CONCAT('Incidente ', seq)
   FROM seq_1_to_${Math.round(N / 3)}`,
  `INSERT INTO audit_log (user_email, action, target, detail, created_at)
   SELECT CONCAT('usuario', seq % 40, '@empresa.pe'), ELT(1 + seq % 9, 'login', 'logout', 'device_update', 'device_assign', 'line_update', 'settings_update', 'backup_download', 'catalogo_unificado', 'license_update'),
     CONCAT('Registro ', seq), NULL, NOW() - INTERVAL (seq % 200000) MINUTE
   FROM seq_1_to_${N}`,
  `INSERT INTO software_licenses (product_name, vendor, assigned_to, seats, cost, currency, expiration_date)
   SELECT CONCAT('Producto ', seq % 500), ELT(1 + seq % 6, 'Microsoft', 'Adobe', 'Autodesk', 'ESET', 'Kaspersky', 'Google'), CONCAT('Persona ', seq), 1 + seq % 50, (seq % 900) + 0.5,
     ELT(1 + seq % 2, 'PEN', 'USD'), IF(seq % 20 = 0, NULL, CURDATE() - INTERVAL 400 DAY + INTERVAL (seq % 1400) DAY)
   FROM seq_1_to_${Math.round(N / 3)}`,
  `INSERT INTO glpi_assets (asset_type, glpi_id, name, state, type, manufacturer, model, serial, location, user_name, entity)
   SELECT ELT(1 + seq % 3, 'computadoras', 'monitores', 'impresoras'), seq, CONCAT('EQ-', seq), ELT(1 + seq % 5, 'Activo', 'Activo', 'Activo', 'En reparación', 'De baja'),
     ELT(1 + seq % 3, 'Laptop', 'Desktop', 'All in one'), ELT(1 + seq % 4, 'HP', 'Lenovo', 'Dell', 'Asus'), CONCAT('M', seq % 60), CONCAT('SN', seq),
     ELT(1 + seq % 8, 'PUEBLO LIBRE', 'SURCO', 'MEGA PLAZA', 'IZAGUIRRE', 'SAN MIGUEL', 'LOS OLIVOS', 'CHORRILLOS', 'ATE'), CONCAT('usuario', seq), 'Raíz > Empresa'
   FROM seq_1_to_${N}`,
];

// Preguntas tipicas (las que mas se hacen en el panel).
const TYPICAL = [
  ['Stock de celulares por sede', { reporte: 'celulares', filtros: [{ columna: 'estado', valor: 'En stock' }], agrupar_por: ['sede'] }],
  ['Celulares de una sede por estado', { reporte: 'celulares', filtros: [{ columna: 'sede', valor: 'surco' }], agrupar_por: ['estado'] }],
  ['Celulares de un área y sede (listado)', { reporte: 'celulares', filtros: [{ columna: 'sede', valor: 'SURCO' }, { columna: 'area', valor: 'CLINICA' }], columnas: ['asset_code', 'imei', 'estado', 'holder_name'] }],
  ['Listado de celulares (primera pantalla)', { reporte: 'celulares' }],
  ['Buscar un IMEI exacto', { reporte: 'celulares', filtros: [{ columna: 'imei', valor: '350000000012345' }] }],
  ['Chips activos de Entel: cuánto se paga', { reporte: 'chips', filtros: [{ columna: 'estado_label', valor: 'Activo' }, { columna: 'operadora', valor: 'entel' }], sumar: ['costo', 'neto'] }],
  ['Chips de baja', { reporte: 'chips', filtros: [{ columna: 'estado_label', valor: 'De baja' }], columnas: ['phone_number', 'operadora', 'plan'] }],
  ['Asignaciones vigentes (recientes)', { reporte: 'asignaciones_celulares', filtros: [{ columna: 'vigente', valor: 'Sí' }] }],
  ['Asignaciones desde una fecha', { reporte: 'asignaciones_celulares', filtros: [{ columna: 'assigned_date', modo: 'mayor_que', valor: '2026-06-01' }], agrupar_por: ['cargo'] }],
  ['Decomisos desde una fecha', { reporte: 'incidentes_celulares', filtros: [{ columna: 'tipo', valor: 'Decomiso' }, { columna: 'fecha', modo: 'mayor_que', valor: '2026-01-01' }] }],
  ['Licencias vencidas', { reporte: 'license', filtros: [{ columna: 'estado', valor: 'Vencido' }] }],
  ['Licencias por vencer, por proveedor', { reporte: 'license', filtros: [{ columna: 'estado', valor: 'por vencer' }], agrupar_por: ['vendor'] }],
  ['Auditoría de una acción desde una fecha', { reporte: 'auditoria', filtros: [{ columna: 'action', valor: 'device_assign' }, { columna: 'created_at', modo: 'mayor_que', valor: '2026-09-01' }] }],
  ['Computadoras de GLPI por estado', { reporte: 'glpi_computadoras', agrupar_por: ['state'] }],
  ['Computadoras de una ubicación', { reporte: 'glpi_computadoras', filtros: [{ columna: 'location', valor: 'surco' }], columnas: ['name', 'serial', 'state'] }],
  ['Empleados de un área', { reporte: 'empleados', filtros: [{ columna: 'area', valor: 'sistemas' }] }],
];

async function main() {
  const conn = await mysql.createConnection({ host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password, multipleStatements: false });
  const real = env.db.database;
  const tables = data.tablesUsed().concat(['external_sync_state']);
  const bench = mysql.createPool({ host: env.db.host, port: env.db.port, database: BENCH, user: env.db.user, password: env.db.password, connectionLimit: 3, dateStrings: true });
  try {
    await conn.query(`USE ${mysql.escapeId(BENCH)}`);
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of tables) {
      await conn.query(`DROP TABLE IF EXISTS ${mysql.escapeId(t)}`);
      await conn.query(`CREATE TABLE ${mysql.escapeId(t)} LIKE ${mysql.escapeId(real)}.${mysql.escapeId(t)}`);
    }
    const started = Date.now();
    for (const sql of FILL) await conn.query(sql);
    for (const t of tables) await conn.query(`ANALYZE TABLE ${mysql.escapeId(t)}`);
    console.log(`Base de prueba ${BENCH}: ${N} celulares, ${N} chips, ${N} asignaciones, ${N} registros de auditoría, ${N} equipos GLPI (${((Date.now() - started) / 1000).toFixed(0)} s).`);

    // Las mismas consultas que arma el asistente, contra la base de prueba.
    data.config.pool = bench;
    const sets = data.datasets({ role: 'admin' }, new Proxy({}, { get: () => true }));
    for (const d of Object.values(sets)) d.ensure = null; // la copia de GLPI ya esta llena
    for (const [name, spec] of TYPICAL) {
      const captured = [];
      data.config.onQuery = (sql, params) => captured.push({ sql, params });
      const t0 = Date.now();
      const res = await data.runQuery(sets, spec);
      const ms = Date.now() - t0;
      data.config.onQuery = null;
      const problems = [];
      for (const { sql, params } of captured) {
        const [plan] = await bench.query(`EXPLAIN ${sql}`, params);
        plan.filter((p) => p.type === 'ALL' && BIG.has(String(p.table).replace(/^.*\./, '')) && Number(p.rows) > 5000)
          .forEach((p) => problems.push(`${p.table} recorrida completa (${p.rows} filas) en: ${sql.slice(0, 90).replace(/\s+/g, ' ')}`));
        // Tablas con alias: EXPLAIN muestra el alias; se identifica por la tabla de su FROM.
        plan.filter((p) => p.type === 'ALL' && Number(p.rows) > 5000 && !BIG.has(String(p.table)))
          .forEach((p) => problems.push(`${p.table} recorrida completa (${p.rows} filas) en: ${sql.slice(0, 160).replace(/\s+/g, ' ')}`));
      }
      check(`${name}: usa índices (${res.total} registros, ${ms} ms)`, !problems.length, problems.join(' | '));
    }
  } finally {
    data.config.pool = null;
    data.config.onQuery = null;
    if (process.env.BENCH_KEEP !== '1') for (const t of tables) await conn.query(`DROP TABLE IF EXISTS ${mysql.escapeId(t)}`).catch(() => {});
    await conn.end();
    await bench.end();
  }
}

main()
  .catch((err) => { console.error(err); results.push([false, `Excepción: ${err.message}`]); })
  .finally(() => {
    for (const [ok, name] of results) console.log(`${ok ? 'PASA ' : 'FALLA'} ${name}`);
    const ok = results.filter((x) => x[0]).length;
    console.log(`\n${ok}/${results.length} pruebas correctas`);
    process.exit(ok === results.length ? 0 : 1);
  });
