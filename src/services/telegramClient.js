// Cliente delgado sobre la Telegram Bot API (https://core.telegram.org/bots/api).
// Gratis, sin cuenta de negocio: el token se obtiene hablando con
// @BotFather dentro de Telegram.
const axios = require('axios');
const settingsService = require('./settingsService');

const API_BASE = 'https://api.telegram.org';

async function getConfig() {
  const settings = await settingsService.getAll();
  return {
    botToken: settings.telegram_bot_token || '',
    pollingEnabled: String(settings.telegram_polling_enabled) !== 'false',
    lastUpdateId: parseInt(settings.telegram_last_update_id, 10) || 0,
  };
}

function requireToken(botToken) {
  if (!botToken) {
    throw new Error('El bot de Telegram no esta configurado. Ve a Configuracion y pega el token de @BotFather.');
  }
}

async function testConnection() {
  const { botToken } = await getConfig();
  requireToken(botToken);
  const res = await axios.get(`${API_BASE}/bot${botToken}/getMe`, { timeout: 15000, validateStatus: () => true });
  if (res.status !== 200 || !res.data.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.data)}`);
  }
  return res.data.result; // { id, is_bot, first_name, username, ... }
}

async function sendMessage(chatId, text) {
  const { botToken } = await getConfig();
  requireToken(botToken);
  const res = await axios.post(
    `${API_BASE}/bot${botToken}/sendMessage`,
    { chat_id: chatId, text },
    { timeout: 15000, validateStatus: () => true }
  );
  if (res.status !== 200 || !res.data.ok) {
    throw new Error(`Error enviando mensaje de Telegram (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
  }
  return res.data.result;
}

// Polling corto (sin "long polling" con timeout, para mantener el ciclo
// simple y predecible dado el bajo volumen esperado - unas pocas consultas
// al dia). offset = ultimo update_id procesado + 1, para que Telegram no
// vuelva a mandar updates ya confirmados.
async function getUpdates(offset) {
  const { botToken } = await getConfig();
  requireToken(botToken);
  const res = await axios.get(`${API_BASE}/bot${botToken}/getUpdates`, {
    params: { offset, timeout: 0, allowed_updates: JSON.stringify(['message']) },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (res.status !== 200 || !res.data.ok) {
    throw new Error(`Error consultando updates de Telegram (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
  }
  return res.data.result; // array de Update
}

module.exports = { getConfig, testConnection, sendMessage, getUpdates };
