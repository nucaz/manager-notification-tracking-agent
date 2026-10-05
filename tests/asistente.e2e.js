// Prueba de extremo a extremo del asistente ("Preguntar a la IA").
//
// Gemini se SIMULA con un servidor local (un proveedor de prueba en
// ai_providers, asignado al asistente solo en memoria) que sigue un guion (qué
// herramienta pide en cada paso) y guarda lo que la aplicación le envía:
// así se comprueba que los datos salen de la base y no de la IA, sin
// gastar la API real. Los celulares y chips de prueba sí se escriben en la
// base configurada, marcados (IMEI 99000000000007x, números 9000007xx,
// área PRUEBA-ASISTENTE) y se borran al final. Por eso pide E2E_PERMITIR=1.
//
// Uso (dentro del contenedor): E2E_PERMITIR=1 node tests/asistente.e2e.js
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const ExcelJS = require('exceljs');

if (process.env.E2E_PERMITIR !== '1') {
  console.error('Esta prueba escribe (y luego borra) datos marcados en la base configurada. Ejecútela con E2E_PERMITIR=1.');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const IMEI = ['990000000000071', '990000000000072', '990000000000073'];
const N = ['900000771', '900000772'];
const AREA = 'PRUEBA-ASISTENTE';
const results = [];
const check = (name, cond) => results.push([!!cond, name]);

// --- Gemini simulado
const seen = { bodies: [], search: null, model: null };
let script = []; // respuestas a dar, en orden, a las llamadas que no son de busqueda
const say = (text) => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
const call = (name, args) => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args }, thoughtSignature: 'firma-123' }] }, finishReason: 'STOP' }] });

function fakeGemini() {
  const g = express();
  g.use(express.json({ limit: '5mb' }));
  g.post(/^\/models\/([^/]+):generateContent$/, (req, res) => {
    seen.model = req.params[0];
    if (req.headers['x-goog-api-key'] !== 'clave-de-prueba') return res.status(400).json({ error: { message: 'API key not valid' } });
    if ((req.body.tools || []).some((t) => t.google_search)) {
      seen.search = req.body;
      return res.json({ candidates: [{
        content: { role: 'model', parts: [{ text: 'El ZTE Blade A75 tiene pantalla de 6,6" y batería de 5000 mAh.' }] },
        groundingMetadata: { groundingChunks: [{ web: { uri: 'https://ejemplo.com/zte-a75', title: 'ejemplo.com' } }, { web: { uri: 'https://ejemplo.com/zte-a75', title: 'ejemplo.com' } },
          { web: { uri: 'javascript:alert(1)', title: 'malo' } }] },
      }] });
    }
    seen.bodies.push(req.body);
    const next = script.shift();
    res.json(next || say('(sin guion)'));
  });
  return g;
}
// Lo que la aplicacion le devolvio a la IA en la ultima llamada (resultado de la herramienta).
const lastToolResponse = () => {
  const contents = seen.bodies[seen.bodies.length - 1].contents;
  return contents[contents.length - 1].parts[0].functionResponse.response;
};

