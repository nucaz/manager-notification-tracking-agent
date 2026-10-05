// Respaldo completo de la aplicacion para DevOps Sidecar: el sidecar lo
// pide cada noche (trabajo de respaldo con "Aplicacion completa"), lo
// guarda en sus cadenas y lo envia a sus destinos externos; y en una
// recuperacion lo devuelve para restaurarlo aqui.
//
// Red interna de Docker, pase firmado con SSO_SHARED_SECRET (aud
// "app-backup", ver ssoService.verify). Sin sesion ni CSRF.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const express = require('express');
const ssoService = require('../services/ssoService');
const fullBackupService = require('../services/fullBackupService');
const auditService = require('../services/auditService');

const CONFIRMATION = 'RESTAURAR TODO';
const MAX_RESTORE_BYTES = 5 * 1024 * 1024 * 1024;
let busy = false;

const router = express.Router();

router.use((req, res, next) => {
  const header = String(req.headers.authorization || '');
  const pass = header.startsWith('Bearer ') ? ssoService.verify(header.slice(7).trim(), 'app-backup') : null;
  if (!pass) return res.status(401).json({ ok: false, error: 'Pase no válido o vencido.' });
  next();
});

// Genera y entrega el .tar.gz. Cuerpo: { sidecar_env: {...} } (opcional).
router.post('/generar', express.json({ limit: '256kb' }), async (req, res) => {
  if (busy) return res.status(409).json({ ok: false, error: 'Hay otro respaldo o restauración en curso.' });
  busy = true;
  let result = null;
  try {
    const sidecarEnv = req.body && req.body.sidecar_env && typeof req.body.sidecar_env === 'object' ? req.body.sidecar_env : null;
    result = await fullBackupService.buildArchive({ sidecarEnv });
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Length', String(result.size));
    res.setHeader('X-Respaldo-Nombre', result.name);
    res.setHeader('X-Respaldo-Sha256', result.sha256);
    res.setHeader('X-Respaldo-Secretos', result.manifest.secretos.incluidos ? 'si' : 'no');
    await pipeline(fs.createReadStream(result.file), res);
    await auditService.log(null, { action: 'backup_full_created', target: result.name,
      detail: `por DevOps Sidecar; ${(result.size / 1048576).toFixed(1)} MB; secretos ${result.manifest.secretos.incluidos ? 'incluidos' : 'no incluidos'}` });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
    else res.destroy(err);
  } finally {
    if (result) result.cleanup();
    busy = false;
  }
});

// Restaura un .tar.gz enviado en el cuerpo. Exige la frase de confirmacion.
router.post('/restaurar', async (req, res) => {
  if (req.headers['x-confirmacion'] !== CONFIRMATION) {
    return res.status(400).json({ ok: false, error: `Falta la confirmación "${CONFIRMATION}".` });
  }
  if (Number(req.headers['content-length'] || 0) > MAX_RESTORE_BYTES) return res.status(413).json({ ok: false, error: 'Archivo demasiado grande.' });
  if (busy) return res.status(409).json({ ok: false, error: 'Hay otro respaldo o restauración en curso.' });
  busy = true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subida-'));
  const file = path.join(dir, 'respaldo.tar.gz');
  try {
    await pipeline(req, fs.createWriteStream(file));
    const r = await fullBackupService.restoreArchive(file);
    await auditService.log(null, { action: 'backup_full_restored', target: `respaldo del ${r.manifest.creado}`,
      detail: `desde DevOps Sidecar; ${r.files} archivo(s); copia previa: ${r.snapshotFile}; migraciones aplicadas: ${r.migrationsApplied}` });
    res.json({ ok: true, creado: r.manifest.creado, archivos: r.files, copia_previa: r.snapshotFile, migraciones: r.migrationsApplied, avisos: r.warnings,
      cantidades: r.manifest.cantidades });
  } catch (err) {
    res.status(422).json({ ok: false, error: err.message });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    busy = false;
  }
});

module.exports = router;
module.exports.CONFIRMATION = CONFIRMATION;
