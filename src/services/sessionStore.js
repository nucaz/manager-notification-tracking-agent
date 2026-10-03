// Sesiones guardadas en MariaDB (tabla `sessions`) en vez de en la memoria
// del proceso: sobreviven a un reinicio o a un despliegue (antes, cada
// reinicio cerraba la sesion de todos) y no crecen sin limite en memoria.
//
// La fila vence cuando vence la cookie; las vencidas se borran solas cada
// 15 minutos.
const session = require('express-session');
const pool = require('../db/pool');

const PRUNE_MS = 15 * 60 * 1000;
const FALLBACK_MS = 12 * 60 * 60 * 1000;

const expiresOf = (sess) => {
  const exp = sess && sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires) : null;
  return exp && !Number.isNaN(exp.getTime()) ? exp : new Date(Date.now() + FALLBACK_MS);
};

class MariaDbSessionStore extends session.Store {
  constructor({ prune = true } = {}) {
    super();
    if (prune) {
      this.timer = setInterval(() => { this.prune().catch((err) => console.error('[sesiones] Error al limpiar:', err.message)); }, PRUNE_MS);
      this.timer.unref();
    }
  }

  get(sid, cb) {
    pool.query('SELECT data FROM sessions WHERE sid = ? AND expires > NOW()', [sid])
      .then(([rows]) => cb(null, rows[0] ? JSON.parse(rows[0].data) : null))
      .catch((err) => cb(err));
  }

  set(sid, sess, cb) {
    pool.query(
      'INSERT INTO sessions (sid, expires, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE expires = VALUES(expires), data = VALUES(data)',
      [sid, expiresOf(sess), JSON.stringify(sess)]
    ).then(() => cb && cb(null)).catch((err) => cb && cb(err));
  }

  // Con "rolling" cada solicitud alarga la sesion: solo se mueve el vencimiento.
  touch(sid, sess, cb) {
    pool.query('UPDATE sessions SET expires = ? WHERE sid = ?', [expiresOf(sess), sid])
      .then(() => cb && cb(null)).catch((err) => cb && cb(err));
  }

  destroy(sid, cb) {
    pool.query('DELETE FROM sessions WHERE sid = ?', [sid]).then(() => cb && cb(null)).catch((err) => cb && cb(err));
  }

  async prune() {
    const [res] = await pool.query('DELETE FROM sessions WHERE expires < NOW()');
    return res.affectedRows;
  }
}

module.exports = { MariaDbSessionStore };
