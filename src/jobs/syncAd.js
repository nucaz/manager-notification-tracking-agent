// Job diario: lee el directorio activo por LDAPS (solo lectura) y renueva la
// foto (ad_*). Si no esta configurado, no hace nada. Ver src/services/adService.js.
const cron = require('node-cron');
const adService = require('../services/adService');
const adChangeService = require('../services/adChangeService');

async function run() {
  // Solicitudes de cambio pendientes de mas de 7 dias y contrasenas no vistas de mas de 24 h.
  await adChangeService.expire().catch((err) => console.error('[ad] Error al vencer solicitudes:', err.message));
  const cfg = await adService.config();
  if (!cfg.url || !cfg.bindUser || !cfg.password || !cfg.caPem) return null;
  return adService.sync();
}

function startScheduler() {
  cron.schedule('40 6 * * *', () => {
    run()
      .then((r) => { if (r) console.log(`[ad] ${r.result}`); })
      .catch((err) => console.error('[ad] Error al leer el directorio activo:', err.message));
  });
  console.log('[ad] Lectura diaria del directorio activo programada (06:40), si está configurada.');
}

module.exports = { run, startScheduler };
