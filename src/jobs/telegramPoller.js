// Sondeo (polling) del bot de Telegram: no requiere exponer la app a
// internet (a diferencia del webhook de WhatsApp) - la propia app le
// pregunta a Telegram cada pocos segundos si hay mensajes nuevos.
//
// El offset (ultimo update_id procesado) se guarda en `settings` para no
// reprocesar mensajes si la app se reinicia.
const settingsService = require('../services/settingsService');
const telegramClient = require('../services/telegramClient');
const chatAgent = require('../services/chatAgent');

const POLL_INTERVAL_MS = 3000;
const IDLE_INTERVAL_MS = 10000; // sin token configurado: revisa con menos frecuencia

async function handleMessage(message) {
  const chatId = String(message.chat.id);
  const text = message.text;
  if (!text) return; // ignora fotos/audios/etc, solo texto

  // /start es la unica forma en que un usuario puede conocer su propio
  // chat_id (Telegram no lo expone de otra manera) para pasarselo al
  // administrador y que lo vincule en Usuarios. No requiere autorizacion:
  // el chat_id no es un dato sensible, es solo un identificador.
  if (text.trim() === '/start') {
    await telegramClient.sendMessage(
      chatId,
      `Hola! Tu ID de chat de Telegram es: ${chatId}\n\nCompártelo con tu administrador para que vincule este chat a tu usuario y puedas consultar al asistente.`
    );
    return;
  }

  const reply = await chatAgent.answerQuestion('telegram', chatId, text);
  await telegramClient.sendMessage(chatId, reply);
}

async function pollOnce() {
  const { botToken, pollingEnabled, lastUpdateId } = await telegramClient.getConfig();
  if (!botToken || !pollingEnabled) return IDLE_INTERVAL_MS;

  const updates = await telegramClient.getUpdates(lastUpdateId + 1);
  let maxId = lastUpdateId;

  for (const update of updates) {
    maxId = Math.max(maxId, update.update_id);
    if (update.message) {
      try {
        await handleMessage(update.message);
      } catch (err) {
        console.error('[telegram] Error procesando mensaje entrante:', err.message);
      }
    }
  }

  if (maxId !== lastUpdateId) {
    await settingsService.setMany({ telegram_last_update_id: String(maxId) });
  }

  return POLL_INTERVAL_MS;
}

let stopped = false;

async function loop() {
  if (stopped) return;
  let delay = POLL_INTERVAL_MS;
  try {
    delay = await pollOnce();
  } catch (err) {
    console.error('[telegram] Error en el ciclo de sondeo:', err.message);
    delay = IDLE_INTERVAL_MS;
  }
  setTimeout(loop, delay);
}

function startPolling() {
  console.log('[telegram] Sondeo del bot de Telegram activo (revisa mensajes nuevos periodicamente).');
  loop();
}

function stopPolling() {
  stopped = true;
}

module.exports = { startPolling, stopPolling, pollOnce };
