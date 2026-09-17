const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const auditService = require('../services/auditService');
const trustedDeviceService = require('../services/trustedDeviceService');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const trusted = await trustedDeviceService.listForUser(req.session.user.id);
    const [recentLogins] = await pool.query(
      `SELECT action, detail, ip_address, created_at FROM audit_log
       WHERE user_id = ? AND action IN ('login', 'login_failed', 'login_2fa_failed', 'login_blocked', 'logout')
       ORDER BY created_at DESC LIMIT 10`,
      [req.session.user.id]
    );
    res.render('account/index', { title: 'Mi cuenta', trusted, recentLogins });
  } catch (err) {
    next(err);
  }
});

router.post('/password', verifyCsrfToken, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    const [[user]] = await pool.query('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    const ok = await bcrypt.compare(current_password || '', user.password_hash);
    if (!ok) {
      req.flash('error', 'Tu contraseña actual no es correcta — no se cambió nada.');
      return res.redirect('/mi-cuenta');
    }
    if (!new_password || new_password.length < 8) {
      req.flash('error', 'La contraseña nueva debe tener al menos 8 caracteres.');
      return res.redirect('/mi-cuenta');
    }
    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id]);
    await auditService.log(req, { user: req.session.user, action: 'account_change_password' });
    req.flash('success', 'Contraseña actualizada correctamente.');
    res.redirect('/mi-cuenta');
  } catch (err) {
    next(err);
  }
});

router.post('/dispositivos/:id/revocar', verifyCsrfToken, async (req, res, next) => {
  try {
    await trustedDeviceService.revoke(req.session.user.id, req.params.id);
    req.flash('success', 'Dispositivo revocado — la próxima vez te pedirá el código otra vez ahí.');
    res.redirect('/mi-cuenta');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
