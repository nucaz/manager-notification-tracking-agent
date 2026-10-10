const app = require('./app');
const env = require('./config/env');
const { startScheduler } = require('./jobs/sendReminders');
const { startPolling } = require('./jobs/telegramPoller');
const { startScheduler: startChatArchiveScheduler } = require('./jobs/archiveChatLogs');
const { startScheduler: startHistoryPurgeScheduler } = require('./jobs/purgeHistory');
const { startScheduler: startM365Scheduler } = require('./jobs/syncM365');
const { startScheduler: startAdScheduler } = require('./jobs/syncAd');
const { startScheduler: startExternalSyncScheduler } = require('./jobs/syncExternal');
const { startScheduler: startOmadaScheduler } = require('./jobs/syncOmada');

app.listen(env.port, () => {
  console.log(`Servidor escuchando en http://0.0.0.0:${env.port} (entorno: ${env.nodeEnv})`);
  startScheduler();
  startPolling();
  startChatArchiveScheduler();
  startHistoryPurgeScheduler();
  startM365Scheduler();
  startAdScheduler();
  startExternalSyncScheduler();
  startOmadaScheduler();
});
