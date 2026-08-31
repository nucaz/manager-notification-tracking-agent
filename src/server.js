const app = require('./app');
const env = require('./config/env');
const { startScheduler } = require('./jobs/sendReminders');

app.listen(env.port, () => {
  console.log(`Servidor escuchando en http://0.0.0.0:${env.port} (entorno: ${env.nodeEnv})`);
  startScheduler();
});
