// Lectura de facturas y recibos (PDF o imagen) con IA: monto, concepto,
// proveedor, N.º de factura, RUC, fechas y local/sede.
//
// Usa el proveedor asignado a "Lectura de facturas" (Configuracion >
// Inteligencia artificial):
//   - Gemini y Claude reciben el archivo tal cual (leen PDF e imagenes).
//   - Un modelo local (Ollama) o compatible con OpenAI recibe el TEXTO del
//     PDF (extraido aqui con pdf.js); una imagen solo si el modelo tiene
//     vision. Un PDF escaneado (sin texto) necesita un modelo que lea PDF.
const aiService = require('./aiService');
const { extractLines } = require('./mobileBillParsers/pdfText');

const EXTRACTION_FIELDS = [
  'monto', 'moneda', 'concepto', 'proveedor', 'numero_factura',
  'ruc_proveedor', 'fecha_emision', 'fecha_vencimiento', 'local',
];
const SUPPORTED = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const MAX_TEXT = 40000;

const PROMPT = `Eres un asistente que extrae datos de facturas y recibos de proveedores (en español, Perú u otros países de LatAm) para un sistema de gestión de licencias, dominios y contratos.

Analiza el documento (puede ser una factura, boleta, recibo o comprobante de pago) y devuelve EXCLUSIVAMENTE un objeto JSON (sin texto adicional, sin bloques de código markdown) con esta forma exacta:

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
    // Si el modelo no respeto el formato pedido, se descarta en vez de guardar basura
    if (out[dateField] && !/^\d{4}-\d{2}-\d{2}$/.test(out[dateField])) out[dateField] = null;
  }
  return out;
}

// buffer: contenido del archivo; mimeType: ej. "application/pdf", "image/png"
//   -> { ...campos, _provider: { label, ... } }
async function extractInvoiceData(buffer, mimeType) {
  if (!SUPPORTED.includes(mimeType)) throw new Error(`Tipo de archivo no soportado para extracción con IA: ${mimeType}`);
  const p = await aiService.resolve('facturas');
  const readsFiles = ['gemini', 'anthropic'].includes(p.kind);
  let prompt = PROMPT;
  let files = [];
  if (mimeType === 'application/pdf' && !readsFiles) {
    const text = (await extractLines(buffer)).join('\n').trim();
    if (text.length < 30) {
      throw new Error(`El PDF no tiene texto (parece escaneado) y "${p.label}" no lee PDF como imagen. Súbalo como imagen o asigne a "Lectura de facturas" un proveedor que lea PDF (Gemini o Claude).`);
    }
    prompt = `${PROMPT}\n\nTexto del documento (extraído del PDF, renglón por renglón):\n"""\n${text.slice(0, MAX_TEXT)}\n"""`;
  } else {
    if (mimeType !== 'application/pdf' && !readsFiles && !p.supports_vision) {
      throw new Error(`"${p.label}" (${p.model}) no lee imágenes. Suba el PDF, o asigne a "Lectura de facturas" un modelo con visión.`);
    }
    files = [{ mime: mimeType, base64: buffer.toString('base64') }];
  }
  const r = await aiService.generateText('facturas', prompt, { json: true, temperature: 0, files, provider: p });
  return { ...normalize(aiService.extractJson(r.text)), _provider: r.provider };
}

module.exports = { extractInvoiceData, normalize, EXTRACTION_FIELDS, PROMPT };
