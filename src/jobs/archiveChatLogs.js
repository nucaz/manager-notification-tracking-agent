// Job diario: cierra y comprime la conversacion de AYER de
// agent_message_log (ver chatArchiveService). Corre despues de
// medianoche para asegurar que el dia anterior ya no va a recibir mas
// mensajes.
const cron = require('node-cron');
const chatArchiveService = require('../services/chatArchiveService');

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function runArchival(dateStr = yesterday()) {
  const result = await chatArchiveService.archiveDay(dateStr);
  console.log(
    `[chat-archivo] ${result.date}: ${result.pairs} conversación(es) archivada(s), ${result.messages} mensaje(s) comprimido(s).`
  );
  return result;
}

function startScheduler() {
  // 00:30 (hora del servidor) - deja un margen despues de medianoche.
  cron.schedule('30 0 * * *', () => {
    runArchival().catch((err) => console.error('[chat-archivo] Error:', err.message));
  });
  console.log('[chat-archivo] Tarea programada activa (todos los dias a las 00:30, archiva el día anterior).');
}

if (require.main === module) {
  const argDate = process.argv[2];
  runArchival(argDate)
    .then((result) => {
      console.log(`Listo. ${result.pairs} conversación(es), ${result.messages} mensaje(s).`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Error archivando:', err.message);
      process.exit(1);
    });
}

module.exports = { runArchival, startScheduler };
