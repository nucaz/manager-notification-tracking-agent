// Aplica el esquema contra la base de datos configurada en .env, de forma
// incremental y segura tanto en una base de datos nueva como en una que
// ya tiene parte (o todo) el esquema aplicado.
//
// Como funciona:
// - "0001_baseline" es sql/schema.sql completo (usa CREATE TABLE IF NOT
//   EXISTS en todas sus tablas), asi que en una base nueva crea todo de
//   una vez, y en una base que ya tiene esas tablas no hace nada.
// - Cualquier migracion adicional en sql/migrations/*.sql (numeradas,
//   0002 en adelante) se aplica en orden, una sola vez cada una - se
//   registra en la tabla schema_migrations para no repetirla. Cada
//   migracion debe escribirse con clausulas idempotentes de MariaDB
//   (ADD COLUMN IF NOT EXISTS, etc.) para tolerar correrse de mas sin
//   romper nada (ej. en una base nueva donde 0001_baseline ya trajo esa
//   columna).
//
// Uso: npm run migrate
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const env = require('../config/env');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'sql', 'schema.sql');
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'sql', 'migrations');

function loadMigrations() {
  const migrations = [{ name: '0001_baseline', sql: fs.readFileSync(SCHEMA_PATH, 'utf8') }];

  if (fs.existsSync(MIGRATIONS_DIR)) {
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      migrations.push({
        name: path.basename(file, '.sql'),
        sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'),
      });
    }
  }

  return migrations;
}

async function migrate() {
  const connection = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    multipleStatements: true,
  });

  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  const [appliedRows] = await connection.query('SELECT name FROM schema_migrations');
  const applied = new Set(appliedRows.map((r) => r.name));

  const migrations = loadMigrations();
  let appliedCount = 0;

  console.log(`Base de datos "${env.db.database}": revisando ${migrations.length} migracion(es)...`);

  for (const migration of migrations) {
    if (applied.has(migration.name)) {
      console.log(`  [ya aplicada] ${migration.name}`);
      continue;
    }
    console.log(`  [aplicando]   ${migration.name}`);
    await connection.query(migration.sql);
    await connection.query('INSERT INTO schema_migrations (name) VALUES (?)', [migration.name]);
    appliedCount += 1;
  }

  console.log(
    appliedCount === 0
      ? 'La base de datos ya estaba al día: no se aplicó ninguna migración nueva.'
      : `Migración completada: ${appliedCount} migración(es) nueva(s) aplicada(s).`
  );
  await connection.end();
}

migrate().catch((err) => {
  console.error('Error al migrar la base de datos:', err.message);
  process.exit(1);
});
