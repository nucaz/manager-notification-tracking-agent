// Crea (o actualiza la contraseña de) el usuario administrador inicial
// definido en .env. Uso: npm run seed
const bcrypt = require('bcryptjs');
const pool = require('./pool');
const env = require('../config/env');

async function seed() {
  const passwordHash = await bcrypt.hash(env.admin.password, 12);

  const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [env.admin.email]);

  if (existing.length > 0) {
    await pool.query(
      'UPDATE users SET full_name = ?, password_hash = ?, role = "admin", active = 1 WHERE email = ?',
      [env.admin.name, passwordHash, env.admin.email]
    );
    console.log(`Usuario administrador actualizado: ${env.admin.email}`);
  } else {
    await pool.query(
      'INSERT INTO users (full_name, email, password_hash, role, active) VALUES (?, ?, ?, "admin", 1)',
      [env.admin.name, env.admin.email, passwordHash]
    );
    console.log(`Usuario administrador creado: ${env.admin.email}`);
  }
  console.log('Recuerda: en el primer inicio de sesion se pedira configurar la verificacion en dos pasos (2FA).');

  process.exit(0);
}

seed().catch((err) => {
  console.error('Error al crear el usuario administrador:', err.message);
  process.exit(1);
});
