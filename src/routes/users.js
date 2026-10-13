const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireAuth, isSuperAdmin, ROLES } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const auditService = require('../services/auditService');
const modules = require('../middleware/modules');

const router = express.Router();
router.use(requireAuth, isSuperAdmin, verifyCsrfToken);

function duplicateFieldMessage(err) {
  const msg = err.sqlMessage || '';
  if (/whatsapp_number/.test(msg)) return 'Ese número de WhatsApp ya está vinculado a otro usuario.';
  if (/telegram_chat_id/.test(msg)) return 'Ese ID de chat de Telegram ya está vinculado a otro usuario.';
  return 'Ya existe un usuario con ese correo.';
}

// Permisos especiales del usuario por modulo (mandan sobre su perfil). El
// formulario envia um_<modulo> = '' (segun su perfil) | none | view | edit.
async function moduleRows(userId, role) {
  const overrides = userId ? await modules.userOverrides(userId) : {};
  const out = [];
  for (const [key, label] of Object.entries(modules.MODULES)) {
    const enabled = role === 'superadmin' ? true : await modules.moduleEnabled(role || 'lector', key);
    out.push({ key, label, override: overrides[key] || '', byRole: !enabled ? 'none' : (role === 'lector' || !role) ? 'view' : 'edit' });
  }
  return out;
}
async function saveOverrides(userId, role, body) {
  await pool.query('DELETE FROM user_modules WHERE user_id = ?', [userId]);
  if (role === 'superadmin') return []; // el superadministrador siempre tiene todo
  const rows = Object.keys(modules.MODULES).map((k) => [userId, k, String(body[`um_${k}`] || '')]).filter((r) => modules.ACCESS[r[2]]);
  if (rows.length) await pool.query('INSERT INTO user_modules (user_id, module, access) VALUES ?', [rows]);
  return rows.map((r) => `${r[1]}=${r[2]}`);
}

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, full_name, email, role, active, otp_enabled, locked, created_at, (SELECT COUNT(*) FROM user_modules m WHERE m.user_id = users.id) AS special FROM users ORDER BY full_name'
    );
    res.render('users/list', { title: 'Usuarios', items: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/nuevo', async (req, res) => {
  res.render('users/form', { title: 'Nuevo usuario', item: {}, moduleRows: null, ACCESS: modules.ACCESS, others: [], ROLES });
});

router.post('/nuevo', async (req, res, next) => {
  try {
    const { full_name, email, password, role, whatsapp_number, telegram_chat_id } = req.body;
    if (!full_name || !email || !password) {
      req.flash('error', 'Nombre, correo y contraseña son obligatorios.');
      return res.redirect('/usuarios/nuevo');
    }
    if (!ROLES[role || 'lector']) {
      req.flash('error', 'Rol no válido.');
      return res.redirect('/usuarios/nuevo');
    }
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      'INSERT INTO users (full_name, email, password_hash, role, whatsapp_number, telegram_chat_id, active) VALUES (?, ?, ?, ?, ?, ?, 1)',
      [full_name, email, hash, role || 'lector', whatsapp_number || null, telegram_chat_id || null]
    );
    await auditService.log(req, { user: req.session.user, action: 'user_create', target: email, detail: `rol: ${role || 'lector'}` });
    req.flash('success', 'Usuario creado correctamente.');
    res.redirect('/usuarios');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', duplicateFieldMessage(err));
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
    // A quien se le pueden copiar sus permisos especiales: los demas usuarios que no son superadministradores.
    const [others] = await pool.query(`SELECT u.id, u.full_name, u.role, u.active, (SELECT COUNT(*) FROM user_modules m WHERE m.user_id = u.id) AS special
      FROM users u WHERE u.id <> ? AND u.role <> 'superadmin' ORDER BY u.full_name`, [rows[0].id]);
    res.render('users/form', { title: 'Editar usuario', item: rows[0], moduleRows: await moduleRows(rows[0].id, rows[0].role), ACCESS: modules.ACCESS, others, ROLES });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/editar', async (req, res, next) => {
  try {
    const { full_name, email, password, role, active, whatsapp_number, telegram_chat_id } = req.body;
    if (!ROLES[role]) {
      req.flash('error', 'Rol no válido.');
      return res.redirect(`/usuarios/${req.params.id}/editar`);
    }
    // Siempre debe quedar al menos un superadministrador activo.
    const [[before]] = await pool.query('SELECT role, active FROM users WHERE id = ?', [req.params.id]);
    if (before && before.role === 'superadmin' && before.active && (role !== 'superadmin' || !active)) {
      const [[others]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin' AND active = 1 AND id <> ?", [req.params.id]);
      if (!Number(others.n)) {
        req.flash('error', 'Es el único superadministrador activo: nombre a otro superadministrador antes de cambiarle el rol o desactivarlo.');
        return res.redirect(`/usuarios/${req.params.id}/editar`);
      }
    }
    if (password) {
      const hash = await bcrypt.hash(password, 12);
      await pool.query(
        'UPDATE users SET full_name = ?, email = ?, password_hash = ?, role = ?, whatsapp_number = ?, telegram_chat_id = ?, active = ? WHERE id = ?',
        [full_name, email, hash, role, whatsapp_number || null, telegram_chat_id || null, active ? 1 : 0, req.params.id]
      );
    } else {
      await pool.query(
        'UPDATE users SET full_name = ?, email = ?, role = ?, whatsapp_number = ?, telegram_chat_id = ?, active = ? WHERE id = ?',
        [full_name, email, role, whatsapp_number || null, telegram_chat_id || null, active ? 1 : 0, req.params.id]
      );
    }
    const special = await saveOverrides(Number(req.params.id), role, req.body);
    await auditService.log(req, {
      user: req.session.user,
      action: 'user_update',
      target: email,
      detail: `${password ? `rol: ${role}, contraseña cambiada` : `rol: ${role}`}${special.length ? `; permisos especiales: ${special.join(', ')}` : '; sin permisos especiales'}`.slice(0, 1000),
    });
    req.flash('success', 'Usuario actualizado correctamente.');
    res.redirect('/usuarios');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', duplicateFieldMessage(err));
      return res.redirect(`/usuarios/${req.params.id}/editar`);
    }
    next(err);
  }
});

