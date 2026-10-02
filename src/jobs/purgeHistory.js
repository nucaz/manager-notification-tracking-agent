// Job diario: aplica la retencion de historicos (auditoria e historial de
// chat). Por defecto se conservan 3 meses; se cambia en Mantenimiento
// (0 = no borrar automaticamente). Ver maintenanceService.
const cron = require('node-cron');
const maintenanceService = require('../services/maintenanceService');
const auditService = require('../services/auditService');

async function runPurge() {
  const months = await maintenanceService.retentionMonths();
  if (months === 0) return { months, deleted: null };
  const deleted = await maintenanceService.purgeHistory(months);
  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  if (total > 0) {
    // Solo se deja constancia cuando efectivamente se borro algo.
    await auditService.log(null, {
      action: 'history_purged', target: `automático: anterior a ${months} mes(es)`,
      detail: Object.entries(deleted).map(([k, n]) => `${k}: ${n}`).join(', '),
    });
  }
  return { months, deleted };
}

function startScheduler() {
  // 01:15: despues del archivado del chat del dia anterior (00:30).
  cron.schedule('15 1 * * *', () => {
    runPurge()
      .then((r) => { if (r.deleted) console.log(`[retencion] Históricos anteriores a ${r.months} mes(es): ${JSON.stringify(r.deleted)}`); })
      .catch((err) => console.error('[retencion] Error:', err.message));
  });
  console.log('[retencion] Tarea programada activa (todos los dias a las 01:15, borra históricos fuera del plazo).');
}

module.exports = { runPurge, startScheduler };
