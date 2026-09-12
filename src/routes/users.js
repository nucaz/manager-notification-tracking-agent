const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireAuth, isAdmin } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');

const router = express.Router();
router.use(requireAuth, isAdmin, verifyCsrfToken);

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, full_name, email, role, active, otp_enabled, created_at FROM users ORDER BY full_name'
    );
    res.render('users/list', { title: 'Usuarios', items: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/nuevo', (req, res) => {
  res.render('users/form', { title: 'Nuevo usuario', item: {} });
});

router.post('/nuevo', async (req, res, next) => {
  try {
    const { full_name, email, password, role, whatsapp_number } = req.body;
    if (!full_name || !email || !password) {
      req.flash('error', 'Nombre, correo y contraseña son obligatorios.');
      return res.redirect('/usuarios/nuevo');
    }
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      'INSERT INTO users (full_name, email, password_hash, role, whatsapp_number, active) VALUES (?, ?, ?, ?, ?, 1)',
      [full_name, email, hash, role || 'lector', whatsapp_number || null]
    );
    req.flash('success', 'Usuario creado correctamente.');
    res.redirect('/usuarios');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      const msg = /whatsapp_number/.test(err.sqlMessage || '')
        ? 'Ese número de WhatsApp ya está vinculado a otro usuario.'
        : 'Ya existe un usuario con ese correo.';
      req.flash('error', msg);
      return res.redirect('/usuarios/nuevo');
    }
    next(err);
  }
});

router.get('/:id/editar', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!rows[0]) {
      req.flash('error', 'Usuario no encontrado.');
      return res.redirect('/usuarios');
    }
    res.render('users/form', { title: 'Editar usuario', item: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/editar', async (req, res, next) => {
  try {
    const { full_name, email, password, role, active, whatsapp_number } = req.body;
    if (password) {
      const hash = await bcrypt.hash(password, 12);
      await pool.query(
        'UPDATE users SET full_name = ?, email = ?, password_hash = ?, role = ?, whatsapp_number = ?, active = ? WHERE id = ?',
        [full_name, email, hash, role, whatsapp_number || null, active ? 1 : 0, req.params.id]
      );
    } else {
      await pool.query(
        'UPDATE users SET full_name = ?, email = ?, role = ?, whatsapp_number = ?, active = ? WHERE id = ?',
        [full_name, email, role, whatsapp_number || null, active ? 1 : 0, req.params.id]
      );
    }
    req.flash('success', 'Usuario actualizado correctamente.');
    res.redirect('/usuarios');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      const msg = /whatsapp_number/.test(err.sqlMessage || '')
        ? 'Ese número de WhatsApp ya está vinculado a otro usuario.'
        : 'Ya existe otro usuario con ese correo.';
      req.flash('error', msg);
      return res.redirect(`/usuarios/${req.params.id}/editar`);
    }
    next(err);
  }
});

router.post('/:id/restablecer-2fa', async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE users SET otp_secret = NULL, otp_enabled = 0, otp_confirmed_at = NULL WHERE id = ?',
      [req.params.id]
    );
    req.flash('success', 'Se restableció el 2FA. El usuario deberá configurarlo de nuevo en su próximo inicio de sesión.');
    res.redirect('/usuarios');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/eliminar', async (req, res, next) => {
  try {
    if (parseInt(req.params.id, 10) === req.session.user.id) {
      req.flash('error', 'No puedes eliminar tu propio usuario.');
      return res.redirect('/usuarios');
    }
    await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    req.flash('success', 'Usuario eliminado.');
    res.redirect('/usuarios');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
