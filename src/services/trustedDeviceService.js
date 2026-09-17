// "Confiar en este navegador": permite saltar el codigo TOTP por un
// tiempo en un equipo donde ya se verifico una vez. Solo se guarda el
// hash del token (nunca el valor crudo) - mismo principio que una
// contrasena: la cookie tiene el valor crudo, la base de datos solo el
// hash, y uno no se puede reconstruir a partir del otro.
const crypto = require('crypto');
const pool = require('../db/pool');

const COOKIE_NAME = 'trusted_device';
const TRUSTED_DAYS = 30;
const MAX_AGE_MS = TRUSTED_DAYS * 24 * 60 * 60 * 1000;

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// True si la cookie que trae este request corresponde a un dispositivo
// de confianza vigente para userId.
async function isTrusted(req, userId) {
  const raw = req.cookies && req.cookies[COOKIE_NAME];
  if (!raw) return false;
  const [rows] = await pool.query(
    'SELECT id FROM trusted_devices WHERE user_id = ? AND token_hash = ? AND expires_at > NOW() LIMIT 1',
    [userId, hashToken(raw)]
  );
  return rows.length > 0;
}

// Genera un token nuevo, lo guarda (hasheado) y setea la cookie httpOnly
// correspondiente en la respuesta.
async function trustThisDevice(req, res, userId) {
  const raw = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + MAX_AGE_MS);
  const label = String(req.headers['user-agent'] || '').slice(0, 200) || null;
  await pool.query(
    'INSERT INTO trusted_devices (user_id, token_hash, label, expires_at) VALUES (?, ?, ?, ?)',
    [userId, hashToken(raw), label, expiresAt]
  );
  res.cookie(COOKIE_NAME, raw, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

async function listForUser(userId) {
  const [rows] = await pool.query(
    'SELECT id, label, created_at, expires_at FROM trusted_devices WHERE user_id = ? ORDER BY created_at DESC',
    [userId]
  );
  return rows;
}

async function revoke(userId, trustedDeviceId) {
  await pool.query('DELETE FROM trusted_devices WHERE id = ? AND user_id = ?', [trustedDeviceId, userId]);
}

module.exports = { COOKIE_NAME, isTrusted, trustThisDevice, listForUser, revoke };
