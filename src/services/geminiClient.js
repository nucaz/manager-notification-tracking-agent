// Cliente para la API de Gemini (Google) usada para leer facturas/recibos
// (PDF o imagen) y extraer datos estructurados: monto, concepto, proveedor,
// N° de factura, RUC, fechas y local/sede.
//
// Documentacion: https://ai.google.dev/gemini-api/docs
//
// Nota: el modelo es configurable desde Configuracion (gemini_model) porque
// Google renueva sus modelos "flash" con cierta frecuencia; si el nombre de
// modelo configurado deja de existir, basta con cambiarlo ahi sin tocar
// codigo. Por defecto se usa "gemini-2.5-flash".
const axios = require('axios');
const settingsService = require('./settingsService');

// Permite apuntar a un endpoint compatible distinto (pruebas, proxy corporativo,
// Vertex AI, etc.) sin tocar código. Por defecto usa la API publica de Gemini.
const API_BASE = process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

const EXTRACTION_FIELDS = [
  'monto', 'moneda', 'concepto', 'proveedor', 'numero_factura',
  'ruc_proveedor', 'fecha_emision', 'fecha_vencimiento', 'local',
];

const PROMPT = `Eres un asistente que extrae datos de facturas y recibos de proveedores (en español, Perú u otros países de LatAm) para un sistema de gestión de licencias, dominios y contratos.

Analiza el documento adjunto (puede ser una factura, boleta, recibo o comprobante de pago) y devuelve EXCLUSIVAMENTE un objeto JSON (sin texto adicional, sin bloques de código markdown) con esta forma exacta:

{
  "monto": <número decimal con el importe TOTAL a pagar, usando punto como separador decimal, sin símbolos de moneda ni separador de miles; null si no se identifica>,
  "moneda": "<código de moneda ISO de 3 letras, ej. PEN, USD, EUR; null si no se identifica>",
  "concepto": "<breve descripción de qué es el gasto, ej. 'Renovación anual Microsoft 365 E3', máximo 200 caracteres; null si no se identifica>",
  "proveedor": "<nombre o razón social del proveedor/emisor del documento; null si no se identifica>",
  "numero_factura": "<número o serie del comprobante, ej. F001-00123; null si no se identifica>",
  "ruc_proveedor": "<RUC, NIT o identificador tributario del proveedor; null si no se identifica>",
  "fecha_emision": "<fecha de emisión en formato YYYY-MM-DD; null si no se identifica>",
  "fecha_vencimiento": "<fecha de vencimiento o pago en formato YYYY-MM-DD; null si no se identifica o no aplica>",
  "local": "<local, sede, sucursal o dirección de entrega/servicio mencionada en el documento; null si no se identifica>"
}

No inventes datos que no aparezcan en el documento: usa null cuando no estés razonablemente seguro. Responde solo el JSON.`;

async function getConfig() {
  const settings = await settingsService.getAll();
  return {
    apiKey: settings.gemini_api_key || '',
    model: settings.gemini_model || 'gemini-2.5-flash',
  };
}

function extractJson(text) {
  if (!text) throw new Error('Respuesta vacía del modelo.');
  let cleaned = text.trim();
  // Quita bloques de código markdown si el modelo los agrega de todas formas
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // Ultimo recurso: buscar el primer objeto { ... } dentro del texto
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error('No se pudo interpretar la respuesta del modelo como JSON.');
  }
}

function normalize(raw) {
  const out = {};
  for (const field of EXTRACTION_FIELDS) {
    let v = raw[field];
    if (v === undefined || v === '' || v === 'null') v = null;
    out[field] = v;
  }
  if (out.monto !== null && out.monto !== undefined) {
    const n = parseFloat(String(out.monto).replace(/,/g, ''));
    out.monto = Number.isFinite(n) ? n : null;
  }
  if (out.moneda) out.moneda = String(out.moneda).toUpperCase().slice(0, 10);
  for (const dateField of ['fecha_emision', 'fecha_vencimiento']) {
    if (out[dateField] && !/^\d{4}-\d{2}-\d{2}$/.test(out[dateField])) {
      // Si el modelo no respeto el formato pedido, se descarta en vez de guardar basura
      out[dateField] = null;
    }
  }
  return out;
}

// buffer: Buffer con el contenido del archivo; mimeType: ej. "application/pdf", "image/png"
async function extractInvoiceData(buffer, mimeType) {
  const { apiKey, model } = await getConfig();
  if (!apiKey) {
    throw new Error(
      'La API key de Gemini no esta configurada. Ve a Configuracion y agrega tu API key.'
    );
  }
  const supported = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
  if (!supported.includes(mimeType)) {
    throw new Error(`Tipo de archivo no soportado para extracción con IA: ${mimeType}`);
  }

  const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [
      {
        parts: [
          { inlineData: { mimeType, data: buffer.toString('base64') } },
          { text: PROMPT },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
    },
  };

  let response;
  try {
    response = await axios.post(url, body, {
      timeout: 45000,
      validateStatus: () => true,
    });
  } catch (err) {
    throw new Error(`No se pudo contactar a la API de Gemini: ${err.message}`);
  }

  if (response.status !== 200) {
    const apiMsg =
      (response.data && response.data.error && response.data.error.message) ||
      JSON.stringify(response.data);
    throw new Error(`Gemini respondió con error (HTTP ${response.status}): ${apiMsg}`);
  }

  const candidate = response.data && response.data.candidates && response.data.candidates[0];
  const text =
    candidate &&
    candidate.content &&
    candidate.content.parts &&
    candidate.content.parts.map((p) => p.text || '').join('');

  if (!text) {
    const finishReason = candidate && candidate.finishReason;
    throw new Error(
      `Gemini no devolvió texto interpretable${finishReason ? ` (motivo: ${finishReason})` : ''}.`
    );
  }

  const parsed = extractJson(text);
  return normalize(parsed);
}

// Llamada minima para verificar que la API key funciona, usada desde Configuracion
async function testConnection() {
  const { apiKey, model } = await getConfig();
  if (!apiKey) {
    throw new Error('Agrega primero una API key de Gemini.');
  }
  const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await axios.post(
    url,
    { contents: [{ parts: [{ text: 'Responde unicamente con la palabra: OK' }] }] },
    { timeout: 20000, validateStatus: () => true }
  );
  if (response.status !== 200) {
    const apiMsg =
      (response.data && response.data.error && response.data.error.message) ||
      JSON.stringify(response.data);
    throw new Error(`HTTP ${response.status}: ${apiMsg}`);
  }
  return true;
}

module.exports = { extractInvoiceData, testConnection, EXTRACTION_FIELDS };
