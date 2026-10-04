// Configuracion unica de IA de la aplicacion y de DevOps Sidecar.
//
// - Proveedores (tabla ai_providers): locales (Ollama, los datos no salen
//   de la empresa) y en la nube (Gemini, Claude, compatibles con OpenAI),
//   cada uno con su modelo, que se cambia desde Configuracion > Inteligencia
//   artificial sin tocar codigo. La API key se guarda cifrada.
// - Usos (settings ai_uso_*): que proveedor usa cada funcion. El sidecar no
//   tiene configuracion propia: le pide a esta aplicacion que genere por el
//   (POST /interno/ia/generar, ver src/routes/internalAi.js).
// - Respaldo (settings ai_respaldo): proveedor al que se pasa si el
//   asignado no responde. Vacio = sin respaldo (por defecto: asi una
//   pregunta pensada para el servidor local nunca sale a la nube sola).
// - Si el modelo no tiene llamada a herramientas nativa, se emula pidiendo
//   JSON; el asistente funciona igual con cualquier modelo.
const pool = require('../db/pool');
const cryptoService = require('./cryptoService');
const settingsService = require('./settingsService');
const providers = require('./ai/providers');

const { AIError, KINDS } = providers;

const USES = {
  asistente: { label: 'Asistente "Preguntar a la IA"', help: 'Conversa, consulta los datos y arma reportes. Necesita herramientas (nativas o emuladas).' },
  chatbot: { label: 'Chatbot de WhatsApp y Telegram', help: 'Interpreta la pregunta y elige qué consultar.' },
  facturas: { label: 'Lectura de facturas y recibos', help: 'PDF o imagen. Con un modelo local, el PDF se lee como texto y la imagen necesita un modelo con visión.' },
  sidecar_auditoria: { label: 'DevOps: auditoría diaria de código', help: 'Revisa los cambios del día de cada repositorio. Textos largos: conviene un contexto amplio.' },
  sidecar_textos: { label: 'DevOps: asistente y resúmenes de commits', help: 'Preguntas y resúmenes dentro de DevOps Sidecar.' },
};

const clean = (v) => String(v === null || v === undefined ? '' : v).trim();

function extractJson(text) {
  if (!text) throw new Error('Respuesta vacía del modelo.');
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('No se pudo interpretar la respuesta del modelo como JSON.');
  }
}

// --- Proveedores guardados ------------------------------------------------
const withKey = (row) => (row ? { ...row, api_key: row.api_key ? cryptoService.decrypt(row.api_key) : '' } : null);
const publicInfo = (p) => (p ? { id: p.id, label: p.label, kind: p.kind, location: p.location, model: p.model } : null);

async function list() {
  const [rows] = await pool.query('SELECT * FROM ai_providers ORDER BY active DESC, location, label');
  return rows.map((r) => ({ ...r, api_key: undefined, has_key: !!r.api_key }));
}

async function get(id) {
  const [[row]] = await pool.query('SELECT * FROM ai_providers WHERE id = ?', [Number(id) || 0]);
  return withKey(row);
}

