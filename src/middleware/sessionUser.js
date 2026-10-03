// Duracion de la sesion y control de que el usuario sigue habilitado.
//
// La sesion vence por inactividad (express-session con rolling): 12 horas
// sin usar la aplicacion, o 30 dias si al ingresar se marco "Mantener la
// sesion iniciada". Como una sesion puede durar semanas, cada pocos minutos
// se vuelve a leer el usuario: si se desactivo, se bloqueo o se borro, la
// sesion se cierra en ese momento; si le cambiaron el rol o el nombre, se
// aplica sin tener que volver a ingresar.
const pool = require('../db/pool');

const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const RECHECK_MS = 2 * 60 * 1000;

async function refreshSessionUser(req, res, next) {
  const current = req.session && req.session.user;
  if (!current || (req.session.userCheckedAt && Date.now() - req.session.userCheckedAt < RECHECK_MS)) return next();
  try {
    const [[user]] = await pool.query('SELECT id, full_name, email, role, active, locked FROM users WHERE id = ?', [current.id]);
    if (!user || !user.active || user.locked) {
      return req.session.regenerate(() => {
        req.flash('error', 'Su sesión se cerró: el usuario fue desactivado o bloqueado. Consulte con un administrador.');
        res.redirect('/login');
      });
    }
    req.session.user = { id: user.id, full_name: user.full_name, email: user.email, role: user.role };
    req.session.userCheckedAt = Date.now();
  } catch (err) {
    console.error('[sesiones] No se pudo comprobar el usuario:', err.message); // no se corta la solicitud por un fallo puntual
  }
  next();
}

module.exports = { SESSION_IDLE_MS, SESSION_REMEMBER_MS, RECHECK_MS, refreshSessionUser };
