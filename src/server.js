const app = require('./app');
const env = require('./config/env');
const { startScheduler } = require('./jobs/sendReminders');
const { startPolling } = require('./jobs/telegramPoller');
const { startScheduler: startChatArchiveScheduler } = require('./jobs/archiveChatLogs');

app.listen(env.port, () => {
  console.log(`Servidor escuchando en http://0.0.0.0:${env.port} (entorno: ${env.nodeEnv})`);
  startScheduler();
  startPolling();
  startChatArchiveScheduler();
});