function validate(input) {
  const d = {};
  d.label = clean(input.label).slice(0, 80);
  d.kind = clean(input.kind);
  if (!d.label) throw new Error('Escriba un nombre para el proveedor.');
  if (!KINDS[d.kind]) throw new Error('Tipo de proveedor no válido.');
  d.location = ['local', 'nube'].includes(input.location) ? input.location : KINDS[d.kind].location;
  d.base_url = clean(input.base_url).replace(/\/+$/, '').slice(0, 255) || null;
  if (d.base_url && !/^https?:\/\/[^\s]+$/i.test(d.base_url)) throw new Error('La dirección debe empezar con http:// o https://');
  if (d.kind === 'ollama' && !d.base_url) throw new Error('Indique la dirección del servidor Ollama (ej. http://172.16.1.22:11434).');
  d.model = clean(input.model).slice(0, 150);
  if (!d.model || /\s/.test(d.model)) throw new Error('Indique el identificador del modelo, sin espacios (ej. gemma4:26b o gemini-2.5-flash).');
  const flag = (k) => (input[k] === true || input[k] === '1' || input[k] === 'on' || input[k] === 1 ? 1 : 0);
  d.supports_tools = flag('supports_tools');
  d.supports_vision = flag('supports_vision');
  d.supports_web = d.kind === 'gemini' ? flag('supports_web') : 0;
  d.active = flag('active');
  const ctx = parseInt(input.context_tokens, 10);
  d.context_tokens = d.kind === 'ollama' && ctx > 0 ? Math.min(ctx, 1048576) : null;
  const t = parseInt(input.timeout_seconds, 10);
  d.timeout_seconds = t > 0 ? Math.min(Math.max(t, 10), 1800) : (d.kind === 'ollama' ? 300 : 90);
  return d;
}

// apiKey en blanco = mantener la que ya estaba (igual que en Configuracion).
async function save(input, id = null) {
  const existing = id ? await get(id) : null;
  if (id && !existing) throw new Error('El proveedor no existe.');
  const d = validate(input);
  const key = clean(input.api_key);
  if (key) d.api_key = cryptoService.encrypt(key);
  else if (input.clear_api_key) d.api_key = null;
  if (KINDS[d.kind].needsKey && !key && !(existing && existing.api_key && !input.clear_api_key)) throw new Error(`${KINDS[d.kind].label} necesita una API key.`);
  try {
    if (existing) {
      await pool.query('UPDATE ai_providers SET ? WHERE id = ?', [d, existing.id]);
      return existing.id;
    }
    const [r] = await pool.query('INSERT INTO ai_providers SET ?', [d]);
    return r.insertId;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new Error(`Ya hay un proveedor llamado "${d.label}".`);
    throw err;
  }
}

async function uses() {
  const s = await settingsService.getAll();
  const out = {};
  for (const k of Object.keys(USES)) out[k] = Number(s[`ai_uso_${k}`]) || null;
  return { assigned: out, fallback: Number(s.ai_respaldo) || null, choosePerQuestion: String(s.ai_elegir_por_pregunta) !== 'false' };
}

async function saveUses(input) {
  const ids = new Set((await list()).map((p) => p.id));
  const pairs = {};
  for (const k of Object.keys(USES)) {
    const id = Number(input[`ai_uso_${k}`]) || '';
    if (id && !ids.has(id)) throw new Error('Proveedor no válido.');
    pairs[`ai_uso_${k}`] = String(id);
  }
  const fb = Number(input.ai_respaldo) || '';
  if (fb && !ids.has(fb)) throw new Error('Proveedor de respaldo no válido.');
  pairs.ai_respaldo = String(fb);
  pairs.ai_elegir_por_pregunta = input.ai_elegir_por_pregunta ? 'true' : 'false';
  await settingsService.setMany(pairs);
}

async function remove(id) {
  const u = await uses();
  const busy = Object.entries(u.assigned).filter(([, v]) => v === Number(id)).map(([k]) => USES[k].label);
  if (u.fallback === Number(id)) busy.push('respaldo');
  if (busy.length) throw new Error(`Está en uso (${busy.join(', ')}). Asigne otro proveedor antes de eliminarlo.`);
  await pool.query('DELETE FROM ai_providers WHERE id = ?', [Number(id) || 0]);
}

// Proveedor para una funcion. chosenId: el que eligio la persona para esta
// pregunta (solo si la configuracion lo permite y esta activo).
async function resolve(use, chosenId = null) {
  const u = await uses();
  if (chosenId && u.choosePerQuestion) {
    const p = await get(chosenId);
    if (p && p.active) return p;
  }
  const assigned = u.assigned[use] ? await get(u.assigned[use]) : null;
  if (assigned && assigned.active) return assigned;
  const [[first]] = await pool.query('SELECT id FROM ai_providers WHERE active = 1 ORDER BY location = \'local\' DESC, id LIMIT 1');
  if (!first) throw new AIError('No hay ningún proveedor de IA activo. Configure uno en Configuración > Inteligencia artificial.');
  return get(first.id);
}

