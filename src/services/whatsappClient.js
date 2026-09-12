// Cliente para la API de WhatsApp Cloud (Meta) - webhook entrante y envio
// de mensajes salientes.
// Documentacion: https://developers.facebook.com/docs/whatsapp/cloud-api
//
// Nota: esta funcionalidad no se pudo probar contra un WhatsApp/Meta real
// (no hay una cuenta de Meta Business disponible en el entorno donde se
// desarrollo) - se construyo verificando cada detalle contra la
// documentacion oficial. Si algo no calza al conectarlo con una cuenta
// real (nombres de campo, formato de respuesta), avisar para ajustarlo.
const axios = require('axios');
const crypto = require('crypto');
const settingsService = require('./settingsService');

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

async function getConfig() {
  const settings = await settingsService.getAll();
  return {
    phoneNumberId: settings.whatsapp_phone_number_id || '',
    accessToken: settings.whatsapp_access_token || '',
    verifyToken: settings.whatsapp_verify_token || '',
    appSecret: settings.whatsapp_app_secret || '',
  };
}

// Verifica el header X-Hub-Signature-256 ("sha256=<hex>") calculando el
// HMAC-SHA256 del body CRUDO (sin parsear) con el App Secret de Meta.
// Usa timingSafeEqual (igual que src/middleware/csrf.js) para no filtrar
// tiempos de comparacion.
function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !appSecret || !rawBody) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const received = String(signatureHeader).replace(/^sha256=/, '');
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

// Envia un mensaje de texto libre. Solo valido dentro de la ventana de
// 24h desde el ultimo mensaje que envio ese numero (regla de WhatsApp
// para conversaciones "de servicio" iniciadas por el usuario) - para
// notificaciones que la app inicia por su cuenta hace falta una plantilla
// pre-aprobada por Meta, que esta funcion no cubre.
async function sendTextMessage(to, body) {
  const { phoneNumberId, accessToken } = await getConfig();
  if (!phoneNumberId || !accessToken) {
    throw new Error('WhatsApp no esta configurado por completo. Ve a Configuracion.');
  }
  const res = await axios.post(
    `${GRAPH_API_BASE}/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body },
    },
    {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  if (res.status !== 200) {
    throw new Error(`Error enviando mensaje de WhatsApp (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

// Llamada minima para validar credenciales sin enviar un mensaje real,
// usada desde el boton "Probar conexion" en Configuracion.
async function testConnection() {
  const { phoneNumberId, accessToken } = await getConfig();
  if (!phoneNumberId || !accessToken) {
    throw new Error('Completa el ID de numero de telefono y el token de acceso.');
  }
  const res = await axios.get(`${GRAPH_API_BASE}/${phoneNumberId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { fields: 'display_phone_number,verified_name' },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

module.exports = { getConfig, verifySignature, sendTextMessage, testConnection };
