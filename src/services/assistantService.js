// Asistente dentro de la aplicacion ("Preguntar a la IA"): conversa
// libremente, responde sobre lo que hay en la base de datos, arma
// reportes temporales y busca en internet.
//
// Tiene libertad para LEER, no para escribir. Como el agente de
// WhatsApp/Telegram, la IA nunca escribe SQL ni toca la base: elige entre
// herramientas fijas de solo lectura, y no existe ninguna herramienta que
// cree, cambie o borre datos.
//   - consultar_datos: pide datos del catalogo (los reportes de Reportes
//     mas empleados, asignaciones, incidentes, recibos, catalogos,
//     adjuntos, diagramas y - solo admin - usuarios y auditoria) con
//     filtros, agrupacion, sumas, orden y tope. La consulta la ejecuta la
//     aplicacion; los numeros que ve el usuario salen de aqui, no de la
//     IA, y la tabla se le muestra completa.
//   - buscar_en_internet: una busqueda de Google hecha por Gemini (solo se
//     ofrece si hay un proveedor activo con busqueda).
// Solo se ofrecen los datos que el usuario puede abrir.
//
// El modelo es el asignado al asistente en Configuracion > Inteligencia
// artificial (por defecto el servidor local), o el que la persona elija
// para esa pregunta. Ver src/services/aiService.js.
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const aiService = require('./aiService');
const reportService = require('./reportService');
// Que datos hay y como se consultan (SQL con lista blanca, en MariaDB):
const { datasets, runQuery, forModel, MODES, REPORT_ROWS, HIDDEN } = require('./assistantData');

const MAX_STEPS = 8;        // idas y vueltas con la IA por pregunta
const MODEL_ROWS = 40;      // filas de un listado que se le pasan a la IA
const MODEL_GROUPS = 80;    // grupos de un resumen que se le pasan a la IA
const MAX_TABLES = 3;

const text = (value) => (value === null || value === undefined ? '' : String(value));

// Busqueda en internet: una llamada aparte a Gemini con la busqueda de
// Google activada (no se puede combinar con las otras herramientas en la
// misma llamada).
async function webSearch(query) {
  const found = await aiService.webSearch(query);
  return { answer: found.answer, sources: found.sources };
}

// Esquema JSON comun; cada proveedor lo traduce a su formato (ai/providers.js).
function toolDeclarations(sets, web = true) {
  const names = { type: 'array', items: { type: 'string' } };
  const tools = [{
    name: 'consultar_datos',
    description: 'Consulta los datos reales de la aplicación (solo lectura). Devuelve el total de registros y, según se pida, un resumen agrupado (cantidades y sumas) o un listado de filas. La tabla completa se le muestra al usuario automáticamente y puede abrirla como reporte, en Excel o en PDF.',
    parameters: {
      type: 'object',
      properties: {
        reporte: { type: 'string', enum: Object.keys(sets), description: 'Qué datos consultar.' },
        filtros: {
          type: 'array',
          description: 'Condiciones que deben cumplirse todas.',
          items: {
            type: 'object',
            properties: {
              columna: { type: 'string', description: 'Clave de la columna.' },
              modo: { type: 'string', enum: MODES, description: 'igual (predeterminado; no distingue mayúsculas ni acentos), contiene, distinto, vacio, no_vacio, menor_que, mayor_que (números o fechas AAAA-MM-DD).' },
              valor: { type: 'string' },
            },
            required: ['columna'],
          },
        },
        buscar: { type: 'string', description: 'Texto a buscar en cualquier columna.' },
        agrupar_por: { ...names, description: 'Claves de columna para contar por grupo (ej. ["sede"] o ["area","estado"]). Úselo para "cuántos hay por...".' },
        sumar: { ...names, description: 'Claves de columnas numéricas a sumar (ej. costos).' },
        columnas: { ...names, description: 'Para listados: qué columnas mostrar.' },
        ordenar_por: { type: 'string', description: 'Columna por la que ordenar. En resúmenes también vale "cantidad" o el título de una suma.' },
        descendente: { type: 'boolean', description: 'true = de mayor a menor.' },
        limite: { type: 'integer', description: 'Quedarse solo con los primeros N (para "los 10 más...").' },
      },
      required: ['reporte'],
    },
  }];
  if (web) {
    tools.push({
      name: 'buscar_en_internet',
      description: 'Busca en internet (Google): características de un modelo de equipo, una tecnología, versiones, fin de soporte, precios de referencia, noticias, documentación, cómo hacer algo. Úsela con libertad cuando la respuesta dependa de información actual o externa.',
      parameters: { type: 'object', properties: { consulta: { type: 'string', description: 'Qué buscar, con el modelo o tecnología exactos.' } }, required: ['consulta'] },
    });
  }
  return tools;
}