async function fallbackFor(provider) {
  const u = await uses();
  if (!u.fallback || u.fallback === provider.id) return null;
  const p = await get(u.fallback);
  return p && p.active ? p : null;
}

// --- Herramientas emuladas (modelos sin llamada a herramientas nativa) ----
function emulate(req) {
  const catalog = req.tools.map((t) => `- ${t.name}: ${t.description}\n  argumentos (JSON Schema): ${JSON.stringify(t.parameters)}`).join('\n');
  const system = `${req.system || ''}

Herramientas disponibles:
${catalog}

Responde SIEMPRE con un único objeto JSON, sin texto alrededor:
- Para usar una herramienta: {"herramienta": "<nombre>", "argumentos": { ... }}
- Para responder al usuario: {"respuesta": "<tu respuesta, puede llevar markdown>"}`;
  const messages = req.messages.map((m) => {
    if (m.role === 'assistant' && m.calls && m.calls.length) return { role: 'assistant', text: JSON.stringify({ herramienta: m.calls[0].name, argumentos: m.calls[0].args }) };
    if (m.role === 'assistant') return { role: 'assistant', text: m.raw && m.raw.emulated ? JSON.stringify({ respuesta: m.text }) : m.text };
    if (m.role === 'tool') return { role: 'user', text: m.results.map((r) => `Resultado de ${r.name}: ${JSON.stringify(r.response)}`).join('\n\n') };
    return m;
  });
  return { ...req, system, messages, tools: [], json: true };
}

function unemulate(result, tools) {
  let parsed = null;
  try { parsed = extractJson(result.text); } catch (_) { /* respondio texto libre */ }
  const names = tools.map((t) => t.name);
  if (parsed && names.includes(parsed.herramienta)) {
    return { ...result, text: '', calls: [{ id: `${parsed.herramienta}-0`, name: parsed.herramienta, args: parsed.argumentos || {} }], raw: { emulated: true } };
  }
  const text = parsed && typeof parsed.respuesta === 'string' ? parsed.respuesta : result.text;
  return { ...result, text, calls: [], raw: { emulated: true } };
}

async function callProvider(p, req) {
  const useEmulation = req.tools && req.tools.length && !p.supports_tools;
  const result = await providers.chat(p, useEmulation ? emulate(req) : req);
  return useEmulation ? unemulate(result, req.tools) : result;
}

// Una llamada. opts: { providerId (eleccion de la persona), provider (ya
// resuelto, ej. el mismo de los pasos anteriores) }.
//   -> { ...resultado, provider: { id, label, ... }, fellBackFrom }
async function chat(use, req, opts = {}) {
  const p = opts.provider || await resolve(use, opts.providerId);
  try {
    return { ...(await callProvider(p, req)), provider: publicInfo(p), resolved: p };
  } catch (err) {
    const fb = err.retryable && !opts.provider ? await fallbackFor(p) : null;
    if (!fb) throw err;
    const result = await callProvider(fb, req);
    return { ...result, provider: publicInfo(fb), resolved: fb, fellBackFrom: `${p.label}: ${err.message}` };
  }
}

// Texto simple: prompt -> texto. opts: { system, json, files, timeoutMs, providerId }
async function generateText(use, prompt, opts = {}) {
  const r = await chat(use, {
    system: opts.system, json: opts.json, temperature: opts.temperature ?? 0.2, timeoutMs: opts.timeoutMs,
    messages: [{ role: 'user', text: prompt, files: opts.files || [] }],
  }, opts);
  if (!r.text) throw new AIError(`${r.provider.label} no devolvió texto${r.finish ? ` (motivo: ${r.finish})` : ''}.`);
  return { text: r.text, provider: r.provider, resolved: r.resolved, fellBackFrom: r.fellBackFrom };
}

