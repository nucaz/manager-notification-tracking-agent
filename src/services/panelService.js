// Resumen de los modulos nuevos para el Panel: usuarios de Clinic, cuentas de
// correo (Microsoft 365), solicitudes, y de DevOps Sidecar los repositorios y
// los respaldos. Cada bloque se calcula aparte: si uno falla (por ejemplo el
// sidecar no responde) el panel se muestra igual, con el motivo en ese bloque.
const pool = require('../db/pool');
const clinicService = require('./clinicService');
const settingsService = require('./settingsService');
const devopsSidecarClient = require('./devopsSidecarClient');
const adService = require('./adService');

async function clinic() {
  const counts = await clinicService.counts();
  const [[last]] = await pool.query('SELECT created_at, file_name FROM clinic_imports ORDER BY id DESC LIMIT 1');
  const [[recent]] = await pool.query(
    `SELECT COUNT(*) AS n FROM clinic_users c JOIN clinic_user_origin o ON o.clinic_user_id = c.id
     WHERE c.status = 'activo' AND o.last_login_at >= NOW() - INTERVAL 30 DAY`
  );
  return {
    activos: counts.activo || 0, inactivos: counts.inactivo || 0, bajas: counts.baja || 0, recientes: Number(recent.n),
    depurar: counts.alerts.depurar, bajaActiva: counts.alerts.baja_activa, sinEmpleado: counts.alerts.sin_empleado,
    ultimaImportacion: last ? String(last.created_at).slice(0, 16) : null,
  };
}

async function m365() {
  const [[a]] = await pool.query(
    `SELECT SUM(status = 'activa' AND account_type = 'usuario') AS usuarios, SUM(account_type = 'compartido' AND status <> 'eliminada') AS compartidos,
            SUM(status IN ('bloqueada', 'desactivada')) AS suspendidas, SUM(status = 'eliminada') AS eliminadas, COUNT(*) AS total,
            SUM(status = 'activa' AND (licenses IS NULL OR licenses = '')) AS sin_licencia
     FROM m365_accounts`
  );
  const [[sku]] = await pool.query('SELECT COALESCE(SUM(prepaid), 0) AS compradas, COALESCE(SUM(consumed), 0) AS asignadas FROM m365_skus');
  const [[open]] = await pool.query("SELECT COUNT(*) AS n FROM service_requests WHERE module = 'm365' AND status IN ('pendiente', 'aprobada', 'en_proceso')");
  const lastSync = await settingsService.get('m365_last_sync');
  const m365Service = require('./m365Service'); // eslint-disable-line global-require
  const accounts = await m365Service.list({});
  const diferencias = lastSync ? accounts.filter((r) => r.diffs.length).length : 0;
  const IDLE = ['d180', 'd365', 'mas365', 'nunca'];
  const sinConexion = accounts.filter((r) => r.status === 'activa' && r.account_type === 'usuario' && IDLE.includes(r.conexion)).length;
  const conexionLeida = accounts.some((r) => r.activity_read_at);
  const n = (v) => Number(v || 0);
  return {
    usuarios: n(a.usuarios), compartidos: n(a.compartidos), suspendidas: n(a.suspendidas), eliminadas: n(a.eliminadas), total: n(a.total),
    sinLicencia: n(a.sin_licencia), compradas: n(sku.compradas), asignadas: n(sku.asignadas), libres: n(sku.compradas) - n(sku.asignadas),
    solicitudesAbiertas: n(open.n), diferencias, sinConexion, conexionLeida, ultimaLectura: lastSync ? String(lastSync).replace('T', ' ').slice(0, 16) : null,
  };
}

async function solicitudes() {
  const [rows] = await pool.query(
    `SELECT module, SUM(status IN ('pendiente', 'aprobada', 'en_proceso')) AS abiertas,
            SUM(status = 'completada' AND completed_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')) AS mes
     FROM service_requests GROUP BY module`
  );
  const by = Object.fromEntries(rows.map((r) => [r.module, { abiertas: Number(r.abiertas || 0), mes: Number(r.mes || 0) }]));
  const sum = (k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
  return { abiertas: sum('abiertas'), completadasMes: sum('mes'), porModulo: by };
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('DevOps Sidecar no respondió a tiempo.')), ms))]);

async function devops() {
  const [repos, jobs] = await withTimeout(Promise.all([devopsSidecarClient.listRepos(), devopsSidecarClient.backupJobs()]), 6000);
  const active = repos.filter((r) => r.active);
  const syncErrors = active.filter((r) => /^ERROR/i.test(String(r.last_sync_status || '')));
  const lastSync = repos.map((r) => r.last_synced_at).filter(Boolean).sort().pop() || null;
  const enabled = jobs.filter((j) => j.enabled);
  const status = (s) => enabled.filter((j) => j.last_status === s).length;
  const lastRun = jobs.map((j) => j.last_run_at).filter(Boolean).sort().pop() || null;
  const next = enabled.map((j) => j.next_run).filter(Boolean).sort()[0] || null;
  return {
    repos: repos.length, reposActivos: active.length, syncErrors: syncErrors.map((r) => r.name),
    ultimaSync: lastSync ? String(lastSync).replace('T', ' ').slice(0, 16) : null,
    trabajos: jobs.length, trabajosActivos: enabled.length, ok: status('ok'), avisos: status('ok_con_avisos'),
    errores: enabled.filter((j) => j.last_status === 'error').map((j) => j.name), sinEjecutar: enabled.filter((j) => !j.last_run_at).length,
    enCurso: jobs.filter((j) => j.running).length,
    ultimoRespaldo: lastRun ? String(lastRun).replace('T', ' ').slice(0, 16) : null, proximo: next,
  };
}

async function directorio() {
  const [ov, run, [[pend]]] = await Promise.all([adService.overview(), adService.lastRun(),
    pool.query("SELECT COUNT(*) AS n FROM ad_change_requests WHERE status = 'pendiente' AND expires_at > NOW()")]);
  return { ...ov, pendingChanges: Number(pend.n || 0), domain: run.summary && run.summary.domain, lastRead: run.ok ? String(run.ok.finished_at || run.ok.started_at).slice(0, 16) : null,
    lastError: run.last && run.last.status === 'error' ? run.last.error : null, recycleBin: run.summary ? run.summary.recycleBin : null };
}

// { clinic, m365, solicitudes, devops }: cada uno { data } o { error }; solo
// los modulos que este usuario tiene habilitados.
async function summary(user, enabledModules = {}) {
  const wanted = {
    clinic: enabledModules.clinic ? clinic : null,
    m365: enabledModules.m365 ? m365 : null,
    solicitudes: enabledModules.solicitudes ? solicitudes : null,
    directorio: enabledModules.directorio ? directorio : null,
    devops: user && (['superadmin', 'admin'].includes(user.role) || enabledModules.devops) ? devops : null,
  };
  const out = {};
  await Promise.all(Object.entries(wanted).map(async ([k, fn]) => {
    if (!fn) return;
    try {
      out[k] = { data: await fn() };
    } catch (err) {
      out[k] = { error: err.message };
    }
  }));
  return out;
}

module.exports = { summary, clinic, m365, solicitudes, devops, directorio };
