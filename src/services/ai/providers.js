// Llamadas HTTP a cada tipo de proveedor de IA, con una sola forma de
// conversacion para todos (la usa src/services/aiService.js):
//
//   cfg: { kind, base_url, model, api_key (en claro), timeout_seconds, context_tokens }
//   req: { system, messages, tools, json, temperature, maxTokens, webSearch, timeoutMs }
//   messages:
//     { role: 'user', text, files: [{ mime, base64 }] }
//     { role: 'assistant', text, calls: [{ id, name, args }], raw }   (raw: el turno tal cual lo dio el proveedor)
//     { role: 'tool', results: [{ id, name, response }] }
//   tools: [{ name, description, parameters (JSON Schema) }]
//   -> { text, calls: [{ id, name, args }], raw, finish, sources }
//
// Tipos:
//   ollama    servidor propio (POST /api/chat). Los datos no salen de la empresa.
//   gemini    Google (generateContent). Unico con busqueda en internet integrada.
//   anthropic Claude (POST /v1/messages).
//   openai    cualquier API compatible con OpenAI (OpenAI, LM Studio, vLLM...): /chat/completions.
//
// La API key viaja siempre en una cabecera, nunca en la URL, y los mensajes
// de error no la incluyen.
const axios = require('axios');

const KINDS = {
  ollama: { label: 'Ollama (servidor propio)', location: 'local', base: 'http://localhost:11434', needsKey: false },
  gemini: { label: 'Google Gemini', location: 'nube', base: 'https://generativelanguage.googleapis.com/v1beta', needsKey: true },
  anthropic: { label: 'Anthropic Claude', location: 'nube', base: 'https://api.anthropic.com', needsKey: true },
  openai: { label: 'Compatible con OpenAI', location: 'nube', base: 'https://api.openai.com/v1', needsKey: false },
};

class AIError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.retryable = retryable; // fallo del servicio (caido, lento, 5xx): vale probar el de respaldo
  }
}

function baseUrl(cfg) {
  // GEMINI_API_BASE_URL permite apuntar a un endpoint compatible o de pruebas.
  const fallback = cfg.kind === 'gemini' ? (process.env.GEMINI_API_BASE_URL || KINDS.gemini.base) : (KINDS[cfg.kind] || {}).base;
  return String(cfg.base_url || fallback || '').replace(/\/+$/, '');
}

const name = (cfg) => (KINDS[cfg.kind] || {}).label || cfg.kind;

async function http(cfg, method, url, { data, headers, timeoutMs } = {}) {
  const timeout = timeoutMs || (cfg.timeout_seconds || 120) * 1000;
  let res;
  try {
    res = await axios({ method, url, data, headers, timeout, validateStatus: () => true, maxBodyLength: Infinity, maxContentLength: Infinity });
  } catch (err) {
    // El mensaje de axios trae la URL; aqui solo se dice que paso.
    const why = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' ? `no respondió en ${Math.round(timeout / 1000)} s`
      : err.code === 'ECONNREFUSED' ? 'rechazó la conexión (¿está encendido?)'
        : err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' ? 'no se encontró la dirección'
          : `error de red (${err.code || 'desconocido'})`;
    throw new AIError(`${name(cfg)}: ${why}.`, { retryable: true });
  }
  if (res.status < 200 || res.status >= 300) {
    const d = res.data || {};
    const detail = (d.error && (d.error.message || d.error)) || d.message || (typeof d === 'string' ? d : JSON.stringify(d));
    let msg = `${name(cfg)} respondió con error (HTTP ${res.status}): ${String(detail).slice(0, 400)}`;
    if (cfg.kind === 'ollama' && res.status === 404) msg = `El modelo "${cfg.model}" no está descargado en el servidor Ollama. Descárguelo con "ollama pull ${cfg.model}" o elija otro en Configuración > Inteligencia artificial.`;
    if (res.status === 402 || res.status === 429) msg += ' (sin saldo o con límite de uso: revise la cuenta del proveedor).';
    throw new AIError(msg, { retryable: res.status >= 500 || res.status === 429 || res.status === 402 });
  }
  return res.data;
}

const parseArgs = (v) => {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v || '{}'); } catch (_) { return {}; }
};

// --- Gemini -------------------------------------------------------------
// Gemini escribe los tipos del esquema en mayusculas (OBJECT, STRING...).
function geminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'type' && typeof v === 'string') out[k] = v.toUpperCase();
    else if (k === 'properties') out[k] = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, geminiSchema(s)]));
    else if (k === 'items') out[k] = geminiSchema(v);
    else out[k] = v;
  }
  return out;
}

