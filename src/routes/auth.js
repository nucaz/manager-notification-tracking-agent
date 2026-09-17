const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { verifyCsrfToken } = require('../middleware/csrf');
const auditService = require('../services/auditService');
const trustedDeviceService = require('../services/trustedDeviceService');
const { completeLogin } = require('./twoFactor');

const router = express.Router();

// Limite de intentos de login por IP: mitiga fuerza bruta sobre la contraseña.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Demasiados intentos de inicio de sesion. Intenta de nuevo en unos minutos.',
});

// Ademas del rate-limit por IP (arriba), esto es un bloqueo POR CUENTA:
// protege contra fuerza bruta distribuida desde varias IPs contra un
// mismo usuario. Solo un admin puede destrabarla (ver /usuarios).
const MAX_LOGIN_ATTEMPTS = 5;

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { title: 'Iniciar sesion' });
});

router.post('/login', loginLimiter, verifyCsrfToken, async (req, res) => {
  const { email, password } = req.body;
  try {
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE email = ? AND active = 1 LIMIT 1',
      [email]
    );
    const user = rows[0];

    if (user && user.locked) {
      await auditService.log(req, {
        user: { id: user.id, email: user.email },
        action: 'login_blocked',
        target: user.email,
        detail: 'cuenta bloqueada por intentos fallidos',
      });
      req.flash('error', 'Esta cuenta está bloqueada por demasiados intentos fallidos. Pide a un administrador que la desbloquee en Usuarios.');
      return res.redirect('/login');
    }

    const ok = user && (await bcrypt.compare(password || '', user.password_hash));

    if (!ok) {
      if (user) {
        const attempts = (user.failed_login_attempts || 0) + 1;
        const willLock = attempts >= MAX_LOGIN_ATTEMPTS;
        await pool.query('UPDATE users SET failed_login_attempts = ?, locked = ? WHERE id = ?', [
          attempts,
          willLock ? 1 : 0,
          user.id,
        ]);
        await auditService.log(req, {
          user: { id: user.id, email: user.email },
          action: willLock ? 'account_locked' : 'login_failed',
          target: user.email,
          detail: willLock
            ? `${MAX_LOGIN_ATTEMPTS} intentos fallidos seguidos`
            : `contraseña incorrecta (quedan ${MAX_LOGIN_ATTEMPTS - attempts} intento(s))`,
        });
        if (willLock) {
          req.flash('error', `Cuenta bloqueada tras ${MAX_LOGIN_ATTEMPTS} intentos fallidos. Pide a un administrador que la desbloquee en Usuarios.`);
          return res.redirect('/login');
        }
      } else {
        await auditService.log(req, { action: 'login_failed', target: email, detail: 'usuario no encontrado o inactivo' });
      }
      req.flash('error', 'Credenciales invalidas.');
      return res.redirect('/login');
    }

    if (user.failed_login_attempts) {
      await pool.query('UPDATE users SET failed_login_attempts = 0 WHERE id = ?', [user.id]);
    }

    // "Confiar en este navegador": si este equipo ya paso el 2FA antes
    // (cookie vigente), se completa el login de una vez sin pedir codigo.
    const trusted = await trustedDeviceService.isTrusted(req, user.id);
    if (trusted) {
      return completeLogin(req, res, user, { via: 'trusted_device' });
    }

    req.session.regenerate((err) => {
      if (err) {
        req.flash('error', 'Ocurrio un error al iniciar sesion.');
        return res.redirect('/login');
      }
      req.session.pendingUserId = user.id;
      res.redirect(user.otp_enabled ? '/2fa/verificar' : '/2fa/configurar');
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Ocurrio un error al iniciar sesion.');
    res.redirect('/login');
  }
});

router.post('/logout', verifyCsrfToken, (req, res) => {
  const user = req.session.user;
  req.session.destroy(() => {
    if (user) auditService.log(req, { user, action: 'logout' });
    res.redirect('/login');
  });
});

module.exports = router;
