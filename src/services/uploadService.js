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

// Para importacion masiva (CSV/Excel): el archivo solo se parsea en
// memoria, nunca se guarda en disco. Solo .xlsx (no el formato binario
// .xls antiguo, que la libreria de parseo no soporta).
const IMPORT_ALLOWED_EXT = new Set(['.csv', '.xlsx']);

const importUploader = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!IMPORT_ALLOWED_EXT.has(ext)) {
      return cb(new Error(`Tipo de archivo no permitido para importar: ${ext}`));
    }
    cb(null, true);
  },
  limits: { fileSize: env.uploadMaxMb * 1024 * 1024 },
});

// Para restaurar un backup de base de datos desde Configuracion: solo
// .sql, en memoria (se pasa directo a mariadb-dump por stdin, nunca se
// guarda en disco). Limite generoso (no ligado a UPLOAD_MAX_MB, que esta
// pensado para adjuntos normales) porque un dump completo puede pesar
// bastante mas que una factura o un diagrama.
const sqlRestoreUploader = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.sql') {
      return cb(new Error('Solo se acepta un archivo .sql (el backup.sql que trae el respaldo descargado).'));
    }
    cb(null, true);
  },
  limits: { fileSize: 500 * 1024 * 1024 },
});

module.exports = { uploader, importUploader, sqlRestoreUploader, DIRS, UPLOAD_ROOT };
