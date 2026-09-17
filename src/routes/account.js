const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const auditService = require('../services/auditService');
const trustedDeviceService = require('../services/trustedDeviceService');
const backupCodesService = require('../services/backupCodesService');
const otpService = require('../services/otpService');
const settingsService = require('../services/settingsService');

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
    const backupCodesRemaining = await backupCodesService.remainingCount(req.session.user.id);
    res.render('account/index', { title: 'Mi cuenta', trusted, recentLogins, backupCodesRemaining });
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

// Regenerar códigos de respaldo: invalida los anteriores (si quedaba
// alguno) y muestra los nuevos una sola vez, vía la misma pantalla que
// usa el enrolamiento inicial (session.newBackupCodes).
router.post('/2fa/regenerar-codigos', verifyCsrfToken, async (req, res, next) => {
  try {
    const codes = await backupCodesService.replaceCodesForUser(req.session.user.id);
    await auditService.log(req, { user: req.session.user, action: 'backup_codes_regenerated' });
    req.session.newBackupCodes = { codes, nextUrl: '/mi-cuenta' };
    res.redirect('/2fa/codigos-respaldo');
  } catch (err) {
    next(err);
  }
});

// Reconfigurar 2FA en caliente (usuario ya logueado, con o sin acceso a
// su app autenticadora anterior): genera un secreto nuevo y pide
// confirmarlo con un código antes de reemplazar el que ya tenía activo.
router.get('/2fa/reconfigurar', async (req, res, next) => {
  try {
    if (!req.session.pending2faReconfigureSecret) {
      req.session.pending2faReconfigureSecret = otpService.generateSecret();
    }
    const appName = (await settingsService.get('app_name')) || 'Gestion de Licencias';
    const otpauthUrl = otpService.keyUri(req.session.user.email, req.session.pending2faReconfigureSecret, appName);
    const qrDataUrl = await otpService.qrDataUrl(otpauthUrl);
    res.render('account/reconfigure2fa', {
      title: 'Reconfigurar verificación en dos pasos',
      qrDataUrl,
      secret: req.session.pending2faReconfigureSecret,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/2fa/reconfigurar', verifyCsrfToken, async (req, res, next) => {
  try {
    const secret = req.session.pending2faReconfigureSecret;
    if (!secret) return res.redirect('/mi-cuenta/2fa/reconfigurar');

    const valid = await otpService.verifyToken(secret, req.body.code);
    if (!valid) {
      req.flash('error', 'El código ingresado no es válido. Intenta de nuevo.');
      return res.redirect('/mi-cuenta/2fa/reconfigurar');
    }

    await pool.query('UPDATE users SET otp_secret = ?, otp_confirmed_at = NOW() WHERE id = ?', [secret, req.session.user.id]);
    delete req.session.pending2faReconfigureSecret;
    await auditService.log(req, { user: req.session.user, action: 'account_2fa_reconfigure' });
    req.flash('success', 'Tu verificación en dos pasos quedó reconfigurada con el nuevo código.');
    res.redirect('/mi-cuenta');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
