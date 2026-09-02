const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const otpService = require('../services/otpService');
const settingsService = require('../services/settingsService');
const { verifyCsrfToken } = require('../middleware/csrf');

const router = express.Router();

// Limite de intentos de codigo OTP por IP: mitiga fuerza bruta sobre el 2FA.
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Demasiados intentos. Intenta de nuevo en unos minutos.',
});

// El login queda "a medias" (req.session.pendingUserId) hasta que se
// verifica el segundo factor - recien ahi se setea req.session.user.
function requirePending(req, res, next) {
  if (!req.session.pendingUserId) {
    return res.redirect('/login');
  }
  next();
}

async function loadPendingUser(req) {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ? AND active = 1 LIMIT 1', [
    req.session.pendingUserId,
  ]);
  return rows[0] || null;
}

function completeLogin(req, res, user) {
  const sessionUser = {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    role: user.role,
  };
  req.session.regenerate((err) => {
    if (err) {
      req.flash('error', 'Ocurrio un error al iniciar sesion.');
      return res.redirect('/login');
    }
    req.session.user = sessionUser;
    res.redirect('/');
  });
}

// --- Enrolamiento (primer login, todavia sin 2FA activo) ---------------

router.get('/configurar', requirePending, async (req, res, next) => {
  try {
    const user = await loadPendingUser(req);
    if (!user) return res.redirect('/login');
    if (user.otp_enabled) return res.redirect('/2fa/verificar');

    if (!req.session.pendingOtpSecret) {
      req.session.pendingOtpSecret = otpService.generateSecret();
    }
    const appName = (await settingsService.get('app_name')) || 'Gestion de Licencias';
    const otpauthUrl = otpService.keyUri(user.email, req.session.pendingOtpSecret, appName);
    const qrDataUrl = await otpService.qrDataUrl(otpauthUrl);

    res.render('twofa/configurar', {
      title: 'Configurar verificacion en dos pasos',
      qrDataUrl,
      secret: req.session.pendingOtpSecret,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/configurar', requirePending, otpLimiter, verifyCsrfToken, async (req, res, next) => {
  try {
    const user = await loadPendingUser(req);
    if (!user || !req.session.pendingOtpSecret) {
      return res.redirect('/2fa/configurar');
    }

    const valid = await otpService.verifyToken(req.session.pendingOtpSecret, req.body.code);
    if (!valid) {
      req.flash('error', 'El codigo ingresado no es valido. Intenta de nuevo.');
      return res.redirect('/2fa/configurar');
    }

    await pool.query(
      'UPDATE users SET otp_secret = ?, otp_enabled = 1, otp_confirmed_at = NOW() WHERE id = ?',
      [req.session.pendingOtpSecret, user.id]
    );
    delete req.session.pendingOtpSecret;
    req.flash('success', 'Verificacion en dos pasos activada correctamente.');
    completeLogin(req, res, user);
  } catch (err) {
    next(err);
  }
});

// --- Verificacion (2FA ya activo) ---------------------------------------

router.get('/verificar', requirePending, async (req, res, next) => {
  try {
    const user = await loadPendingUser(req);
    if (!user) return res.redirect('/login');
    if (!user.otp_enabled) return res.redirect('/2fa/configurar');
    res.render('twofa/verificar', { title: 'Verificacion en dos pasos' });
  } catch (err) {
    next(err);
  }
});

router.post('/verificar', requirePending, otpLimiter, verifyCsrfToken, async (req, res, next) => {
  try {
    const user = await loadPendingUser(req);
    if (!user) return res.redirect('/login');
    if (!user.otp_enabled) return res.redirect('/2fa/configurar');

    const valid = await otpService.verifyToken(user.otp_secret, req.body.code);
    if (!valid) {
      req.flash('error', 'El codigo ingresado no es valido. Intenta de nuevo.');
      return res.redirect('/2fa/verificar');
    }

    completeLogin(req, res, user);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
