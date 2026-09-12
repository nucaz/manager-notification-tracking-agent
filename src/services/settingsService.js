// Configuracion editable desde la UI, respaldada en la tabla `settings`.
// Los valores de .env se usan como respaldo inicial si la tabla esta vacia.
const pool = require('../db/pool');
const env = require('../config/env');

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
};

async function getAll() {
  const [rows] = await pool.query('SELECT `key`, `value` FROM settings');
  const result = { ...DEFAULTS };
  for (const row of rows) {
    if (row.value !== null && row.value !== '') {
      result[row.key] = row.value;
    } else if (result[row.key] === undefined) {
      result[row.key] = row.value;
    }
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
      await conn.query(
        'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
        [key, value === undefined || value === null ? '' : String(value)]
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
