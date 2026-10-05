// Conexiones del asistente "Preguntar a la IA". Si hay un usuario de
// MariaDB propio (ASSISTANT_DB_USER, solo SELECT sobre las tablas que
// consulta), se usa ese; si no, el pool de la aplicacion. En los dos casos
// cada consulta corre en START TRANSACTION READ ONLY (ver assistantData.js).
const mysql = require('mysql2/promise');
const env = require('../config/env');
const appPool = require('./pool');

const pool = env.assistantDb.user
  ? mysql.createPool({
    host: env.db.host,
    port: env.db.port,
    database: env.db.database,
    user: env.assistantDb.user,
    password: env.assistantDb.password,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    dateStrings: true,
  })
  : appPool;

module.exports = pool;
module.exports.dedicated = !!env.assistantDb.user;