async function gemini(cfg, req) {
  const contents = [];
  for (const m of req.messages) {
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [...(m.files || []).map((f) => ({ inlineData: { mimeType: f.mime, data: f.base64 } })), { text: m.text || '' }] });
    } else if (m.role === 'assistant') {
      // El turno se devuelve tal cual: trae firmas (thoughtSignature) que la API exige de vuelta.
      const parts = m.raw && m.raw.kind === 'gemini' ? m.raw.parts
        : [...(m.text ? [{ text: m.text }] : []), ...(m.calls || []).map((c) => ({ functionCall: { name: c.name, args: c.args || {} } }))];
      contents.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      contents.push({ role: 'user', parts: m.results.map((r) => ({ functionResponse: { name: r.name, response: r.response } })) });
    }
  }
  const body = { contents, generationConfig: { temperature: req.temperature ?? 0.2 } };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  if (req.webSearch) body.tools = [{ google_search: {} }];
  else if (req.tools && req.tools.length) body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }];
  if (req.json) body.generationConfig.responseMimeType = 'application/json';
  if (req.maxTokens) body.generationConfig.maxOutputTokens = req.maxTokens;
  const data = await http(cfg, 'post', `${baseUrl(cfg)}/models/${encodeURIComponent(cfg.model)}:generateContent`,
    { data: body, headers: { 'x-goog-api-key': cfg.api_key || '' }, timeoutMs: req.timeoutMs });
  const candidate = (data.candidates || [])[0] || {};
  const parts = (candidate.content && candidate.content.parts) || [];
  const chunks = ((candidate.groundingMetadata || {}).groundingChunks || []).map((c) => c.web).filter((w) => w && /^https?:\/\//i.test(w.uri || ''));
  const seen = new Set();
  return {
    text: parts.filter((p) => !p.thought).map((p) => p.text || '').join('').trim(),
    calls: parts.filter((p) => p.functionCall).map((p, i) => ({ id: `${p.functionCall.name}-${i}`, name: p.functionCall.name, args: p.functionCall.args || {} })),
    raw: { kind: 'gemini', parts },
    finish: candidate.finishReason || null,
    sources: chunks.filter((w) => !seen.has(w.uri) && seen.add(w.uri)).map((w) => ({ title: String(w.title || w.uri).slice(0, 120), url: w.uri })),
  };
}

// --- Ollama -------------------------------------------------------------
async function ollama(cfg, req) {
  const messages = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  for (const m of req.messages) {
    if (m.role === 'user') {
      const msg = { role: 'user', content: m.text || '' };
      const images = (m.files || []).filter((f) => f.mime.startsWith('image/')).map((f) => f.base64);
      if (images.length) msg.images = images;
      messages.push(msg);
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.text || '' };
      if (m.calls && m.calls.length) msg.tool_calls = m.calls.map((c) => ({ function: { name: c.name, arguments: c.args || {} } }));
      messages.push(msg);
    } else if (m.role === 'tool') {
      m.results.forEach((r) => messages.push({ role: 'tool', tool_name: r.name, content: JSON.stringify(r.response) }));
    }
  }
  const options = { temperature: req.temperature ?? 0.2 };
  if (cfg.context_tokens) options.num_ctx = Number(cfg.context_tokens);
  if (req.maxTokens) options.num_predict = req.maxTokens;
  const body = { model: cfg.model, messages, stream: false, options };
  if (req.tools && req.tools.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  if (req.json) body.format = 'json';
  const data = await http(cfg, 'post', `${baseUrl(cfg)}/api/chat`, { data: body, timeoutMs: req.timeoutMs });
  const msg = data.message || {};
  return {
    text: String(msg.content || '').trim(),
    calls: (msg.tool_calls || []).map((c, i) => ({ id: `${(c.function || {}).name}-${i}`, name: (c.function || {}).name, args: parseArgs((c.function || {}).arguments) })),
    raw: { kind: 'ollama', message: msg },
    finish: data.done_reason || null,
    sources: [],
  };
}

// --- Anthropic (Claude) ---------------------------------------------------
async function anthropic(cfg, req) {
  const messages = [];
  for (const m of req.messages) {
    if (m.role === 'user') {
      const content = (m.files || []).map((f) => ({
        type: f.mime === 'application/pdf' ? 'document' : 'image',
        source: { type: 'base64', media_type: f.mime, data: f.base64 },
      }));
      content.push({ type: 'text', text: m.text || '' });
      messages.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      const content = m.raw && m.raw.kind === 'anthropic' ? m.raw.content
        : [...(m.text ? [{ type: 'text', text: m.text }] : []), ...(m.calls || []).map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} }))];
      messages.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      messages.push({ role: 'user', content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: JSON.stringify(r.response) })) });
    }
  }
  const body = { model: cfg.model, max_tokens: req.maxTokens || 4096, messages, temperature: req.temperature ?? 0.2 };
  if (req.system) body.system = req.system;
  if (req.tools && req.tools.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const data = await http(cfg, 'post', `${baseUrl(cfg)}/v1/messages`, {
    data: body, timeoutMs: req.timeoutMs,
    headers: { 'x-api-key': cfg.api_key || '', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
  });
  const blocks = data.content || [];
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim(),
    calls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} })),
    raw: { kind: 'anthropic', content: blocks },
    finish: data.stop_reason || null,
    sources: [],
  };
}

