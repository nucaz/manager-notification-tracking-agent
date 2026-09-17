// Log de auditoria: quien hizo que, desde donde. Nunca debe tumbar la
// accion que esta registrando - un fallo aca solo se registra en consola,
// jamas se propaga (misma logica que un logger normal).
const pool = require('../db/pool');

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket && req.socket.remoteAddress;
}

// user puede ser el objeto de sesion ({id, email}) o null (ej. login
// fallido antes de saber si el usuario existe).
async function log(req, { user, action, target, detail } = {}) {
  try {
    await pool.query(
      `INSERT INTO audit_log (user_id, user_email, action, target, detail, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        user ? user.id : null,
        user ? user.email : null,
        action,
        target || null,
        detail || null,
        req ? clientIp(req) : null,
        req ? String(req.headers['user-agent'] || '').slice(0, 250) : null,
      ]
    );
  } catch (err) {
    console.error(`[auditoria] No se pudo registrar el evento "${action}":`, err.message);
  }
}

module.exports = { log };
