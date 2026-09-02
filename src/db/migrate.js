// Aplica sql/schema.sql contra la base de datos configurada en .env
// Uso: npm run migrate
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const env = require('../config/env');

async function migrate() {
  const schemaPath = path.join(__dirname, '..', '..', 'sql', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  const connection = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    multipleStatements: true,
  });

  console.log(`Aplicando esquema a la base de datos "${env.db.database}"...`);
  await connection.query(sql);
  console.log('Migracion completada correctamente.');
  await connection.end();
}

migrate().catch((err) => {
  console.error('Error al migrar la base de datos:', err.message);
  process.exit(1);
});
