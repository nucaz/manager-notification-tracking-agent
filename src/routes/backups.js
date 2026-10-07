// Configuracion > Respaldos: respaldo completo de la aplicacion (base,
// archivos y secretos cifrados), su programacion nocturna (la ejecuta
// DevOps Sidecar y lo envia a sus destinos externos) y la restauracion.
// Solo administradores.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const express = require('express');
const multer = require('multer');
const { requireAuth, isSuperAdmin } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const settingsService = require('../services/settingsService');
const fullBackupService = require('../services/fullBackupService');
const devopsSidecarClient = require('../services/devopsSidecarClient');
const auditService = require('../services/auditService');
const ssoService = require('../services/ssoService');

const CONFIRMATION = 'RESTAURAR TODO';
const router = express.Router();
router.use(requireAuth, isSuperAdmin);

const archiveUploader = multer({
  storage: multer.diskStorage({ destination: os.tmpdir(), filename: (req, file, cb) => cb(null, `restaurar-${Date.now()}-${process.pid}.tar.gz`) }),
  limits: { fileSize: 5 * 1024 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!/\.(tar\.gz|tgz)$/i.test(file.originalname)) return cb(new Error('Suba el respaldo completo (.tar.gz) que genera esta aplicación.'));
    cb(null, true);
  },
});

// Trabajos del sidecar que respaldan la aplicacion (para mostrar el estado aqui).
async function scheduledJobs() {
  try {
    const jobs = await devopsSidecarClient.backupJobs();
    return { jobs: jobs.filter((j) => j.include_main_app), error: null };
  } catch (err) {
    return { jobs: [], error: err.message };
  }
}

router.get('/', async (req, res, next) => {
  try {
    const settings = await settingsService.getAll();
    const sched = await scheduledJobs();
    res.render('settings/backups', {
      title: 'Respaldos',
      hasPassword: !!settings.backup_recovery_password,
      passwordSetAt: settings.backup_recovery_password_set_at || null,
      jobs: sched.jobs, sidecarError: sched.error, sso: ssoService.enabled(),
      sidecarJobsUrl: '/devops?ir=/backups/trabajos', sidecarRestoreUrl: '/devops?ir=/backups/restaurar',
      confirmation: CONFIRMATION,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/contrasena', verifyCsrfToken, async (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 12) {
    req.flash('error', 'La contraseña de recuperación debe tener al menos 12 caracteres.');
  } else if (pw !== String(req.body.password2 || '')) {
    req.flash('error', 'Las dos contraseñas no coinciden.');
  } else {
    await settingsService.setMany({ backup_recovery_password: pw, backup_recovery_password_set_at: new Date().toISOString().slice(0, 16).replace('T', ' ') });
    await auditService.log(req, { user: req.session.user, action: 'backup_recovery_password_set' });
    req.flash('success', 'Contraseña de recuperación guardada. Anótela fuera de este servidor: sin ella no se pueden abrir los secretos de un respaldo.');
  }
  res.redirect('/configuracion/respaldos');
});

router.get('/descargar', async (req, res) => {
  let result = null;
  try {
    result = await fullBackupService.buildArchive();
    await auditService.log(req, { user: req.session.user, action: 'backup_full_download', target: result.name });
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${result.name}"`);
    res.setHeader('Content-Length', String(result.size));
    await pipeline(fs.createReadStream(result.file), res);
  } catch (err) {
    if (!res.headersSent) {
      req.flash('error', `No se pudo generar el respaldo: ${err.message}`);
      res.redirect('/configuracion/respaldos');
    }
  } finally {
    if (result) result.cleanup();
  }
});

function handleUpload(req, res, next) {
  archiveUploader.single('file')(req, res, (err) => {
    if (err) {
      req.flash('error', `No se pudo subir el archivo: ${err.message}`);
      return res.redirect('/configuracion/respaldos');
    }
    next();
  });
}

router.post('/restaurar', handleUpload, verifyCsrfToken, async (req, res) => {
  const file = req.file && req.file.path;
  try {
    if (req.body.confirmacion !== CONFIRMATION) throw new Error(`Escriba exactamente "${CONFIRMATION}" para confirmar.`);
    if (!file) throw new Error('Elija el archivo .tar.gz del respaldo.');
    const user = req.session.user;
    const r = await fullBackupService.restoreArchive(file);
    await auditService.log(req, { user, action: 'backup_full_restored', target: req.file.originalname,
      detail: `respaldo del ${r.manifest.creado}; ${r.files} archivo(s); copia previa: ${r.snapshotFile}; migraciones aplicadas: ${r.migrationsApplied}` });
    req.flash('success', `Restaurado el respaldo del ${r.manifest.creado.slice(0, 16).replace('T', ' ')} (base y ${r.files} archivo(s)). `
      + `Por si acaso, la base de antes quedó en uploads/pre_restore_backups/${r.snapshotFile}.${r.warnings.length ? ` Avisos: ${r.warnings.join(' ')}` : ''}`);
  } catch (err) {
    req.flash('error', `No se restauró nada: ${err.message}`);
  } finally {
    if (file) fs.rm(file, { force: true }, () => {});
  }
  res.redirect('/configuracion/respaldos');
});

module.exports = router;
module.exports.CONFIRMATION = CONFIRMATION;
