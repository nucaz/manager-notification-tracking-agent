const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireAuth, isAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, isAdmin);

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, full_name, email, role, active, created_at FROM users ORDER BY full_name'
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
    const { full_name, email, password, role } = req.body;
    if (!full_name || !email || !password) {
      req.flash('error', 'Nombre, correo y contraseña son obligatorios.');
      return res.redirect('/usuarios/nuevo');
    }
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      'INSERT INTO users (full_name, email, password_hash, role, active) VALUES (?, ?, ?, ?, 1)',
      [full_name, email, hash, role || 'lector']
    );
    req.flash('success', 'Usuario creado correctamente.');
    res.redirect('/usuarios');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'Ya existe un usuario con ese correo.');
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
    const { full_name, email, password, role, active } = req.body;
    if (password) {
      const hash = await bcrypt.hash(password, 12);
      await pool.query(
        'UPDATE users SET full_name = ?, email = ?, password_hash = ?, role = ?, active = ? WHERE id = ?',
        [full_name, email, hash, role, active ? 1 : 0, req.params.id]
      );
    } else {
      await pool.query(
        'UPDATE users SET full_name = ?, email = ?, role = ?, active = ? WHERE id = ?',
        [full_name, email, role, active ? 1 : 0, req.params.id]
      );
    }
    req.flash('success', 'Usuario actualizado correctamente.');
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
