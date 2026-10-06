// Job diario: lee el tenant de Microsoft 365 (solo lectura, Microsoft
// Graph) para mostrar diferencias con lo registrado. Si no esta
// configurado, no hace nada. Ver src/services/m365Service.js.
const cron = require('node-cron');
const m365Service = require('../services/m365Service');

async function run() {
  const cfg = await m365Service.config();
  if (!cfg.tenant || !cfg.clientId || !cfg.secret) return null;
  return m365Service.sync();
}

function startScheduler() {
  cron.schedule('20 6 * * *', () => {
    run()
      .then((r) => { if (r) console.log(`[m365] ${r.result}`); })
      .catch((err) => console.error('[m365] Error al leer el tenant:', err.message));
  });
  console.log('[m365] Lectura diaria del tenant programada (06:20), si está configurada.');
}

module.exports = { run, startScheduler };