// --- Compatible con OpenAI ----------------------------------------------
async function openai(cfg, req) {
  const messages = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  for (const m of req.messages) {
    if (m.role === 'user') {
      const images = (m.files || []).filter((f) => f.mime.startsWith('image/'));
      messages.push({ role: 'user', content: images.length
        ? [...images.map((f) => ({ type: 'image_url', image_url: { url: `data:${f.mime};base64,${f.base64}` } })), { type: 'text', text: m.text || '' }]
        : (m.text || '') });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.text || '' };
      if (m.calls && m.calls.length) msg.tool_calls = m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
      messages.push(msg);
    } else if (m.role === 'tool') {
      m.results.forEach((r) => messages.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.response) }));
    }
  }
  const body = { model: cfg.model, messages, temperature: req.temperature ?? 0.2 };
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  if (req.tools && req.tools.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  if (req.json) body.response_format = { type: 'json_object' };
  const data = await http(cfg, 'post', `${baseUrl(cfg)}/chat/completions`, {
    data: body, timeoutMs: req.timeoutMs, headers: cfg.api_key ? { Authorization: `Bearer ${cfg.api_key}` } : {},
  });
  const choice = (data.choices || [])[0] || {};
  const msg = choice.message || {};
  return {
    text: String(msg.content || '').trim(),
    calls: (msg.tool_calls || []).map((c) => ({ id: c.id, name: (c.function || {}).name, args: parseArgs((c.function || {}).arguments) })),
    raw: { kind: 'openai', message: msg },
    finish: choice.finish_reason || null,
    sources: [],
  };
}

const CHAT = { gemini, ollama, anthropic, openai };

async function chat(cfg, req) {
  const fn = CHAT[cfg.kind];
  if (!fn) throw new AIError(`Tipo de proveedor desconocido: "${cfg.kind}".`);
  if (KINDS[cfg.kind].needsKey && !cfg.api_key) throw new AIError(`${name(cfg)}: falta la API key (Configuración > Inteligencia artificial).`);
  return fn(cfg, req);
}

// Modelos que ofrece el proveedor (para elegir sin escribir el nombre a mano).
async function listModels(cfg) {
  const opts = { timeoutMs: 15000 };
  if (cfg.kind === 'ollama') {
    const data = await http(cfg, 'get', `${baseUrl(cfg)}/api/tags`, opts);
    return (data.models || []).map((m) => ({ id: m.name, detail: [m.details && m.details.parameter_size, m.size ? `${(m.size / 1e9).toFixed(1)} GB` : null].filter(Boolean).join(' · ') }));
  }
  if (cfg.kind === 'gemini') {
    const data = await http(cfg, 'get', `${baseUrl(cfg)}/models?pageSize=1000`, { ...opts, headers: { 'x-goog-api-key': cfg.api_key || '' } });
    return (data.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({ id: String(m.name).replace(/^models\//, ''), detail: m.displayName || '' }));
  }
  if (cfg.kind === 'anthropic') {
    const data = await http(cfg, 'get', `${baseUrl(cfg)}/v1/models?limit=100`, { ...opts, headers: { 'x-api-key': cfg.api_key || '', 'anthropic-version': '2023-06-01' } });
    return (data.data || []).map((m) => ({ id: m.id, detail: m.display_name || '' }));
  }
  const data = await http(cfg, 'get', `${baseUrl(cfg)}/models`, { ...opts, headers: cfg.api_key ? { Authorization: `Bearer ${cfg.api_key}` } : {} });
  return (data.data || []).map((m) => ({ id: m.id, detail: '' }));
}

// Que sabe hacer el modelo. Ollama lo informa (/api/show); en la nube se
// conocen de antemano.
async function capabilities(cfg) {
  if (cfg.kind === 'ollama') {
    const data = await http(cfg, 'post', `${baseUrl(cfg)}/api/show`, { data: { model: cfg.model }, timeoutMs: 15000 });
    const caps = data.capabilities || [];
    const info = data.model_info || {};
    const ctxKey = Object.keys(info).find((k) => k.endsWith('.context_length'));
    return { tools: caps.includes('tools'), vision: caps.includes('vision'), web: false, maxContext: ctxKey ? Number(info[ctxKey]) : null, known: caps.length > 0 };
  }
  if (cfg.kind === 'gemini') return { tools: true, vision: true, web: true, known: true };
  if (cfg.kind === 'anthropic') return { tools: true, vision: true, web: false, known: true };
  return { tools: true, vision: false, web: false, known: false };
}

module.exports = { KINDS, AIError, chat, listModels, capabilities, baseUrl };
