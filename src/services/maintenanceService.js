// Mantenimiento de la base de datos desde la aplicacion (solo admin):
//   - estado de tablas e indices (filas, tamano, espacio recuperable)
//   - ANALYZE / OPTIMIZE por tabla (estadisticas y reconstruccion de indices)
//   - retencion de historicos: auditoria e historial de chat se conservan
//     N meses (3 por defecto) y se pueden borrar a demanda.
//
// Los nombres de tabla nunca vienen "libres" del navegador: se comparan
// contra la lista real de tablas de esta base y se pasan como identificador
// (`??`), no concatenados.
const pool = require('../db/pool');
const settingsService = require('./settingsService');

const MAX_COLUMNS = 30;       // tope por tabla (ver tests/mantenimiento.e2e.js)
const WARN_COLUMNS = 20;
const DEFAULT_RETENTION_MONTHS = 3;
const MAX_RETENTION_MONTHS = 60;

// Historicos sujetos a retencion. reminder_log NO entra: no es un
// historial sino el registro de "este aviso ya se envio"; borrarlo haria
// que un recordatorio viejo se envie otra vez.
const HISTORIES = [
  { key: 'auditoria', label: 'Auditoría', table: 'audit_log', dateColumn: 'created_at' },
  { key: 'chat', label: 'Historial de chat (mensajes del día)', table: 'agent_message_log', dateColumn: 'created_at' },
  { key: 'chat_archivo', label: 'Historial de chat (días archivados)', table: 'agent_message_log_archive', dateColumn: 'log_date' },
];

async function tableStatus() {
  const [tables] = await pool.query(`
    SELECT t.table_name AS name, t.table_rows AS rows_estimate, t.data_length AS data_bytes, t.index_length AS index_bytes,
           t.data_free AS free_bytes, t.update_time AS updated_at,
           (SELECT COUNT(*) FROM information_schema.columns c WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name) AS column_count
    FROM information_schema.tables t
    WHERE t.table_schema = DATABASE() AND t.table_type = 'BASE TABLE'
    ORDER BY t.table_name`);
  const [indexes] = await pool.query(`
    SELECT table_name AS table_name, index_name AS name, MAX(non_unique) AS non_unique,
           GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ', ') AS columns_list, MAX(cardinality) AS cardinality
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
    GROUP BY table_name, index_name
    ORDER BY table_name, index_name`);
  return tables.map((t) => ({
    name: t.name,
    rows: Number(t.rows_estimate) || 0,
    dataBytes: Number(t.data_bytes) || 0,
    indexBytes: Number(t.index_bytes) || 0,
    freeBytes: Number(t.free_bytes) || 0,
    updatedAt: t.updated_at,
    columns: Number(t.column_count),
    columnsLevel: t.column_count > MAX_COLUMNS ? 'excede' : (t.column_count > WARN_COLUMNS ? 'alto' : 'ok'),
    indexes: indexes.filter((i) => i.table_name === t.name).map((i) => ({
      name: i.name, columns: i.columns_list, unique: !Number(i.non_unique), cardinality: i.cardinality === null ? null : Number(i.cardinality),
    })),
  }));
}

// ANALYZE (actualiza las estadisticas que usa el motor para elegir indices;
// rapido) u OPTIMIZE (reconstruye la tabla y sus indices y recupera
// espacio; bloquea escrituras en esa tabla mientras dura). tables = null -> todas.
async function runMaintenance(action, tables) {
  const sql = { analizar: 'ANALYZE TABLE ??', optimizar: 'OPTIMIZE TABLE ??' }[action];
  if (!sql) throw new Error('Acción de mantenimiento desconocida.');
  const [existing] = await pool.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name");
  const names = existing.map((t) => t.name);
  const wanted = tables && tables.length ? tables : names;
  const unknown = wanted.filter((t) => !names.includes(t));
  if (unknown.length) throw new Error(`Tabla desconocida: ${unknown.join(', ')}.`);
  const results = [];
  for (const table of wanted) {
    const started = Date.now();
    try {
      const [rows] = await pool.query(sql, [table]);
      const last = rows[rows.length - 1] || {};
      const failed = rows.some((r) => String(r.Msg_type).toLowerCase() === 'error');
      results.push({ table, ok: !failed, message: failed ? rows.map((r) => r.Msg_text).join(' / ') : String(last.Msg_text || 'OK'), ms: Date.now() - started });
    } catch (err) {
      results.push({ table, ok: false, message: err.message, ms: Date.now() - started });
    }
  }
  return results;
}

function monthsOf(value) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n >= 0 && n <= MAX_RETENTION_MONTHS ? n : null;
}

// Meses que se conservan los historicos. 0 = no borrar automaticamente.
async function retentionMonths() {
  const stored = monthsOf(await settingsService.get('history_retention_months'));
  return stored === null ? DEFAULT_RETENTION_MONTHS : stored;
}

async function setRetentionMonths(value) {
  const months = monthsOf(value);
  if (months === null) throw new Error(`Los meses a conservar deben ser un número entre 0 y ${MAX_RETENTION_MONTHS}.`);
  await settingsService.setMany({ history_retention_months: String(months) });
  return months;
}

// Cuanto hay en cada historico y cuanto quedaria fuera con `months` meses.
async function historyStatus(months) {
  const out = [];
  for (const h of HISTORIES) {
    const [[row]] = await pool.query(
      'SELECT COUNT(*) AS total, MIN(??) AS oldest, SUM(?? < DATE_SUB(NOW(), INTERVAL ? MONTH)) AS expired FROM ??',
      [h.dateColumn, h.dateColumn, months, h.table]
    );
    out.push({ ...h, total: Number(row.total), oldest: row.oldest, expired: Number(row.expired) || 0 });
  }
  return out;
}

// Borra lo anterior a `months` meses (0 = todo) de cada historico, y las
// sesiones "confiar en este navegador" ya vencidas. Devuelve cuanto borro.
async function purgeHistory(months) {
  const n = monthsOf(months);
  if (n === null) throw new Error('Meses no válidos.');
  const deleted = {};
  for (const h of HISTORIES) {
    const [result] = await pool.query('DELETE FROM ?? WHERE ?? < DATE_SUB(NOW(), INTERVAL ? MONTH)', [h.table, h.dateColumn, n]);
    deleted[h.key] = result.affectedRows;
  }
  const [expired] = await pool.query('DELETE FROM trusted_devices WHERE expires_at < NOW()');
  deleted.navegadores_vencidos = expired.affectedRows;
  return deleted;
}

module.exports = {
  MAX_COLUMNS, WARN_COLUMNS, DEFAULT_RETENTION_MONTHS, MAX_RETENTION_MONTHS, HISTORIES,
  tableStatus, runMaintenance, retentionMonths, setRetentionMonths, historyStatus, purgeHistory,
};
