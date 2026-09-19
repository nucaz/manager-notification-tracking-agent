// Configuracion editable desde la UI, respaldada en la tabla `settings`.
// Los valores de .env se usan como respaldo inicial si la tabla esta vacia.
const pool = require('../db/pool');
const env = require('../config/env');
const cryptoService = require('./cryptoService');
const { SECRET_KEYS } = require('../config/secretKeys');

const DEFAULTS = {
  reminder_thresholds_days: '90,60,30,15,7,1',
  reminder_recipients: '',
  reminder_send_hour: '8',
  glpi_base_url: env.glpi.baseUrl,
  glpi_app_token: env.glpi.appToken,
  glpi_user_token: env.glpi.userToken,
  smtp_host: env.smtp.host,
  smtp_port: String(env.smtp.port),
  smtp_secure: String(env.smtp.secure),
  smtp_user: env.smtp.user,
  smtp_pass: env.smtp.pass,
  smtp_from: env.smtp.from,
  app_name: 'Gestion de Licencias, Dominios y Contratos',
  ai_provider: 'gemini',
  gemini_api_key: '',
  gemini_model: 'gemini-2.5-flash',
  whatsapp_phone_number_id: '',
  whatsapp_access_token: '',
  whatsapp_verify_token: '',
  whatsapp_app_secret: '',
  telegram_bot_token: '',
  telegram_polling_enabled: 'true',
  telegram_last_update_id: '0',
};

async function getAll() {
  const [rows] = await pool.query('SELECT `key`, `value` FROM settings');
  const result = { ...DEFAULTS };
  const legacyPlaintext = {};
  for (const row of rows) {
    let value = row.value;
    if (SECRET_KEYS.has(row.key) && value) {
      if (cryptoService.isEncrypted(value)) {
        value = cryptoService.decrypt(value);
      } else {
        // Fila de antes de agregar cifrado (o instancia sin
        // CREDENTIALS_ENC_KEY todavia) - se usa tal cual y se re-guarda
        // cifrada para la proxima vez, sin que el usuario tenga que
        // volver a escribirla.
        legacyPlaintext[row.key] = value;
      }
    }
    if (value !== null && value !== '') {
      result[row.key] = value;
    } else if (result[row.key] === undefined) {
      result[row.key] = value;
    }
  }
  if (Object.keys(legacyPlaintext).length > 0) {
    setMany(legacyPlaintext).catch((err) => {
      console.error('No se pudo migrar credenciales legadas a formato cifrado:', err.message);
    });
  }
  return result;
}

async function get(key) {
  const all = await getAll();
  return all[key];
}

async function setMany(pairs) {
  const entries = Object.entries(pairs);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const [key, value] of entries) {
      const raw = value === undefined || value === null ? '' : String(value);
      const stored = SECRET_KEYS.has(key) ? cryptoService.encrypt(raw) : raw;
      await conn.query(
        'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
        [key, stored]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

function thresholds(settings) {
  return String(settings.reminder_thresholds_days || '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => b - a);
}

function recipients(settings) {
  return String(settings.reminder_recipients || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = { getAll, get, setMany, thresholds, recipients, DEFAULTS };
