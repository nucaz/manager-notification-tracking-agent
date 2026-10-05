// Copia local de las fuentes externas que consulta el asistente: el
// inventario de GLPI (computadoras, monitores, impresoras) y los
// repositorios de DevOps Sidecar. Antes cada pregunta descargaba TODO GLPI
// por su API; ahora se consulta una tabla con indices (glpi_assets,
// devops_repos) y se renueva:
//   - cada 30 minutos (src/jobs/syncExternal.js), si la fuente esta configurada;
//   - al consultarla, si la copia es mas vieja que MAX_AGE (una sola
//     descarga a la vez por fuente aunque pregunten varios).
// Si no se puede renovar y hay una copia anterior, se usa esa y se avisa
// de que fecha es. Tope de filas: el de listAllItems (20 000 por tipo).
const pool = require('../db/pool');
const glpiClient = require('./glpiClient');
const devopsSidecarClient = require('./devopsSidecarClient');
const ssoService = require('./ssoService');

const GLPI_TYPES = ['computadoras', 'monitores', 'impresoras'];
const MAX_AGE_MIN = { glpi: 60, devops_repos: 10 };
const GLPI_FIELDS = ['name', 'state', 'type', 'manufacturer', 'model', 'serial', 'otherserial', 'location', 'user', 'entity', 'date_mod',
  'os', 'os_version', 'processor', 'memory_type', 'memory', 'ip'];
const SIZES = { name: 255, state: 100, type: 100, manufacturer: 150, model: 150, serial: 150, otherserial: 150, location: 255, user: 150,
  entity: 255, date_mod: 30, os: 150, os_version: 100, processor: 255, memory_type: 100, memory: 60, ip: 255 };

const cut = (v, n) => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s ? s.slice(0, n) : null;
};
const running = new Map(); // fuente -> promesa en curso

async function state(source) {
  const [[row]] = await pool.query('SELECT * FROM external_sync_state WHERE source = ?', [source]);
  return row || null;
}

async function record(source, { rows = null, error = null }) {
  if (error) {
    await pool.query(`INSERT INTO external_sync_state (source, last_error, last_attempt_at) VALUES (?, ?, NOW())
      ON DUPLICATE KEY UPDATE last_error = VALUES(last_error), last_attempt_at = NOW()`, [source, String(error).slice(0, 500)]);
  } else {
    await pool.query(`INSERT INTO external_sync_state (source, synced_at, row_count, last_error, last_attempt_at) VALUES (?, NOW(), ?, NULL, NOW())
      ON DUPLICATE KEY UPDATE synced_at = NOW(), row_count = VALUES(row_count), last_error = NULL, last_attempt_at = NOW()`, [source, rows]);
  }
}

// Reemplaza el contenido de una fuente en una transaccion: quien consulta
// ve la copia anterior completa o la nueva completa, nunca a medias.
async function replace(deleteSql, deleteParams, insertSql, rows) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(deleteSql, deleteParams);
    for (let i = 0; i < rows.length; i += 500) await conn.query(insertSql, [rows.slice(i, i + 500)]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function syncGlpi(typeKey) {
  const items = await glpiClient.listAllItems(typeKey, {});
  const rows = items.filter((r) => Number.isFinite(Number(r.id)))
    .map((r) => [typeKey, Number(r.id), ...GLPI_FIELDS.map((f) => cut(r[f], SIZES[f]))]);
  await replace('DELETE FROM glpi_assets WHERE asset_type = ?', [typeKey],
    `INSERT INTO glpi_assets (asset_type, glpi_id, ${GLPI_FIELDS.map((f) => (f === 'user' ? 'user_name' : f)).join(', ')}) VALUES ?`, rows);
  return rows.length;
}

const dateTime = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) : null);
async function syncRepos() {
  const repos = await devopsSidecarClient.listRepos();
  const rows = [];
  for (const repo of repos) {
    let audit = null;
    try {
      const last = await devopsSidecarClient.latestReport(repo.id);
      audit = last && last.found ? [last.report_date, last.ai_provider_used ? `(${last.ai_provider_used})` : ''].filter(Boolean).join(' ') : 'Sin auditorías';
    } catch (_) { /* sin dato de auditoria */ }
    rows.push([Number(repo.id), cut(repo.name, 200) || `#${repo.id}`, cut(repo.github_url, 500), repo.active ? 1 : 0,
      Number.isFinite(Number(repo.sync_interval_minutes)) ? Number(repo.sync_interval_minutes) : null,
      dateTime(repo.last_synced_at), cut(repo.last_sync_status, 100), cut(audit, 120)]);
  }
  await replace('DELETE FROM devops_repos', [],
    'INSERT INTO devops_repos (id, name, github_url, active, sync_interval_minutes, last_synced_at, last_sync_status, last_audit) VALUES ?', rows);
  return rows.length;
}

function sync(source) {
  if (running.has(source)) return running.get(source);
  const job = (async () => {
    try {
      const rows = source === 'devops_repos' ? await syncRepos() : await syncGlpi(source.replace(/^glpi_/, ''));
      await record(source, { rows });
      return rows;
    } catch (err) {
      await record(source, { error: err.message }).catch(() => {});
      throw err;
    } finally {
      running.delete(source);
    }
  })();
  running.set(source, job);
  return job;
}

// Antes de consultar: renueva si la copia esta vieja. Devuelve avisos para
// la respuesta (copia de otra fecha) o lanza error si no hay ninguna copia.
async function ensureFresh(source) {
  const maxAge = (source.startsWith('glpi_') ? MAX_AGE_MIN.glpi : MAX_AGE_MIN[source]) * 60 * 1000;
  const st = await state(source);
  const syncedAt = st && st.synced_at ? new Date(String(st.synced_at).replace(' ', 'T')) : null;
  if (syncedAt && Date.now() - syncedAt.getTime() < maxAge) return [];
  try {
    await sync(source);
    return [];
  } catch (err) {
    const name = source === 'devops_repos' ? 'DevOps Sidecar' : 'GLPI';
    if (!syncedAt) throw new Error(`No se pudo leer ${name} y todavía no hay una copia local: ${err.message}`);
    return [`No se pudo actualizar desde ${name} (${err.message}); los datos son de la copia del ${String(st.synced_at).slice(0, 16)}.`];
  }
}

// Tarea programada: renueva lo que este configurado. Sin configuracion no
// se intenta (y no se llena el log de errores).
async function syncAll() {
  const done = {};
  const glpi = await glpiClient.getConfig().catch(() => null);
  if (glpi && glpi.baseUrl) {
    for (const t of GLPI_TYPES) done[`glpi_${t}`] = await sync(`glpi_${t}`).catch((e) => `error: ${e.message}`);
  }
  const sidecar = await devopsSidecarClient.getConfig().catch(() => null);
  if (ssoService.enabled() || (sidecar && sidecar.user && sidecar.password)) done.devops_repos = await sync('devops_repos').catch((e) => `error: ${e.message}`);
  return done;
}

module.exports = { GLPI_TYPES, sync, syncAll, ensureFresh, state };
