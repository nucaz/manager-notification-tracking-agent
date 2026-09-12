// Webhook publico de WhatsApp Cloud API (Meta) - lo llama Meta, no un
// usuario logueado de la app. Por eso NO lleva requireAuth ni el CSRF de
// sesion (Meta no manda cookie de sesion ni token _csrf): la seguridad
// acá es la verificacion de firma HMAC (verifySignature) y, mas adentro,
// la lista de numeros autorizados que ya aplica whatsappAgent.
const express = require('express');
const settingsService = require('../services/settingsService');
const whatsappClient = require('../services/whatsappClient');
const whatsappAgent = require('../services/whatsappAgent');

const router = express.Router();

// Handshake de verificacion que Meta hace una sola vez al configurar la
// URL del webhook: GET con hub.mode=subscribe, hub.verify_token,
// hub.challenge - hay que devolver el challenge tal cual si el token
// coincide con el configurado en Configuracion.
router.get('/', async (req, res) => {
  try {
    const settings = await settingsService.getAll();
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (
      mode === 'subscribe' &&
      settings.whatsapp_verify_token &&
      token === settings.whatsapp_verify_token
    ) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  } catch (err) {
    return res.sendStatus(403);
  }
});

router.post('/', async (req, res) => {
  try {
    const settings = await settingsService.getAll();
    const signature = req.headers['x-hub-signature-256'];
    const valid = whatsappClient.verifySignature(req.rawBody, signature, settings.whatsapp_app_secret);
    if (!valid) {
      console.error('[whatsapp] Firma invalida en webhook entrante, rechazado.');
      return res.sendStatus(401);
    }
  } catch (err) {
    console.error('[whatsapp] Error validando la firma del webhook:', err.message);
    return res.sendStatus(401);
  }

  // Responder rapido a Meta (evita reintentos/desactivacion del webhook
  // por timeout); el procesamiento real (Gemini + BD + envio) sigue
  // despues sin bloquear el ack.
  res.sendStatus(200);

  try {
    const entry = req.body.entry && req.body.entry[0];
    const change = entry && entry.changes && entry.changes[0];
    const value = change && change.value;
    const message = value && value.messages && value.messages[0];
    // Puede no traer "messages" (ej. webhooks de estado de entrega): se
    // ignora, no es un mensaje de texto entrante.
    if (!message || message.type !== 'text') return;

    const from = message.from;
    const text = message.text && message.text.body;
    if (!from || !text) return;

    const reply = await whatsappAgent.answerQuestion(from, text);
    await whatsappClient.sendTextMessage(from, reply);
  } catch (err) {
    console.error('[whatsapp] Error procesando mensaje entrante:', err.message);
  }
});

module.exports = router;
