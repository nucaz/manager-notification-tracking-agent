const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const env = require('../config/env');

const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads');
const DIRS = {
  adjuntos: path.join(UPLOAD_ROOT, 'adjuntos'),
  red: path.join(UPLOAD_ROOT, 'red'),
};

for (const dir of Object.values(DIRS)) {
  fs.mkdirSync(dir, { recursive: true });
}

// Extensiones permitidas: documentos, hojas de calculo, imagenes y PDF de
// contratos/adendas/facturas/diagramas. Se valida por extension y mimetype.
const ALLOWED_EXT = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg',
  '.webp', '.svg', '.vsdx', '.drawio', '.zip',
]);

function storageFor(kind) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, DIRS[kind]),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const unique = crypto.randomBytes(16).toString('hex');
      cb(null, `${Date.now()}_${unique}${ext}`);
    },
  });
}

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return cb(new Error(`Tipo de archivo no permitido: ${ext}`));
  }
  cb(null, true);
}

function uploader(kind) {
  return multer({
    storage: storageFor(kind),
    fileFilter,
    limits: { fileSize: env.uploadMaxMb * 1024 * 1024 },
  });
}

module.exports = { uploader, DIRS, UPLOAD_ROOT };