function systemPrompt(sets, page, user, web = true, local = true) {
  const catalog = Object.entries(sets).map(([key, d]) => `- ${key} — ${d.label}. Columnas: ${d.columns.map((c) => `${c.key} (${c.label}${c.personal ? ', dato personal' : ''})`).join(', ')}.`).join('\n');
  return `Eres el asistente de una aplicación interna de gestión de TI (licencias, dominios, contratos ISP, servidores, certificados, celulares y chips, recibos de operadoras, inventario de GLPI, empleados, repositorios). Conversas en español con ${user.full_name || 'un usuario'} (rol ${user.role}), con naturalidad y sin rodeos.

Hoy es ${new Date().toISOString().slice(0, 10)}.${page ? ` El usuario está viendo la pantalla ${page}.` : ''}

Qué puedes hacer, con libertad:
- Conversar, explicar, comparar, recomendar y razonar sobre cualquier tema que el usuario plantee (tecnología, gestión de TI, redacción, cálculos, lo que necesite). No te limites a esta aplicación.
- Consultar los datos de la aplicación con consultar_datos tantas veces como haga falta, cruzando varios reportes si la pregunta lo pide, y sacar conclusiones propias (tendencias, anomalías, lo que conviene revisar).
- Armar reportes: cada consulta produce una tabla que el usuario ve debajo de tu respuesta y puede abrir como reporte temporal, descargar en Excel o en PDF. Si pide "un reporte de...", haz la consulta que lo produce y dile que lo abra con esos botones.
${web ? '- Buscar en internet con buscar_en_internet cuando ayude: modelos, tecnologías, precios, fin de soporte, documentación, novedades. Puedes combinar: consultar qué hay y luego buscar sobre eso.'
    : '- En esta configuración no tienes búsqueda en internet: lo que sepas de afuera dilo como conocimiento general, que puede no estar al día.'}

Lo único que no puedes hacer:
- Crear, cambiar o borrar datos de la aplicación. No tienes ninguna herramienta para eso. Si te lo piden, dilo y explica en qué pantalla lo hace el usuario.
- Inventar datos de la empresa. Cifras, nombres, códigos y estados salen solo de consultar_datos; si no lo consultaste, no lo afirmes. Lo que sepas por conocimiento general o por internet, dilo como tal.

Cómo consultar bien:
- Para "cuántos", "stock", "por área", "por sede", "por operadora": usa agrupar_por. Para montos: sumar. Para "los N más...": ordenar_por con descendente y limite. El stock de celulares es estado "En stock".
- Si un filtro no encuentra nada, la herramienta te dice qué valores existen: corrige y vuelve a consultar antes de responder.
- No repitas la tabla entera en el texto: resume lo importante (totales, lo más alto, lo llamativo) y deja el detalle a la tabla.
${local ? (web ? '- No pongas datos personales (nombres, DNI, números, correos) en buscar_en_internet: la búsqueda sale de la empresa.\n' : '')
    : `- Respondes desde un servicio en la nube: los datos personales (nombres, DNI, números de celular, correos) te llegan como "${HIDDEN}". El usuario sí los ve en la tabla. No intentes deducirlos ni los pidas; refiérete a "la persona" o a la fila.\n`}
Datos disponibles para este usuario:
${catalog}`;
}

