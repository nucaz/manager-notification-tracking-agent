// Job cada 5 minutos: lee los controladores Omada configurados (solo
// lectura) y guarda equipos, clientes y una muestra de consumo. Si no hay
// ninguno habilitado, no hace nada. Ver src/services/omadaService.js.
const cron = require('node-cron');
const omadaService = require('../services/omadaService');

async function run() {
  const r = await omadaService.sync();
  return r.results;
}

function startScheduler() {
  cron.schedule('*/5 * * * *', () => {
    run()
      .then((results) => results.filter((x) => !x.ok).forEach((x) => console.error(`[omada] ${x.name}: ${x.detail}`)))
      .catch((err) => console.error('[omada] Error al leer los controladores:', err.message));
  });
  console.log('[omada] Lectura de los controladores Omada programada (cada 5 minutos), si hay alguno configurado.');
}

module.exports = { run, startScheduler };
