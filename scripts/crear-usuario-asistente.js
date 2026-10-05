// Crea (o actualiza) el usuario de MariaDB del asistente "Preguntar a la
// IA": solo SELECT, y solo sobre las tablas que el asistente consulta
// (src/services/assistantData.js -> tablesUsed); de `users`, solo las
// columnas que muestra. Asi esa conexion no puede escribir ni leer
// contrasenas, sesiones ni configuracion, aunque algo fallara.
//
// Uso, dentro del contenedor de la aplicacion:
//   ASSISTANT_DB_USER=asistente ASSISTANT_DB_PASSWORD=... node scripts/crear-usuario-asistente.js
// Con DB_ROOT_PASSWORD lo aplica directo; sin ella imprime el SQL para
// pasarlo por tuberia a `mariadb -uroot` en el contenedor de la base (no
// mostrarlo en pantalla: lleva la contrasena). Luego poner las dos variables
// en el .env y recrear la aplicacion. Volver a correrlo si se agrega un
// conjunto con tablas nuevas.
const mysql = require('mysql2/promise');
const env = require('../src/config/env');
const { tablesUsed } = require('../src/services/assistantData');

const ONLY_COLUMNS = { users: ['id', 'full_name', 'email', 'role', 'active', 'otp_enabled', 'locked', 'created_at'] };

function statements(user, password) {
  const db = mysql.escapeId(env.db.database);
  const who = `${mysql.escape(user)}@'%'`;
  const list = [
    `CREATE USER IF NOT EXISTS ${who} IDENTIFIED BY ${mysql.escape(password)}`,
    `ALTER USER ${who} IDENTIFIED BY ${mysql.escape(password)}`,
    `REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${who}`,
  ];
  for (const t of tablesUsed()) {
    const cols = ONLY_COLUMNS[t] ? `(${ONLY_COLUMNS[t].map((c) => mysql.escapeId(c)).join(', ')})` : '';
    list.push(`GRANT SELECT ${cols} ON ${db}.${mysql.escapeId(t)} TO ${who}`);
  }
  return list;
}

async function main() {
  const user = process.env.ASSISTANT_DB_USER;
  const password = process.env.ASSISTANT_DB_PASSWORD;
  if (!user || !/^[a-z_][a-z0-9_]{2,31}$/i.test(user)) throw new Error('Defina ASSISTANT_DB_USER (letras, números y _).');
  if (!password || password.length < 16) throw new Error('Defina ASSISTANT_DB_PASSWORD (16 caracteres o más).');
  const sql = statements(user, password);
  if (!process.env.DB_ROOT_PASSWORD) {
    process.stdout.write(`${sql.join(';\n')};\n`);
    return;
  }
  const conn = await mysql.createConnection({ host: env.db.host, port: env.db.port, user: 'root', password: process.env.DB_ROOT_PASSWORD });
  try {
    for (const s of sql) await conn.query(s);
    console.error(`Usuario ${user}: SELECT sobre ${sql.length - 3} tablas.`);
  } finally {
    await conn.end();
  }
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exit(1); });
module.exports = { statements, ONLY_COLUMNS };
