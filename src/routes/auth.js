const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { title: 'Iniciar sesion' });
});

router.post('/login', async (req, res) => {
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
    req.session.user = {
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
      req.session.user = {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
      };
      res.redirect('/');
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Ocurrio un error al iniciar sesion.');
    res.redirect('/login');
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