async function main() {
  const gemini = fakeGemini().listen(0);
  const pool = require(path.join(ROOT, 'src/db/pool'));
  const settingsService = require(path.join(ROOT, 'src/services/settingsService'));
  const cryptoService = require(path.join(ROOT, 'src/services/cryptoService'));
  const mobileLabels = require(path.join(ROOT, 'src/config/mobileLabels'));
  await pool.query("DELETE FROM ai_providers WHERE label LIKE 'PRUEBA-IA%'");
  const [prov] = await pool.query('INSERT INTO ai_providers SET ?', [{ label: 'PRUEBA-IA Gemini', kind: 'gemini', location: 'nube',
    base_url: `http://127.0.0.1:${gemini.address().port}`, model: 'gemini-prueba', api_key: cryptoService.encrypt('clave-de-prueba'),
    supports_tools: 1, supports_vision: 1, supports_web: 1, timeout_seconds: 30 }]);
  const setKey = (k) => pool.query('UPDATE ai_providers SET api_key = ? WHERE id = ?', [k ? cryptoService.encrypt(k) : null, prov.insertId]);
  const cfg = { ai_uso_asistente: String(prov.insertId), ai_elegir_por_pregunta: 'true' };
  settingsService.getAll = async () => cfg; // configuracion en memoria, sin tocar la guardada
  const assistantService = require(path.join(ROOT, 'src/services/assistantService'));

  const cleanup = async () => {
    await pool.query('DELETE FROM mobile_lines WHERE phone_number IN (?)', [N]);
    await pool.query('DELETE FROM mobile_devices WHERE imei IN (?)', [IMEI]);
  };
  const [[admin]] = await pool.query("SELECT id, email, full_name, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  const [[logStart]] = await pool.query('SELECT COALESCE(MAX(id), 0) AS id FROM agent_message_log');
  await cleanup();

  let modules = new Proxy({}, { get: () => true });
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'e2e', resave: false, saveUninitialized: true }));
  app.use(flash());
  const CSRF = 'token-de-prueba-e2e-0123456789abcdef0123456789abcdef';
  app.use((req, res, next) => {
    req.session.user = admin;
    req.session.csrfToken = CSRF;
    Object.assign(res.locals, { currentUser: admin, csrfToken: CSRF, successMessages: [], errorMessages: [], currentPath: req.path,
      currentHost: req.hostname, appName: 'Prueba', enabledModules: modules, mobileLabels });
    next();
  });
  app.use('/asistente', require(path.join(ROOT, 'src/routes/assistant')));
  app.use('/reportes', require(path.join(ROOT, 'src/routes/reports')));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (url, body) => {
    const r = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const textBody = await r.text();
    let json = null;
    try { json = JSON.parse(textBody); } catch (_) { /* no es JSON */ }
    return { status: r.status, json, text: textBody };
  };
  const preguntar = (question, extra) => post('/asistente/preguntar', { _csrf: CSRF, question, page: '/celulares', ...extra });

  try {
    await pool.query('INSERT INTO mobile_devices (imei, asset_code, brand, model, area, sede, status) VALUES (?), (?), (?)',
      [[IMEI[0], 'A-90071', 'ZTE', 'A75', AREA, 'Sede Ñandú', 'asignado'], [IMEI[1], 'A-90072', 'ZTE', 'A75', AREA, 'Sede Ñandú', 'en_stock'],
        [IMEI[2], 'A-90073', 'Oppo', 'A58', AREA, null, 'en_stock']]);
    await pool.query('INSERT INTO mobile_lines (phone_number, operadora, costo_plan, descuento_plan, estado) VALUES (?), (?)',
      [[N[0], 'Entel', 29.9, 5, 'activo'], [N[1], 'Entel', 39.9, null, 'activo']]);

    // --- Pregunta sobre los datos: stock por sede
    script = [
      call('consultar_datos', { reporte: 'celulares', filtros: [{ columna: 'estado', valor: 'en stock' }, { columna: 'Área', valor: AREA.toLowerCase() }], agrupar_por: ['sede'] }),
      say('Hay **2** celulares en stock: 1 en Sede Ñandú y 1 sin sede.'),
    ];
    let r = await preguntar('Stock de celulares por sede [e2e]');
    const first = seen.bodies[0];
    const tool = lastToolResponse();
    check('La pregunta llega a Gemini con el catálogo de datos y las dos herramientas (consultar y buscar en internet)', r.status === 200 && seen.model === 'gemini-prueba'
      && first.systemInstruction.parts[0].text.includes('celulares — Celulares (equipos)') && first.systemInstruction.parts[0].text.includes('asset_code (Código)')
      && first.systemInstruction.parts[0].text.includes('/celulares') && first.tools[0].functionDeclarations.map((d) => d.name).join() === 'consultar_datos,buscar_en_internet'
      && first.tools[0].functionDeclarations[0].parameters.properties.reporte.enum.includes('glpi_computadoras'));
    check('La consulta la ejecuta la aplicación: a la IA se le devuelve el conteo real, agrupado por sede', tool.total_registros === 2
      && JSON.stringify(tool.grupos) === JSON.stringify([['Sede Ñandú', 1], ['Sin dato', 1]]) && tool.columnas.join() === 'Sede,Cantidad');
    check('El filtro no distingue mayúsculas ni acentos, y acepta la columna por su título ("Área")', tool.total_registros === 2);
    const turn2 = seen.bodies[1].contents;
    check('El turno de la IA se devuelve tal cual, con su firma (lo exige la API de Gemini)', turn2[turn2.length - 2].role === 'model'
      && turn2[turn2.length - 2].parts[0].thoughtSignature === 'firma-123' && turn2[turn2.length - 2].parts[0].functionCall.name === 'consultar_datos');
    const t = r.json.tables[0];
    check('Respuesta al navegador: texto de la IA y la tabla calculada por la aplicación', r.json.ok && r.json.answer.includes('**2**') && r.json.tables.length === 1
      && t.title.includes('Celulares (equipos) por sede') && JSON.stringify(t.rows) === JSON.stringify([['Sede Ñandú', 1], ['Sin dato', 1]]) && t.total === 2);
    check('La tabla trae el enlace al mismo resultado en Reportes (para el PDF con código de barras)',
      t.reportUrl === `/reportes?modulo=celulares&f_estado=En+stock&f_area=${AREA}`);
    const rep = await (await fetch(base + t.reportUrl)).text();
    check('Ese enlace abre el reporte con los mismos 2 registros', rep.includes('id="reporte_total">2<') && rep.includes(IMEI[1]) && !rep.includes(IMEI[0]));

    // --- Excel de la tabla
    const x = await fetch(`${base}/asistente/exportar`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: CSRF, spec: JSON.stringify(t.spec) }).toString() });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await x.arrayBuffer()));
    const sheet = wb.worksheets[0];
    check('Descargar Excel: vuelve a ejecutar la consulta y entrega la tabla', x.status === 200 && sheet.getRow(4).values.slice(1).join() === 'Sede,Cantidad'
      && sheet.getRow(5).values.slice(1).join() === 'Sede Ñandú,1' && String(sheet.getRow(1).values[1]).includes('Celulares (equipos) por sede'));

    // --- Reporte temporal y PDF de esa misma tabla
    const form = (url, extra) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: CSRF, ...extra }).toString() });
    const listSpec = JSON.stringify({ reporte: 'celulares', filtros: [{ columna: 'area', valor: AREA }], columnas: ['asset_code', 'imei', 'model', 'estado'], ordenar_por: 'asset_code', descendente: true });
    let rp = await form('/asistente/reporte', { spec: listSpec });
    let html = await rp.text();
    check('Abrir como reporte: página completa con la tabla, sus exportaciones y el aviso de que no se guarda', rp.status === 200 && html.includes('Reporte temporal')
      && html.includes('id="reporte_temporal_total">3<') && html.includes(IMEI[0]) && html.includes('No se guarda') && html.includes('value="pdf"') && html.includes('value="xlsx"')
      && html.indexOf('A-90073') < html.indexOf('A-90071'));
    check('El reporte temporal de un inventario ofrece el código de barras para el PDF', html.includes('name="barras"') && html.includes('<option value="imei">IMEI</option>'));
    rp = await form('/asistente/exportar', { spec: listSpec, formato: 'pdf', barras: 'imei' });
    const pdfBuffer = Buffer.from(await rp.arrayBuffer());
    const pdfText = (await require(path.join(ROOT, 'src/services/mobileBillParsers/pdfText')).extractLines(pdfBuffer)).join(' ');
    check('PDF del reporte temporal: con los datos, el código de barras por fila y el cierre de verificación', rp.headers.get('content-type') === 'application/pdf'
      && pdfBuffer.slice(0, 5).toString() === '%PDF-' && pdfText.includes('Código de barras (IMEI)') && IMEI.every((i) => pdfText.includes(i)) && pdfText.includes('A-90071')
      && pdfText.includes('Encontrados: ________ de 3'));
    rp = await form('/asistente/reporte', { spec: JSON.stringify(t.spec) });
    html = await rp.text();
    check('Reporte temporal de un resumen (agrupado): sin código de barras y con enlace a Reportes', html.includes('resumidos en 2 fila(s)') && !html.includes('name="barras"')
      && html.includes('Ver el mismo resultado en Reportes'));
    rp = await form('/asistente/reporte', { spec: JSON.stringify({ reporte: 'usuarios; DROP TABLE users' }) });
    check('Un reporte temporal con una consulta inválida se rechaza con explicación', rp.status === 400 && (await rp.text()).includes('no existe o este usuario no tiene acceso'));

    // --- Mas datos consultables, orden y tope
    const top = await assistantService.runQuery(assistantService.datasets(admin, new Proxy({}, { get: () => true })),
      { reporte: 'chips', buscar: '9000007', columnas: ['phone_number', 'neto'], ordenar_por: 'neto', descendente: true, limite: 1 });
    check('"Los N más...": ordenar de mayor a menor y quedarse con los primeros', top.rows.length === 1 && top.rows[0][0] === N[1] && top.rows[0][1] === '39.90' && top.total === 2);
    const full = assistantService.datasets(admin, new Proxy({}, { get: () => true }));
    check('El asistente puede consultar también asignaciones, incidentes, recibos, catálogos, adjuntos, diagramas y (admin) usuarios y auditoría',
      ['empleados', 'asignaciones_celulares', 'incidentes_celulares', 'recibos', 'recibos_lineas', 'recibos_cargos', 'catalogos', 'adjuntos', 'diagramas_red', 'usuarios', 'auditoria'].every((k) => full[k]));
    const usuarios = await assistantService.runQuery(full, { reporte: 'usuarios' });
    const dumpUsers = JSON.stringify(usuarios.rows) + usuarios.columns.join();
    check('Usuarios: se ven nombre, rol y estado, nunca contraseñas ni secretos de 2FA', usuarios.total >= 1 && usuarios.columns.join() === 'Nombre,Correo,Rol,Activo,2FA activo,Bloqueado,Creado el'
      && !/password|hash|otp_secret|\$2[aby]\$/i.test(dumpUsers));
    for (const k of ['asignaciones_celulares', 'incidentes_celulares', 'recibos', 'recibos_lineas', 'recibos_cargos', 'catalogos', 'adjuntos', 'diagramas_red', 'auditoria']) {
      await assistantService.runQuery(full, { reporte: k, limite: 3 }); // cada consulta nueva corre contra la base real sin error
    }
    check('Todas las consultas nuevas corren contra la base real', true);
    const editorSets = assistantService.datasets({ role: 'editor' }, new Proxy({}, { get: () => true }));
    check('Usuarios y auditoría son solo para administradores', !editorSets.usuarios && !editorSets.auditoria && editorSets.catalogos && editorSets.recibos);
    const prompt = assistantService._systemPrompt(full, '/celulares', admin);
    check('Instrucciones a la IA: libertad para conversar, consultar, armar reportes y buscar; prohibido crear, cambiar o borrar e inventar datos',
      prompt.includes('No te limites a esta aplicación') && prompt.includes('Crear, cambiar o borrar datos de la aplicación. No tienes ninguna herramienta para eso')
      && prompt.includes('Inventar datos de la empresa'));

    // --- Un filtro que no existe: la aplicacion dice que valores hay y la IA corrige
    script = [
      call('consultar_datos', { reporte: 'celulares', filtros: [{ columna: 'area', valor: AREA }, { columna: 'estado', valor: 'disponible' }] }),
      call('consultar_datos', { reporte: 'celulares', filtros: [{ columna: 'area', valor: AREA }, { columna: 'estado', valor: 'En stock' }], columnas: ['asset_code', 'imei', 'model'] }),
      say('Hay 2 equipos en stock.'),
    ];
    r = await preguntar('Lista los celulares disponibles [e2e]', { history: [{ q: 'Stock de celulares por sede [e2e]', a: 'Hay 2 celulares en stock.' }] });
    const aviso = seen.bodies[seen.bodies.length - 2].contents.slice(-1)[0].parts[0].functionResponse.response;
    check('Filtro sin coincidencias: la aplicación le indica a la IA qué valores existen', aviso.total_registros === 0 && aviso.avisos[0].includes('"disponible"')
      && aviso.avisos[0].includes('En stock') && aviso.avisos[0].includes('Asignado'));
    check('Tras corregir, al usuario solo se le muestra la consulta que sirvió, con las columnas pedidas', r.json.tables.length === 1 && r.json.tables[0].total === 2
      && r.json.tables[0].columns.join() === 'Código,IMEI,Modelo' && r.json.tables[0].rows.some((row) => row[1] === IMEI[1]) && r.json.tables[0].rows.every((row) => row[1] !== IMEI[0]));
    const withHistory = seen.bodies[seen.bodies.length - 3].contents;
    check('La conversación anterior viaja con la pregunta (para preguntas de seguimiento)', withHistory.length === 3 && withHistory[0].role === 'user'
      && withHistory[1].role === 'model' && withHistory[1].parts[0].text === 'Hay 2 celulares en stock.');

    // --- Sumas
    script = [call('consultar_datos', { reporte: 'chips', buscar: '9000007', agrupar_por: ['operadora'], sumar: ['costo', 'neto'] }), say('Se pagan S/ 64.80.')];
    r = await preguntar('¿Cuánto se paga en chips por operadora? [e2e]');
    check('Sumas por grupo: costo del plan y lo que se paga (con descuento)', JSON.stringify(r.json.tables[0].rows) === JSON.stringify([['Entel', 2, 69.8, 64.8]])
      && r.json.tables[0].columns.join() === 'Operadora,Cantidad,Suma de Costo del plan,Suma de Se paga');

    // --- Datos personales: la IA en la nube no los recibe; el usuario si
    script = [call('consultar_datos', { reporte: 'chips', buscar: '9000007', columnas: ['phone_number', 'operadora'], ordenar_por: 'phone_number' }), say('Dos chips.')];
    r = await preguntar('Números de los chips de prueba [e2e]');
    const masked = lastToolResponse();
    check('Nube (Gemini): los números van a la IA como "[dato personal oculto]", la operadora tal cual', JSON.stringify(masked.filas) === JSON.stringify([['[dato personal oculto]', 'Entel'], ['[dato personal oculto]', 'Entel']])
      && !JSON.stringify(seen.bodies.slice(-1)[0]).includes(N[0]));
    check('…y el usuario ve la tabla con los números reales', JSON.stringify(r.json.tables[0].rows) === JSON.stringify([[N[0], 'Entel'], [N[1], 'Entel']]));
    check('Las instrucciones a una IA en la nube avisan que los datos personales llegan ocultos', seen.bodies.slice(-1)[0].systemInstruction.parts[0].text.includes('te llegan como "[dato personal oculto]"'));

    // --- Busqueda en internet
    script = [call('buscar_en_internet', { consulta: 'ZTE Blade A75 características' }), say('El ZTE A75 tiene batería de 5000 mAh.')];
    r = await preguntar('Busca en internet las características del ZTE A75 [e2e]');
    check('Buscar en internet: llamada aparte a Gemini con la búsqueda de Google activada', seen.search && seen.search.tools[0].google_search
      && seen.search.contents[0].parts[0].text.includes('ZTE Blade A75 características') && lastToolResponse().resultado.includes('5000 mAh'));
    check('Las fuentes llegan al navegador sin repetir y solo si son enlaces http(s)', r.json.sources.length === 1 && r.json.sources[0].url === 'https://ejemplo.com/zte-a75'
      && r.json.answer.includes('5000 mAh') && r.json.tables.length === 0);

    // --- Lo que la IA pida mal no rompe nada
    script = [call('consultar_datos', { reporte: 'celulares', agrupar_por: ['clave_secreta'] }), call('borrar_todo', {}), call('consultar_datos', { reporte: 'tabla_secreta' }), say('No pude.')];
    r = await preguntar('Prueba de errores [e2e]');
    const errs = seen.bodies.slice(-3).map((b) => b.contents.slice(-1)[0].parts[0].functionResponse.response.error);
    check('Columna, herramienta o reporte inexistentes: se le informa el error a la IA, sin fallar ni tocar nada', r.status === 200 && r.json.answer === 'No pude.'
      && errs[0].includes('"clave_secreta" no existe') && errs[1].includes('"borrar_todo" no existe') && errs[2].includes('"tabla_secreta" no existe o este usuario no tiene acceso'));

    // --- Limite de pasos
    script = Array.from({ length: 12 }, () => call('consultar_datos', { reporte: 'celulares', filtros: [{ columna: 'area', valor: AREA }], agrupar_por: ['estado'] }));
    const before = seen.bodies.length;
    r = await preguntar('Bucle [e2e]');
    check('Una IA que no termina de pedir datos se corta a los 8 pasos y se muestra lo encontrado', seen.bodies.length - before === 8 && r.json.ok
      && r.json.answer === 'Esto es lo que encontré en los datos:' && r.json.tables.length === 3);
    script = [];

    // --- Permisos
    const lector = { id: admin.id, email: 'lector@prueba', full_name: 'Lector', role: 'lector' };
    script = [call('consultar_datos', { reporte: 'celulares' }), call('consultar_datos', { reporte: 'repositorios' }), say('Sin acceso.')];
    const sinAcceso = await assistantService.ask({ question: 'celulares', user: lector, enabledModules: { asistente: true, celulares: false, glpi_inventario: true } });
    const decl = seen.bodies[seen.bodies.length - 3].tools[0].functionDeclarations[0].parameters.properties.reporte.enum;
    check('Un rol sin el módulo Celulares: la IA ni ve esos datos en su catálogo ni puede consultarlos', !decl.includes('celulares') && !decl.includes('chips')
      && !decl.includes('repositorios') && !decl.includes('empleados') && decl.includes('glpi_computadoras') && sinAcceso.tables.length === 0
      && seen.bodies[seen.bodies.length - 2].contents.slice(-1)[0].parts[0].functionResponse.response.error.includes('no tiene acceso')
      && !seen.bodies[seen.bodies.length - 3].systemInstruction.parts[0].text.includes('Celulares (equipos)'));
    modules = { asistente: false };
    r = await preguntar('hola');
    check('Rol sin el asistente habilitado: 403 con explicación', r.status === 403 && r.json.error.includes('no tiene habilitado el asistente'));
    modules = new Proxy({}, { get: () => true });
    r = await post('/asistente/preguntar', { question: 'hola' });
    check('Sin el token de la sesión (CSRF): 403', r.status === 403 && r.json.ok === false);
    r = await preguntar('   ');
    check('Pregunta vacía: 400', r.status === 400);

    // --- Errores de Gemini
    await setKey('otra');
    r = await preguntar('¿Cuántos celulares hay? [e2e]');
    check('Gemini rechaza la API key: el error se muestra tal cual, sin la clave', r.status === 502 && r.json.error.includes('HTTP 400') && r.json.error.includes('API key not valid')
      && !r.json.error.includes('otra'));
    await setKey('');
    r = await preguntar('¿Cuántos celulares hay? [e2e]');
    check('Sin API key de Gemini: dice dónde configurarla', r.status === 502 && r.json.error.includes('falta la API key (Configuración > Inteligencia artificial)'));
    await setKey('clave-de-prueba');

    // --- Historial y pantalla
    const [logs] = await pool.query("SELECT direction, contact, message_text FROM agent_message_log WHERE id > ? AND channel = 'web' ORDER BY id", [logStart.id]);
    check('Preguntas y respuestas quedan en el Historial de chat (canal web, con el correo del usuario)', logs.length >= 12 && logs[0].direction === 'entrante'
      && logs[0].message_text === 'Stock de celulares por sede [e2e]' && logs[1].direction === 'saliente' && logs[1].message_text.includes('**2**') && logs[0].contact === admin.email.slice(0, 100));
    let page = await (await fetch(`${base}/reportes`)).text();
    check('El botón "Preguntar a la IA" está en las pantallas', page.includes('id="ia_panel"') && page.includes('/js/asistente.js') && page.includes(`data-csrf="${CSRF}"`));
    modules = { reportes: true, asistente: false };
    page = await (await fetch(`${base}/reportes`)).text();
    check('Sin el permiso del asistente, el botón no aparece', !page.includes('id="ia_panel"') && !page.includes('/js/asistente.js'));
    modules = new Proxy({}, { get: () => true });

    // --- Limite de uso (al final: agota el cupo del minuto)
    script = [];
    let limited = null;
    for (let i = 0; i < 14 && !limited; i++) { const a = await preguntar(`hola ${i} [e2e]`); if (a.status === 429) limited = a; }
    check('Más de 12 preguntas en un minuto: se pide esperar', limited && limited.json.error.includes('Demasiadas preguntas'));
  } finally {
    server.close();
    gemini.close();
    await cleanup();
    await pool.query("DELETE FROM ai_providers WHERE label LIKE 'PRUEBA-IA%'");
    await pool.query("DELETE FROM agent_message_log WHERE id > ? AND channel = 'web'", [logStart.id]);
    const [[left]] = await pool.query('SELECT (SELECT COUNT(*) FROM mobile_devices WHERE imei IN (?)) + (SELECT COUNT(*) FROM mobile_lines WHERE phone_number IN (?)) AS n', [IMEI, N]);
    check('Limpieza: no quedan datos de prueba', left.n === 0);
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
