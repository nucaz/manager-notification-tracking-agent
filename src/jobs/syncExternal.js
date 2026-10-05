// Tarea cada 30 minutos: renueva la copia local de GLPI y de los
// repositorios de DevOps Sidecar que consulta el asistente (ver
// src/services/externalSyncService.js). Arranca 1 minuto despues de
// iniciar, para no competir con el arranque.
const cron = require('node-cron');
const externalSyncService = require('../services/externalSyncService');

function run() {
  externalSyncService.syncAll()
    .then((done) => {
      const errors = Object.entries(done).filter(([, v]) => typeof v === 'string');
      if (errors.length) console.error(`[copia externa] ${errors.map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    })
    .catch((err) => console.error('[copia externa] Error:', err.message));
}

function startScheduler() {
  cron.schedule('*/30 * * * *', run);
  setTimeout(run, 60 * 1000).unref();
  console.log('[copia externa] Tarea programada activa (cada 30 min copia GLPI y los repositorios de DevOps para el asistente).');
}

module.exports = { startScheduler, run };
