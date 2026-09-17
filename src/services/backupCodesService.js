// Codigos de respaldo de un solo uso para el 2FA. Se guarda solo el hash
// de cada uno (bcrypt, igual que una contrasena) - el valor en texto
// plano solo existe en el momento de generarlos, para mostrarlo una vez.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

const CODE_COUNT = 10;
// Sin 0/O/1/I/L para que no se confundan al copiarlos a mano.
const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function normalize(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function randomCode() {
  let raw = '';
  for (let i = 0; i < 10; i++) {
    raw += CHARSET[crypto.randomInt(CHARSET.length)];
  }
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

// Genera CODE_COUNT codigos nuevos, borra los anteriores de ese usuario
// (si los habia) y guarda los hashes. Devuelve los codigos EN TEXTO
// PLANO - es la unica vez que existen fuera de la memoria del navegador
// del usuario, quien los debe guardar en ese momento.
async function replaceCodesForUser(userId) {
  const plainCodes = Array.from({ length: CODE_COUNT }, randomCode);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM backup_codes WHERE user_id = ?', [userId]);
    for (const code of plainCodes) {
      const hash = await bcrypt.hash(normalize(code), 10);
      await conn.query('INSERT INTO backup_codes (user_id, code_hash) VALUES (?, ?)', [userId, hash]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return plainCodes;
}

// Verifica un codigo contra los que el usuario todavia no uso, y si
// coincide lo marca usado (no se puede reutilizar). Devuelve true/false.
async function verifyAndConsume(userId, code) {
  const normalized = normalize(code);
  if (!normalized) return false;
  const [rows] = await pool.query(
    'SELECT id, code_hash FROM backup_codes WHERE user_id = ? AND used_at IS NULL',
    [userId]
  );
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(normalized, row.code_hash)) {
      await pool.query('UPDATE backup_codes SET used_at = NOW() WHERE id = ?', [row.id]);
      return true;
    }
  }
  return false;
}

async function remainingCount(userId) {
  const [[row]] = await pool.query(
    'SELECT COUNT(*) AS n FROM backup_codes WHERE user_id = ? AND used_at IS NULL',
    [userId]
  );
  return row.n;
}

module.exports = { replaceCodesForUser, verifyAndConsume, remainingCount };