// Copia los permisos especiales de un usuario a otros: cada destino queda con
// EXACTAMENTE los mismos (se reemplazan los que tuviera). Nunca a un superadministrador.
router.post('/:id/copiar-permisos', async (req, res, next) => {
  const back = `/usuarios/${req.params.id}/editar#permisos_especiales`;
  try {
    const [[source]] = await pool.query('SELECT id, email, full_name, role FROM users WHERE id = ?', [req.params.id]);
    if (!source) {
      req.flash('error', 'Usuario no encontrado.');
      return res.redirect('/usuarios');
    }
    const [rows] = await pool.query('SELECT module, access FROM user_modules WHERE user_id = ?', [source.id]);
    const perms = rows.filter((r) => modules.MODULES[r.module] && modules.ACCESS[r.access]);
    if (source.role === 'superadmin' || !perms.length) {
      req.flash('error', 'Este usuario no tiene permisos especiales que copiar. Guárdelos primero.');
      return res.redirect(back);
    }
    const ids = [...new Set([].concat(req.body.destino || []).map(Number).filter((n) => n > 0 && n !== source.id))];
    const [targets] = ids.length ? await pool.query("SELECT id, email, full_name FROM users WHERE id IN (?) AND role <> 'superadmin'", [ids]) : [[]];
    if (!targets.length) {
      req.flash('error', 'Marque al menos un usuario al que copiar los permisos.');
      return res.redirect(back);
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const t of targets) {
        await conn.query('DELETE FROM user_modules WHERE user_id = ?', [t.id]);
        await conn.query('INSERT INTO user_modules (user_id, module, access) VALUES ?', [perms.map((p) => [t.id, p.module, p.access])]);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    const detail = perms.map((p) => `${p.module}=${p.access}`).join(', ');
    for (const t of targets) {
      await auditService.log(req, { user: req.session.user, action: 'user_permissions_copy', target: t.email, detail: `copiados de ${source.email}: ${detail}`.slice(0, 1000) });
    }
    req.flash('success', `Permisos especiales de ${source.full_name} copiados a: ${targets.map((t) => t.full_name).join(', ')}.`);
    return res.redirect(back);
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/restablecer-2fa', async (req, res, next) => {
  try {
    const [[target]] = await pool.query('SELECT email FROM users WHERE id = ?', [req.params.id]);
    await pool.query(
      'UPDATE users SET otp_secret = NULL, otp_enabled = 0, otp_confirmed_at = NULL WHERE id = ?',
      [req.params.id]
    );
    await auditService.log(req, { user: req.session.user, action: 'user_reset_2fa', target: target && target.email });
    req.flash('success', 'Se restableció el 2FA. El usuario deberá configurarlo de nuevo en su próximo inicio de sesión.');
    res.redirect('/usuarios');
  } catch (err) {
    next(err);
  }
});

// Destraba una cuenta bloqueada por MAX_LOGIN_ATTEMPTS intentos fallidos
// seguidos (ver src/routes/auth.js) - unica forma de volver a entrar para
// esa cuenta, a proposito.
router.post('/:id/desbloquear', async (req, res, next) => {
  try {
    const [[target]] = await pool.query('SELECT email FROM users WHERE id = ?', [req.params.id]);
    await pool.query('UPDATE users SET locked = 0, failed_login_attempts = 0 WHERE id = ?', [req.params.id]);
    await auditService.log(req, { user: req.session.user, action: 'user_unlock', target: target && target.email });
    req.flash('success', 'Cuenta desbloqueada.');
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
    const [[target]] = await pool.query('SELECT email FROM users WHERE id = ?', [req.params.id]);
    await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    await auditService.log(req, { user: req.session.user, action: 'user_delete', target: target && target.email });
    req.flash('success', 'Usuario eliminado.');
    res.redirect('/usuarios');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
