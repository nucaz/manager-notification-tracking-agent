// Job cada 5 minutos (dos minutos despues de la lectura de Omada, para usar
// su dato fresco): comprueba si cada switch y punto de acceso en uso responde.
// Ver src/services/netMonitorService.js.
const cron = require('node-cron');
const netMonitorService = require('../services/netMonitorService');

function startScheduler() {
  cron.schedule('2-59/5 * * * *', () => {
    netMonitorService.run()
      .then((r) => { if (!r.skipped && r.changed) console.log(`[red] Monitoreo: ${r.up} activos, ${r.down} inactivos, ${r.changed} cambiaron de estado.`); })
      .catch((err) => console.error('[red] Error en el monitoreo de switches y AP:', err.message));
  });
  console.log('[red] Monitoreo de switches y AP programado (cada 5 minutos).');
}

module.exports = { startScheduler };
