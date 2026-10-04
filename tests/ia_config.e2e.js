// Prueba de la configuracion unica de IA (Configuracion > Inteligencia
// artificial): proveedores locales y en la nube, que usa cada funcion,
// eleccion por pregunta, respaldo, herramientas emuladas, lectura de
// facturas con un modelo local y el endpoint que usa DevOps Sidecar.
//
// Ollama y Gemini se SIMULAN con servidores locales que guardan lo que la
// aplicacion les envia. Los proveedores de prueba (PRUEBA-IA*) y los
// celulares marcados (IMEI 99000000000008x) se borran al final; la
// asignacion de usos va en memoria, sin tocar la configuracion guardada.
// Pide E2E_PERMITIR=1.
//
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/ia_config.e2e.js
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const PDFDocument = require('pdfkit');

if (process.env.E2E_PERMITIR !== '1') {
  console.error('Esta prueba escribe (y luego borra) datos marcados en la base configurada. Ejecútela con E2E_PERMITIR=1.');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const IMEI = ['990000000000081', '990000000000082'];
const AREA = 'PRUEBA-IA';
const results = [];
const check = (name, cond) => results.push([!!cond, name]);

// --- Ollama simulado
const ollama = { chats: [], script: [] };
const oSay = (content) => ({ model: 'x', message: { role: 'assistant', content }, done: true, done_reason: 'stop' });
const oCall = (name, args) => ({ model: 'x', message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: true, done_reason: 'stop' });
function fakeOllama() {
  const o = express();
  o.use(express.json({ limit: '20mb' }));
  o.get('/api/tags', (req, res) => res.json({ models: [
    { name: 'gemma4:26b', size: 18.6e9, details: { parameter_size: '25.8B' } }, { name: 'qwen3:8b', size: 5.2e9, details: { parameter_size: '8.2B' } }] }));
  o.post('/api/show', (req, res) => (req.body.model === 'gemma4:26b'
    ? res.json({ capabilities: ['completion', 'tools', 'vision'], model_info: { 'gemma4.context_length': 131072 } })
    : res.json({ capabilities: ['completion'], model_info: {} })));
  o.post('/api/chat', (req, res) => {
    ollama.chats.push(req.body);
    if (!['gemma4:26b', 'qwen3:8b'].includes(req.body.model)) return res.status(404).json({ error: `model "${req.body.model}" not found, try pulling it first` });
    res.json(ollama.script.shift() || oSay('OK'));
  });
  return o;
}

// --- Gemini simulado
const gem = { bodies: [] };
function fakeGemini() {
  const g = express();
  g.use(express.json({ limit: '20mb' }));
  g.get('/models', (req, res) => res.json({ models: [
    { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }] }));
  g.post(/^\/models\/([^/]+):generateContent$/, (req, res) => {
    if (req.headers['x-goog-api-key'] !== 'clave-gemini') return res.status(400).json({ error: { message: 'API key not valid' } });
    gem.bodies.push(req.body);
    res.json({ candidates: [{ content: { role: 'model', parts: [{ text: 'Respuesta desde Gemini.' }] }, finishReason: 'STOP' }] });
  });
  return g;
}

async function main() {
  const oServer = fakeOllama().listen(0);
  const gServer = fakeGemini().listen(0);
  const OLLAMA = `http://127.0.0.1:${oServer.address().port}`;
  const GEMINI = `http://127.0.0.1:${gServer.address().port}`;
  const env = require(path.join(ROOT, 'src/config/env'));
  env.ssoSharedSecret = 'secreto-compartido-de-prueba-0123456789';
  const pool = require(path.join(ROOT, 'src/db/pool'));
  const settingsService = require(path.join(ROOT, 'src/services/settingsService'));
  const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));
  let cfg = {};
  settingsService.getAll = async () => cfg; // en memoria, sin tocar la configuracion guardada
  settingsService.setMany = async (pairs) => { cfg = { ...cfg, ...pairs }; };
  const aiService = require(path.join(ROOT, 'src/services/aiService'));
  const assistantService = require(path.join(ROOT, 'src/services/assistantService'));
  const invoiceExtractor = require(path.join(ROOT, 'src/services/invoiceExtractor'));
  const ssoService = require(path.join(ROOT, 'src/services/ssoService'));

  const cleanup = async () => {
    await pool.query("DELETE FROM ai_providers WHERE label LIKE 'PRUEBA-IA%'");
    await pool.query('DELETE FROM mobile_devices WHERE imei IN (?)', [IMEI]);
    await pool.query("DELETE FROM audit_log WHERE action LIKE 'ia_%' AND (target LIKE 'PRUEBA-IA%' OR detail LIKE '%asistente=%')");
  };
  const [[admin]] = await pool.query("SELECT id, email, full_name, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  const [[logStart]] = await pool.query('SELECT COALESCE(MAX(id), 0) AS id FROM agent_message_log');
  // Los proveedores reales que ya existan se desactivan solo durante la prueba (para que no los elija).
  const [realActive] = await pool.query("SELECT id FROM ai_providers WHERE active = 1 AND label NOT LIKE 'PRUEBA-IA%'");
  await cleanup();
  if (realActive.length) await pool.query('UPDATE ai_providers SET active = 0 WHERE id IN (?)', [realActive.map((r) => r.id)]);

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.use('/interno/ia', require(path.join(ROOT, 'src/routes/internalAi')));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'e2e', resave: false, saveUninitialized: true }));
  app.use(flash());
  const CSRF = 'token-de-prueba-e2e-0123456789abcdef0123456789abcdef';
  app.use((req, res, next) => {
    req.session.user = admin;
    req.session.csrfToken = CSRF;
    Object.assign(res.locals, { currentUser: admin, csrfToken: CSRF, successMessages: req.flash('success'), errorMessages: req.flash('error'), currentPath: req.path,
      currentHost: req.hostname, appName: 'Prueba', enabledModules: new Proxy({}, { get: () => true }), mobileLabels });
    next();
  });
  app.use('/configuracion/ia', require(path.join(ROOT, 'src/routes/aiSettings')));
  app.use('/asistente', require(path.join(ROOT, 'src/routes/assistant')));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const keep = (r) => { const s = r.headers.get('set-cookie'); if (s) cookie = s.split(';')[0]; return r; };
  const get = async (u) => (keep(await fetch(base + u, { headers: { cookie } }))).text();
  const form = async (u, data) => {
    const body = new URLSearchParams({ _csrf: CSRF, ...data });
    const r = keep(await fetch(base + u, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }));
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  };
  const json = async (u, data, headers = {}) => {
    const r = await fetch(base + u, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const byLabel = async (label) => (await pool.query('SELECT * FROM ai_providers WHERE label = ?', [label]))[0][0];

  try {
    // --- Alta de proveedores desde la pantalla
    let r = await form('/configuracion/ia/proveedores', { label: 'PRUEBA-IA Local', kind: 'ollama', location: 'local', base_url: `${OLLAMA}/`, model: 'gemma4:26b',
      context_tokens: '16384', timeout_seconds: '60', active: 'on' });
    const local = await byLabel('PRUEBA-IA Local');
    check('Alta de un servidor Ollama: queda local, sin API key, con su contexto y sin la barra final', r.status === 302 && local && local.location === 'local'
      && local.base_url === OLLAMA && local.context_tokens === 16384 && !local.api_key && local.active === 1);
    r = await form('/configuracion/ia/proveedores', { label: 'PRUEBA-IA Nube', kind: 'gemini', base_url: GEMINI, model: 'gemini-2.5-flash', api_key: 'clave-gemini',
      supports_tools: 'on', supports_vision: 'on', supports_web: 'on', timeout_seconds: '30', active: 'on' });
    let nube = await byLabel('PRUEBA-IA Nube');
    check('Alta de Gemini: la API key se guarda cifrada y el tipo sugiere "nube"', nube && nube.location === 'nube' && nube.api_key.startsWith('enc:v1:')
      && !nube.api_key.includes('clave-gemini') && nube.supports_web === 1);
    r = await form(`/configuracion/ia/proveedores/${nube.id}`, { label: 'PRUEBA-IA Nube', kind: 'gemini', base_url: GEMINI, model: 'gemini-2.5-flash', api_key: '',
      supports_tools: 'on', supports_vision: 'on', supports_web: 'on', active: 'on' });
    nube = await byLabel('PRUEBA-IA Nube');
    check('Editar dejando la API key en blanco conserva la guardada', (await aiService.get(nube.id)).api_key === 'clave-gemini');
    r = await form('/configuracion/ia/proveedores', { label: 'PRUEBA-IA Mal', kind: 'gemini', model: 'Gemini 3 Flash-Lite', api_key: 'x', active: 'on' });
    check('Un nombre de modelo con espacios (como el que tenía Configuración) se rechaza con explicación', r.status === 302 && !(await byLabel('PRUEBA-IA Mal'))
      && (await get(r.location)).includes('identificador del modelo, sin espacios'));
    r = await form('/configuracion/ia/proveedores', { label: 'PRUEBA-IA SinClave', kind: 'anthropic', model: 'claude-sonnet-5', active: 'on' });
    check('Un proveedor en la nube que necesita API key no se guarda sin ella', !(await byLabel('PRUEBA-IA SinClave')));

    // --- Modelos y prueba
    let m = await json('/configuracion/ia/modelos', { _csrf: CSRF, kind: 'ollama', base_url: OLLAMA });
    check('"Cargar modelos" en Ollama: lista los descargados con su tamaño', m.status === 200 && m.json.models.map((x) => x.id).join() === 'gemma4:26b,qwen3:8b'
      && m.json.models[0].detail.includes('25.8B'));
    m = await json('/configuracion/ia/modelos', { _csrf: CSRF, id: nube.id, kind: 'gemini', base_url: GEMINI, api_key: '' });
    check('"Cargar modelos" en Gemini: usa la API key guardada y solo ofrece modelos que generan texto', m.status === 200 && m.json.models.map((x) => x.id).join() === 'gemini-2.5-flash');
    await pool.query('UPDATE ai_providers SET supports_tools = 0, supports_vision = 0 WHERE id = ?', [local.id]);
    r = await form(`/configuracion/ia/proveedores/${local.id}/probar`, {});
    const tested = await byLabel('PRUEBA-IA Local');
    check('"Probar": responde, y detecta en Ollama que el modelo tiene herramientas y visión', tested.last_test_ok === 1 && tested.supports_tools === 1 && tested.supports_vision === 1
      && tested.last_test_message.includes('Contexto máximo del modelo: 131.072') && ollama.chats.slice(-1)[0].options.num_ctx === 16384);
    let page = await get('/configuracion/ia');
    check('Pantalla: lista los proveedores con Local/Nube, lo que saben hacer y la última prueba', page.includes('PRUEBA-IA Local') && page.includes('PRUEBA-IA Nube')
      && page.includes('Herramientas · Imágenes') && page.includes('Responde (') && !page.includes('clave-gemini'));

    // --- Usos
    r = await form('/configuracion/ia/usos', { ai_uso_asistente: String(local.id), ai_uso_chatbot: String(local.id), ai_uso_facturas: String(local.id),
      ai_uso_sidecar_auditoria: String(local.id), ai_uso_sidecar_textos: String(local.id), ai_respaldo: '', ai_elegir_por_pregunta: 'on' });
    check('Asignación de usos: se guarda (local por defecto) con elección por pregunta', cfg.ai_uso_asistente === String(local.id) && cfg.ai_elegir_por_pregunta === 'true' && cfg.ai_respaldo === '');
    r = await form(`/configuracion/ia/proveedores/${local.id}/eliminar`, {});
    check('No se puede eliminar un proveedor en uso', !!(await byLabel('PRUEBA-IA Local')) && (await get(r.location)).includes('Está en uso'));

    // --- Asistente con el modelo local y herramientas nativas
    await pool.query('INSERT INTO mobile_devices (imei, asset_code, brand, model, area, sede, status) VALUES (?), (?)',
      [[IMEI[0], 'A-90081', 'ZTE', 'A75', AREA, 'SURCO', 'en_stock'], [IMEI[1], 'A-90082', 'ZTE', 'A75', AREA, 'SURCO', 'asignado']]);
    ollama.script = [oCall('consultar_datos', { reporte: 'celulares', filtros: [{ columna: 'area', valor: AREA }], agrupar_por: ['estado'] }), oSay('Hay 1 en stock y 1 asignado.')];
    let a = await json('/asistente/preguntar', { _csrf: CSRF, question: 'Celulares por estado [ia-e2e]', page: '/celulares' });
    let chats = ollama.chats.slice(-2);
    check('Asistente con Ollama: envía las herramientas en el formato de Ollama y el contexto configurado', a.status === 200 && chats[0].tools[0].type === 'function'
      && chats[0].tools[0].function.name === 'consultar_datos' && chats[0].tools[0].function.parameters.type === 'object' && chats[0].options.num_ctx === 16384
      && chats[0].messages[0].role === 'system');
    check('Con Gemini activo, el modelo local también puede buscar en internet (la búsqueda la hace Gemini)', chats[0].tools.map((t) => t.function.name).join() === 'consultar_datos,buscar_en_internet');
    const toolMsg = chats[1].messages.slice(-1)[0];
    check('El resultado de la consulta vuelve a Ollama como mensaje "tool", calculado por la aplicación', toolMsg.role === 'tool' && toolMsg.tool_name === 'consultar_datos'
      && JSON.parse(toolMsg.content).total_registros === 2 && chats[1].messages.slice(-2)[0].tool_calls[0].function.name === 'consultar_datos');
    check('Respuesta: texto del modelo local, la tabla y qué modelo respondió', a.json.answer === 'Hay 1 en stock y 1 asignado.' && a.json.tables[0].total === 2
      && a.json.provider.label === 'PRUEBA-IA Local' && a.json.provider.location === 'local' && !a.json.notice);

    await pool.query('UPDATE ai_providers SET active = 0 WHERE id = ?', [nube.id]);
    ollama.script = [oSay('Hola.')];
    await json('/asistente/preguntar', { _csrf: CSRF, question: 'Hola sin internet [ia-e2e]' });
    const noWeb = ollama.chats.slice(-1)[0];
    check('Sin proveedor de búsqueda activo, no se ofrece "buscar en internet" ni se promete en las instrucciones', noWeb.tools.length === 1
      && noWeb.messages[0].content.includes('no tienes búsqueda en internet'));
    await pool.query('UPDATE ai_providers SET active = 1 WHERE id = ?', [nube.id]);

    // --- Eleccion por pregunta
    let c = await json('/asistente/modelos', { _csrf: CSRF });
    check('El panel recibe los modelos para elegir, con el del asistente por defecto', c.json.allowed === true && c.json.defaultId === local.id
      && c.json.providers.some((p) => p.id === nube.id && p.location === 'nube') && c.json.webLabel === 'PRUEBA-IA Nube');
    const gBefore = gem.bodies.length;
    a = await json('/asistente/preguntar', { _csrf: CSRF, question: 'Hola [ia-e2e]', provider_id: nube.id });
    check('Si la persona elige la nube para una pregunta, responde Gemini', a.json.answer === 'Respuesta desde Gemini.' && a.json.provider.label === 'PRUEBA-IA Nube'
      && gem.bodies.length === gBefore + 1 && gem.bodies.slice(-1)[0].tools.length === 1 && gem.bodies.slice(-1)[0].tools[0].functionDeclarations.length === 2);
    cfg.ai_elegir_por_pregunta = 'false';
    a = await json('/asistente/preguntar', { _csrf: CSRF, question: 'Hola otra vez [ia-e2e]', provider_id: nube.id });
    check('Si la configuración no deja elegir, se ignora la elección y responde el asignado (local)', a.json.provider.label === 'PRUEBA-IA Local');
    cfg.ai_elegir_por_pregunta = 'true';

    // --- Herramientas emuladas (modelo sin herramientas nativas)
    await pool.query("UPDATE ai_providers SET model = 'qwen3:8b', supports_tools = 0 WHERE id = ?", [local.id]);
    ollama.script = [oSay(JSON.stringify({ herramienta: 'consultar_datos', argumentos: { reporte: 'celulares', filtros: [{ columna: 'area', valor: AREA }] } })),
      oSay(JSON.stringify({ respuesta: 'Son **2** equipos.' }))];
    a = await json('/asistente/preguntar', { _csrf: CSRF, question: 'Cuántos hay [ia-e2e]' });
    chats = ollama.chats.slice(-2);
    check('Modelo sin herramientas: se emulan pidiendo JSON, sin "tools" en la llamada', !chats[0].tools && chats[0].format === 'json'
      && chats[0].messages[0].content.includes('"herramienta"') && chats[0].messages[0].content.includes('consultar_datos'));
    check('Emuladas: la consulta igual la ejecuta la aplicación y la respuesta llega limpia', a.json.answer === 'Son **2** equipos.' && a.json.tables[0].total === 2
      && chats[1].messages.slice(-1)[0].content.startsWith('Resultado de consultar_datos:'));
    await pool.query("UPDATE ai_providers SET model = 'gemma4:26b', supports_tools = 1 WHERE id = ?", [local.id]);

    // --- Servidor local caido: respaldo
    await pool.query("UPDATE ai_providers SET base_url = 'http://127.0.0.1:9' WHERE id = ?", [local.id]);
    a = await json('/asistente/preguntar', { _csrf: CSRF, question: 'Hola caído [ia-e2e]' });
    check('Servidor local apagado y sin respaldo: error claro, sin pasar solo a la nube', a.status === 502 && a.json.error.includes('rechazó la conexión') && gem.bodies.length === gBefore + 1);
    cfg.ai_respaldo = String(nube.id);
    a = await json('/asistente/preguntar', { _csrf: CSRF, question: 'Hola caído con respaldo [ia-e2e]' });
    check('Con respaldo configurado: responde el respaldo y se avisa por qué', a.status === 200 && a.json.provider.label === 'PRUEBA-IA Nube'
      && a.json.notice.includes('PRUEBA-IA Local') && a.json.notice.includes('rechazó la conexión'));
    cfg.ai_respaldo = '';
    await pool.query('UPDATE ai_providers SET base_url = ? WHERE id = ?', [OLLAMA, local.id]);
    await pool.query("UPDATE ai_providers SET model = 'modelo-inexistente' WHERE id = ?", [local.id]);
    a = await json('/asistente/preguntar', { _csrf: CSRF, question: 'modelo no descargado [ia-e2e]' });
    check('Modelo no descargado en Ollama: dice cómo descargarlo o cambiarlo', a.status === 502 && a.json.error.includes('ollama pull modelo-inexistente'));
    await pool.query("UPDATE ai_providers SET model = 'gemma4:26b' WHERE id = ?", [local.id]);

    // --- Facturas con el modelo local
    const pdf = await new Promise((resolve) => {
      const doc = new PDFDocument();
      const parts = [];
      doc.on('data', (d) => parts.push(d));
      doc.on('end', () => resolve(Buffer.concat(parts)));
      doc.text('FACTURA ELECTRONICA F001-00999');
      doc.text('PROVEEDOR PRUEBA SAC  RUC 20123456789');
      doc.text('TOTAL A PAGAR S/ 1,234.50');
      doc.end();
    });
    ollama.script = [oSay(JSON.stringify({ monto: '1,234.50', moneda: 'pen', proveedor: 'PROVEEDOR PRUEBA SAC', numero_factura: 'F001-00999', fecha_emision: '03/10/2026' }))];
    const inv = await invoiceExtractor.extractInvoiceData(pdf, 'application/pdf');
    const invChat = ollama.chats.slice(-1)[0];
    check('Factura PDF con el modelo local: se le envía el TEXTO del PDF (no el archivo) y se pide JSON', invChat.format === 'json'
      && invChat.messages[0].content.includes('F001-00999') && invChat.messages[0].content.includes('Texto del documento') && !invChat.messages[0].images);
    check('Lo extraído se normaliza (monto número, moneda en mayúsculas, fecha mal formada descartada)', inv.monto === 1234.5 && inv.moneda === 'PEN'
      && inv.numero_factura === 'F001-00999' && inv.fecha_emision === null && inv._provider.label === 'PRUEBA-IA Local');
    ollama.script = [oSay('{"monto": 10}')];
    await invoiceExtractor.extractInvoiceData(Buffer.from('imagen'), 'image/png');
    check('Imagen con un modelo con visión: viaja como imagen a Ollama', ollama.chats.slice(-1)[0].messages[0].images[0] === Buffer.from('imagen').toString('base64'));
    await pool.query('UPDATE ai_providers SET supports_vision = 0 WHERE id = ?', [local.id]);
    let err = '';
    try { await invoiceExtractor.extractInvoiceData(Buffer.from('imagen'), 'image/png'); } catch (e) { err = e.message; }
    check('Imagen con un modelo sin visión: lo explica en vez de inventar', err.includes('no lee imágenes'));
    await pool.query('UPDATE ai_providers SET supports_vision = 1 WHERE id = ?', [local.id]);

    // --- Endpoint de DevOps Sidecar
    const pass = ssoService._sign({ aud: 'app-ai', exp: Math.floor(Date.now() / 1000) + 60, sub: 'devops-sidecar' });
    ollama.script = [oSay('## Auditoría\nSin hallazgos.')];
    let s = await json('/interno/ia/generar', { uso: 'sidecar_auditoria', prompt: 'Audita este diff' }, { authorization: `Bearer ${pass}` });
    check('Sidecar: genera con el proveedor asignado a la auditoría y dice cuál fue', s.status === 200 && s.json.text.includes('Sin hallazgos')
      && s.json.proveedor.label === 'PRUEBA-IA Local' && ollama.chats.slice(-1)[0].messages.slice(-1)[0].content === 'Audita este diff');
    s = await json('/interno/ia/generar', { uso: 'sidecar_auditoria', prompt: 'x' }, { authorization: `Bearer ${ssoService._sign({ aud: 'sidecar-api', exp: Math.floor(Date.now() / 1000) + 60 })}` });
    const s2 = await json('/interno/ia/generar', { uso: 'sidecar_auditoria', prompt: 'x' });
    const s3 = await json('/interno/ia/generar', { uso: 'sidecar_auditoria', prompt: 'x' }, { authorization: `Bearer ${ssoService._sign({ aud: 'app-ai', exp: 1 })}` });
    check('Sidecar: sin pase, con un pase para otra cosa o vencido, 401', s.status === 401 && s2.status === 401 && s3.status === 401);
    s = await json('/interno/ia/generar', { uso: 'asistente', prompt: 'x' }, { authorization: `Bearer ${pass}` });
    check('Sidecar: solo puede usar sus dos funciones', s.status === 400);
    const st = await fetch(`${base}/interno/ia/estado`, { headers: { authorization: `Bearer ${pass}` } }).then((x) => x.json());
    check('Sidecar: consulta qué proveedor usa cada una de sus funciones (sin API keys)', st.usos.sidecar_textos.label === 'PRUEBA-IA Local'
      && !JSON.stringify(st).includes('clave') && !('api_key' in st.usos.sidecar_textos));

    // --- Chatbot
    ollama.script = [oSay('{"tool": "desconocido", "args": {}}')];
    const chatAgent = require(path.join(ROOT, 'src/services/chatAgent'));
    if (typeof chatAgent.interpretQuestion === 'function') await chatAgent.interpretQuestion('hola');
    else await aiService.generateText('chatbot', 'Responde {"tool":"desconocido"}', { json: true });
    check('Chatbot: usa el proveedor asignado (local), pidiendo JSON', ollama.chats.slice(-1)[0].format === 'json' && ollama.chats.slice(-1)[0].model === 'gemma4:26b');
  } finally {
    server.close();
    oServer.close();
    gServer.close();
    await cleanup();
    if (realActive.length) await pool.query('UPDATE ai_providers SET active = 1 WHERE id IN (?)', [realActive.map((r) => r.id)]);
    await pool.query("DELETE FROM agent_message_log WHERE id > ? AND channel = 'web'", [logStart.id]);
    const [[left]] = await pool.query("SELECT (SELECT COUNT(*) FROM ai_providers WHERE label LIKE 'PRUEBA-IA%') + (SELECT COUNT(*) FROM mobile_devices WHERE imei IN (?)) AS n", [IMEI]);
    const [[back]] = await pool.query('SELECT COUNT(*) AS n FROM ai_providers WHERE active = 1');
    check('Limpieza: no quedan datos de prueba y los proveedores reales vuelven a estar activos', left.n === 0 && back.n === realActive.length);
    await pool.end();
  }
}

main()
  .catch((err) => { console.error(err); results.push([false, `Excepción: ${err.message}`]); })
  .finally(() => {
    for (const [ok, name] of results) console.log(`${ok ? 'PASA ' : 'FALLA'} ${name}`);
    const ok = results.filter((r) => r[0]).length;
    console.log(`\n${ok}/${results.length} pruebas correctas`);
    process.exit(ok === results.length ? 0 : 1);
  });