// Busqueda en internet: solo la tiene Gemini. Se usa el proveedor activo
// que la tenga (con preferencia por el del asistente).
async function webSearchProvider() {
  const u = await uses();
  const [rows] = await pool.query('SELECT id FROM ai_providers WHERE active = 1 AND supports_web = 1 ORDER BY id = ? DESC, id LIMIT 1', [u.assigned.asistente || 0]);
  return rows[0] ? get(rows[0].id) : null;
}

async function webSearch(query) {
  const p = await webSearchProvider();
  if (!p) throw new AIError('No hay un proveedor con búsqueda en internet activo (se necesita Gemini).');
  const r = await providers.chat(p, {
    webSearch: true, temperature: 0.2,
    messages: [{ role: 'user', text: `Busca en internet y responde en español, con datos concretos y actuales (modelos, versiones, fechas, precios si se piden), sin relleno:\n\n${query}` }],
  });
  return { answer: r.text, sources: r.sources.slice(0, 8), provider: publicInfo(p) };
}

// Opciones del selector "Responder con" del panel del asistente.
async function choices() {
  const u = await uses();
  const rows = (await list()).filter((p) => p.active);
  const web = await webSearchProvider();
  return {
    webLabel: web ? web.label : null, // las busquedas en internet pasan por este, responda quien responda
    allowed: u.choosePerQuestion,
    defaultId: u.assigned.asistente,
    providers: rows.map((p) => ({ ...publicInfo(p), web: !!p.supports_web })),
  };
}

// Prueba: que sabe hacer el modelo (y se guarda) y una respuesta corta.
async function test(id) {
  const p = await get(id);
  if (!p) throw new Error('El proveedor no existe.');
  const started = Date.now();
  let ok = false;
  let message;
  try {
    const caps = await providers.capabilities(p);
    const r = await providers.chat(p, { messages: [{ role: 'user', text: 'Responde únicamente con la palabra: OK' }], temperature: 0, timeoutMs: Math.max(p.timeout_seconds, 60) * 1000 });
    ok = true;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    message = `Responde (${secs} s): "${r.text.slice(0, 40)}".`;
    if (caps.known) {
      await pool.query('UPDATE ai_providers SET supports_tools = ?, supports_vision = ?, supports_web = ? WHERE id = ?',
        [caps.tools ? 1 : 0, caps.vision ? 1 : 0, caps.web ? 1 : 0, p.id]);
      message += ` Herramientas: ${caps.tools ? 'sí' : 'no (se emulan)'}. Imágenes: ${caps.vision ? 'sí' : 'no'}.`;
      if (caps.maxContext) message += ` Contexto máximo del modelo: ${caps.maxContext.toLocaleString('es')} tokens.`;
    }
  } catch (err) {
    message = err.message;
  }
  await pool.query('UPDATE ai_providers SET last_test_at = NOW(), last_test_ok = ?, last_test_message = ? WHERE id = ?', [ok ? 1 : 0, message.slice(0, 500), p.id]);
  return { ok, message, provider: publicInfo(p) };
}

// Modelos disponibles con los datos del formulario (aun sin guardar). Si
// la API key viene en blanco, se usa la guardada.
async function models(input, id = null) {
  const existing = id ? await get(id) : null;
  const cfg = {
    kind: KINDS[input.kind] ? input.kind : 'ollama',
    base_url: clean(input.base_url) || null,
    api_key: clean(input.api_key) || (existing && existing.kind === input.kind ? existing.api_key : ''),
    timeout_seconds: 15,
  };
  return providers.listModels(cfg);
}

module.exports = {
  USES, KINDS, AIError, extractJson, publicInfo,
  list, get, save, remove, uses, saveUses, resolve, chat, generateText, webSearch, webSearchProvider, choices, test, models,
};
