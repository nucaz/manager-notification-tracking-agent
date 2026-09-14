const express = require('express');
const { requireAuth, isAdmin } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const settingsService = require('../services/settingsService');
const mailer = require('../services/mailer');
const geminiClient = require('../services/geminiClient');
const whatsappClient = require('../services/whatsappClient');
const telegramClient = require('../services/telegramClient');
const backupService = require('../services/backupService');
const { sqlRestoreUploader } = require('../services/uploadService');

// Frase exacta que el admin debe escribir para confirmar una restauracion
// (ademas de estar logueado como admin y del token CSRF): una tercera
// barrera deliberada contra un clic accidental en una accion destructiva
// que sobrescribe toda la base de datos.
const RESTORE_CONFIRMATION_PHRASE = 'RESTAURAR TODO';

const router = express.Router();
// verifyCsrfToken NO va aca a nivel de router: /respaldo/restaurar es
// multipart y necesita que multer parsee el body antes de verificar el
// token (ver src/routes/attachments.js). Se aplica explicito en cada
// ruta POST.
router.use(requireAuth);

router.get('/', isAdmin, async (req, res, next) => {
  try {
    const settings = await settingsService.getAll();
    res.render('settings/index', { title: 'Configuracion', settings });
  } catch (err) {
    next(err);
  }
});

router.post('/', isAdmin, verifyCsrfToken, async (req, res, next) => {
  try {
    const keys = [
      'app_name',
      'glpi_base_url', 'glpi_app_token', 'glpi_user_token',
      'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from',
      'reminder_thresholds_days', 'reminder_recipients', 'reminder_send_hour',
      'ai_provider', 'gemini_api_key', 'gemini_model',
      'whatsapp_phone_number_id', 'whatsapp_access_token', 'whatsapp_verify_token', 'whatsapp_app_secret',
      'telegram_bot_token',
    ];
    const pairs = {};
    for (const key of keys) {
      if (req.body[key] !== undefined) pairs[key] = req.body[key];
    }
    pairs.smtp_secure = req.body.smtp_secure ? 'true' : 'false';
    pairs.telegram_polling_enabled = req.body.telegram_polling_enabled ? 'true' : 'false';
    await settingsService.setMany(pairs);
    req.flash('success', 'Configuracion guardada correctamente.');
    res.redirect('/configuracion');
  } catch (err) {
    next(err);
  }
});

router.post('/probar-smtp', isAdmin, verifyCsrfToken, async (req, res) => {
  try {
    await mailer.verifyConnection();
    req.flash('success', 'Conexion SMTP verificada correctamente.');
  } catch (err) {
    req.flash('error', `No se pudo verificar el SMTP: ${err.message}`);
  }
  res.redirect('/configuracion');
});

router.post('/enviar-prueba', isAdmin, verifyCsrfToken, async (req, res) => {
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

router.post('/probar-gemini', isAdmin, verifyCsrfToken, async (req, res) => {
  try {
    await geminiClient.testConnection();
    req.flash('success', 'Conexión con Gemini exitosa. La API key funciona.');
  } catch (err) {
    req.flash('error', `No se pudo conectar con Gemini: ${err.message}`);
  }
  res.redirect('/configuracion');
});

router.post('/probar-whatsapp', isAdmin, verifyCsrfToken, async (req, res) => {
  try {
    const info = await whatsappClient.testConnection();
    req.flash('success', `Conexión con WhatsApp exitosa (${info.verified_name || info.display_phone_number || 'OK'}).`);
  } catch (err) {
    req.flash('error', `No se pudo conectar con WhatsApp: ${err.message}`);
  }
  res.redirect('/configuracion');
});

router.post('/probar-telegram', isAdmin, verifyCsrfToken, async (req, res) => {
  try {
    const info = await telegramClient.testConnection();
    req.flash('success', `Conexión con Telegram exitosa (bot @${info.username}).`);
  } catch (err) {
    req.flash('error', `No se pudo conectar con Telegram: ${err.message}`);
  }
  res.redirect('/configuracion');
});

// Descarga un .zip con el dump completo de la BD (backup.sql) + los
// archivos de uploads/. Es GET (no modifica nada) y por eso no lleva
// verifyCsrfToken - mismo criterio que /celulares/importar/plantilla.
router.get('/respaldo/descargar', isAdmin, async (req, res, next) => {
  try {
    const fecha = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '');
    await backupService.streamBackupZip(res, `respaldo_licencias_${fecha}.zip`);
  } catch (err) {
    next(err);
  }
});

// multer llama a next(err) cuando el fileFilter rechaza el archivo (ej.
// extension distinta a .sql) o se excede el limite de tamano; sin este
// wrapper, ese error cae al manejador generico de errores de Express
// (pagina de error, sin flash) en vez de volver a Configuracion con un
// mensaje claro.
function handleSqlUpload(req, res, next) {
  sqlRestoreUploader.single('file')(req, res, (err) => {
    if (err) {
      req.flash('error', `No se pudo subir el archivo: ${err.message}`);
      return res.redirect('/configuracion');
    }
    next();
  });
}

// Restaura la base de datos desde un backup.sql subido. Accion
// DESTRUCTIVA (sobrescribe todas las tablas actuales) - por eso, ademas
// de isAdmin + CSRF, exige escribir una frase de confirmacion exacta.
router.post(
  '/respaldo/restaurar',
  isAdmin,
  handleSqlUpload,
  verifyCsrfToken,
  async (req, res, next) => {
    try {
      if (req.body.confirmacion !== RESTORE_CONFIRMATION_PHRASE) {
        req.flash('error', `Debes escribir exactamente "${RESTORE_CONFIRMATION_PHRASE}" para confirmar la restauración.`);
        return res.redirect('/configuracion');
      }
      if (!req.file) {
        req.flash('error', 'Debes seleccionar el archivo .sql a restaurar.');
        return res.redirect('/configuracion');
      }
      console.warn(
        `[backup] Restauración de base de datos iniciada por ${req.session.user.email} (usuario id ${req.session.user.id}), archivo "${req.file.originalname}" (${req.file.size} bytes).`
      );
      await backupService.restoreFromSqlBuffer(req.file.buffer);
      req.flash('success', 'Base de datos restaurada correctamente.');
    } catch (err) {
      req.flash('error', `No se pudo restaurar la base de datos: ${err.message}`);
    }
    res.redirect('/configuracion');
  }
);

module.exports = router;