// { question, history: [{ q, a }], page, user, enabledModules, providerId }
//   -> { answer, tables: [...], sources: [...], provider: { label, location, model }, notice }
async function ask({ question, history = [], page = '', user, enabledModules, providerId = null }) {
  const sets = datasets(user, enabledModules);
  const tables = [];
  const sources = [];
  const messages = [];
  history.slice(-6).forEach((turn) => {
    if (!turn || !turn.q || !turn.a) return;
    messages.push({ role: 'user', text: text(turn.q).slice(0, 2000) });
    messages.push({ role: 'assistant', text: text(turn.a).slice(0, 2000) });
  });
  messages.push({ role: 'user', text: text(question).slice(0, 2000) });
  const web = !!(await aiService.webSearchProvider());
  // Local o nube cambia lo que se le manda (datos personales): se sabe antes
  // de la primera llamada y, si responde el respaldo, desde ahi se ajusta.
  const first = await aiService.resolve('asistente', providerId);
  const isLocal = (p) => !!p && p.location === 'local';
  const reqFor = (p) => ({ system: systemPrompt(sets, text(page).slice(0, 80), user, web, isLocal(p)), tools: toolDeclarations(sets, web), temperature: 0.4 });

  let answer = '';
  let provider = null;  // el de la primera respuesta; los pasos siguientes siguen con el mismo
  let info = null;
  let notice = null;
  for (let step = 0; step < MAX_STEPS; step++) {
    const r = await aiService.chat('asistente', { ...reqFor(provider || first), messages }, provider ? { provider } : { providerId });
    provider = r.resolved;
    info = r.provider;
    if (r.fellBackFrom) notice = `No respondió el proveedor elegido (${r.fellBackFrom}); respondió ${info.label}.`;
    if (!r.calls.length) {
      answer = r.text;
      if (!answer && r.finish && !['STOP', 'stop', 'end_turn'].includes(r.finish)) {
        answer = `La IA no completó la respuesta (motivo: ${r.finish}). Intente reformular la pregunta.`;
      }
      break;
    }
    // El turno de la IA se devuelve tal cual (Gemini exige de vuelta sus firmas).
    messages.push({ role: 'assistant', text: r.text, calls: r.calls, raw: r.raw });
    const responses = [];
    for (const call of r.calls) {
      const { name, args } = call;
      let response;
      try {
        if (name === 'consultar_datos') {
          const result = await runQuery(sets, args);
          tables.push(result);
          response = {
            total_registros: result.total, columnas: result.columns,
            [result.grouped ? 'grupos' : 'filas']: forModel(result, result.rows.slice(0, result.grouped ? MODEL_GROUPS : MODEL_ROWS), isLocal(provider)),
            ...(result.lines > (result.grouped ? MODEL_GROUPS : MODEL_ROWS) ? { nota: `Aquí solo ves las primeras filas; el usuario ve la tabla (${result.lines} filas) y puede abrirla completa como reporte.` } : {}),
            ...(result.notes.length ? { avisos: result.notes } : {}),
          };
        } else if (name === 'buscar_en_internet') {
          const found = await webSearch(text(args && args.consulta).slice(0, 400));
          found.sources.forEach((s) => { if (!sources.some((x) => x.url === s.url)) sources.push(s); });
          response = { resultado: found.answer || 'La búsqueda no devolvió texto.', fuentes: found.sources.map((s) => s.title) };
        } else {
          response = { error: `La herramienta "${name}" no existe. Solo puedes consultar datos y buscar en internet; no puedes crear, cambiar ni borrar nada.` };
        }
      } catch (err) {
        response = { error: err.message };
      }
      responses.push({ id: call.id, name, response });
    }
    messages.push({ role: 'tool', results: responses });
  }
  if (!answer) answer = tables.length ? 'Esto es lo que encontré en los datos:' : 'No pude completar la respuesta. Intente con una pregunta más concreta.';

  // Una consulta que no encontro nada y luego se corrigio no se muestra.
  const useful = tables.filter((t, i) => t.total > 0 || i === tables.length - 1).slice(-MAX_TABLES);
  return {
    answer,
    tables: useful.map((t) => ({ title: t.title, columns: t.columns, rows: t.rows, total: t.total, lines: t.lines, shown: t.shown, grouped: t.grouped, reportUrl: t.reportUrl, spec: t.spec })),
    sources: sources.slice(0, 8),
    provider: info ? { label: info.label, location: info.location, model: info.model } : null,
    notice,
  };
}

// Reporte temporal / exportacion de un resultado: se vuelve a ejecutar la
// consulta (con los permisos de quien la pide); no se confia en filas
// enviadas por el navegador, y nada de esto se guarda.
async function rerun({ spec, user, enabledModules }) {
  return runQuery(datasets(user, enabledModules), spec, null, { limit: REPORT_ROWS });
}

async function buildWorkbook(result, user) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Resultado');
  sheet.addRow([result.title]).font = { bold: true, size: 13 };
  sheet.addRow([`Generado el ${reportService.now()} por ${user.full_name || user.email || 'usuario'} · ${result.total} registro(s)`]);
  sheet.addRow([]);
  sheet.addRow(result.columns).font = { bold: true };
  result.rows.forEach((r) => sheet.addRow(r));
  sheet.views = [{ state: 'frozen', ySplit: 4 }];
  sheet.columns.forEach((col) => { col.width = 24; });
  return workbook.xlsx.writeBuffer();
}

// Datos para el PDF imprimible (reportPdf.buildPdf): hasta 7 columnas; en
// listados de inventario, con el codigo de barras del reporte de origen.
function pdfInput(result, meta, barcodeKey) {
  const shown = result.columns.slice(0, 7);
  const barcode = result.barcodes.find((b) => b.key === barcodeKey) || result.barcodes[0] || null;
  return {
    title: result.title, appName: meta.appName, generatedBy: meta.generatedBy, generatedAt: meta.generatedAt, filtersText: '',
    summary: { total: result.total, groups: [] },
    columns: shown.map((label, i) => ({ key: `c${i}`, label, w: 1 })),
    rows: result.rows.map((r, n) => {
      const row = Object.fromEntries(shown.map((_, i) => [`c${i}`, r[i]]));
      if (barcode && result.source && result.source[n]) row[barcode.key] = result.source[n][barcode.key];
      return row;
    }),
    barcode,
  };
}

async function log(user, direction, message) {
  try {
    await pool.query('INSERT INTO agent_message_log (channel, contact, user_id, direction, message_text) VALUES (?, ?, ?, ?, ?)',
      ['web', text(user.email || `usuario ${user.id}`).slice(0, 100), user.id || null, direction, text(message).slice(0, 60000)]);
  } catch (_) { /* el historial no debe impedir responder */ }
}

module.exports = { ask, rerun, buildWorkbook, pdfInput, runQuery, datasets, webSearch, log, _systemPrompt: systemPrompt };
