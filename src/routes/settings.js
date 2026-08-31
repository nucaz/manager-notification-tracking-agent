const express = require('express');
const { requireAuth, isAdmin } = require('../middleware/auth');
const settingsService = require('../services/settingsService');
const mailer = require('../services/mailer');
const geminiClient = require('../services/geminiClient');

const router = express.Router();
router.use(requireAuth);

router.get('/', isAdmin, async (req, res, next) => {
  try {
    const settings = await settingsService.getAll();
    res.render('settings/index', { title: 'Configuracion', settings });
  } catch (err) {
    next(err);
  }
});

router.post('/', isAdmin, async (req, res, next) => {
  try {
    const keys = [
      'app_name',
      'glpi_base_url', 'glpi_app_token', 'glpi_user_token',
      'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from',
      'reminder_thresholds_days', 'reminder_recipients', 'reminder_send_hour',
      'ai_provider', 'gemini_api_key', 'gemini_model',
    ];
    const pairs = {};
    for (const key of keys) {
      if (req.body[key] !== undefined) pairs[key] = req.body[key];
    }
    pairs.smtp_secure = req.body.smtp_secure ? 'true' : 'false';
    await settingsService.setMany(pairs);
    req.flash('success', 'Configuracion guardada correctamente.');
    res.redirect('/configuracion');
  } catch (err) {
    next(err);
  }
});

router.post('/probar-smtp', isAdmin, async (req, res) => {
  try {
    await mailer.verifyConnection();
    req.flash('success', 'Conexion SMTP verificada correctamente.');
  } catch (err) {
    req.flash('error', `No se pudo verificar el SMTP: ${err.message}`);
  }
  res.redirect('/configuracion');
});

router.post('/enviar-prueba', isAdmin, async (req, res) => {
  try {
    const to = req.body.test_email;
    if (!to) throw new Error('Indica un correo destino.');
    await mailer.sendMail({
      to,
      subject: 'Correo de prueba — Gestion de Licencias',
      html: '<p>Este es un correo de prueba enviado desde la aplicacion de Gestion de Licencias, Dominios y Contratos.</p>',
    });
    req.flash('success', `Correo de prueba enviado a ${to}.`);
  } catch (err) {
    req.flash('error', `No se pudo enviar el correo de prueba: ${err.message}`);
  }
  res.redirect('/configuracion');
});

router.post('/probar-gemini', isAdmin, async (req, res) => {
  try {
    await geminiClient.testConnection();
    req.flash('success', 'Conexión con Gemini exitosa. La API key funciona.');
  } catch (err) {
    req.flash('error', `No se pudo conectar con Gemini: ${err.message}`);
  }
  res.redirect('/configuracion');
});

module.exports = router;
