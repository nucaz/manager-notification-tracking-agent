const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { verifyCsrfToken } = require('../middleware/csrf');

const router = express.Router();

// Limite de intentos de login por IP: mitiga fuerza bruta sobre la contraseña.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Demasiados intentos de inicio de sesion. Intenta de nuevo en unos minutos.',
});

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
    if (!user) {
      req.flash('error', 'Credenciales invalidas.');
      return res.redirect('/login');
    }
    const ok = await bcrypt.compare(password || '', user.password_hash);
    if (!ok) {
      req.flash('error', 'Credenciales invalidas.');
      return res.redirect('/login');
    }

    // Login en dos pasos: recien se completa (req.session.user) despues de
    // verificar el segundo factor en /2fa/verificar o /2fa/configurar.
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
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
