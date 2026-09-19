require('dotenv').config();

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  sessionSecret: process.env.SESSION_SECRET || 'insecure_default_change_me',
  // Clave hex de 32 bytes para cifrar en BD las credenciales guardadas
  // desde Configuracion (ver src/services/cryptoService.js). Vacio =
  // esas credenciales quedan en texto plano (compatibilidad hacia atras).
  credentialsEncKey: process.env.CREDENTIALS_ENC_KEY || '',

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    database: process.env.DB_NAME || 'licencias_app',
    user: process.env.DB_USER || 'licencias',
    password: process.env.DB_PASSWORD || '',
  },

  admin: {
    name: process.env.ADMIN_NAME || 'Administrador',
    email: process.env.ADMIN_EMAIL || 'admin@example.com',
    password: process.env.ADMIN_PASSWORD || 'change_me_now',
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'no-reply@example.com',
  },

  glpi: {
    baseUrl: process.env.GLPI_BASE_URL || '',
    appToken: process.env.GLPI_APP_TOKEN || '',
    userToken: process.env.GLPI_USER_TOKEN || '',
  },

  uploadMaxMb: parseInt(process.env.UPLOAD_MAX_MB || '25', 10),
};
