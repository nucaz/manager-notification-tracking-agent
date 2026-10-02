// Asistente dentro de la aplicacion ("Preguntar a la IA"): responde
// preguntas en lenguaje natural sobre lo que hay en la base de datos y,
// si se le pide, busca en internet.
//
// Como el agente de WhatsApp/Telegram, la IA NUNCA escribe SQL ni toca la
// base: elige entre herramientas fijas de solo lectura.
//   - consultar_datos: pide un reporte del catalogo (los mismos de
//     Reportes, mas empleados) con filtros, agrupacion y sumas. La consulta
//     la ejecuta la aplicacion; los numeros que ve el usuario salen de
//     aqui, no de la IA, y la tabla se le muestra completa.
//   - buscar_en_internet: una busqueda de Google hecha por Gemini.
// Solo se ofrecen los reportes que el usuario puede abrir.
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const geminiClient = require('./geminiClient');
const reportService = require('./reportService');

const MAX_STEPS = 6;        // idas y vueltas con la IA por pregunta
const MODEL_ROWS = 40;      // filas de un listado que se le pasan a la IA
const MODEL_GROUPS = 80;    // grupos de un resumen que se le pasan a la IA
const SCREEN_ROWS = 300;    // filas que se muestran en pantalla (el Excel las trae todas)
const MAX_TABLES = 3;
const MODES = ['igual', 'contiene', 'distinto', 'vacio', 'no_vacio', 'menor_que', 'mayor_que'];

const text = (value) => (value === null || value === undefined ? '' : String(value));
const fold = (value) => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

const empleados = {
  label: 'Empleados',
  module: 'empleados',
  columns: [
    { key: 'dni', label: 'DNI' }, { key: 'first_name', label: 'Nombres' }, { key: 'last_name', label: 'Apellidos' },
    { key: 'area', label: 'Área' }, { key: 'sede', label: 'Sede' }, { key: 'cargo', label: 'Cargo' },
  ],
  selects: [{ key: 'area' }, { key: 'sede' }],
  async load() {
    const [rows] = await pool.query('SELECT dni, first_name, last_name, area, sede, cargo FROM employees ORDER BY last_name, first_name');
    return rows;
  },
};

// Lo que este usuario puede consultar.
function datasets(user, enabledModules) {
  const sets = { ...reportService.available(user, enabledModules) };
  if ((enabledModules || {})[empleados.module]) sets.empleados = empleados;
  return sets;
}

// La IA puede nombrar una columna por su clave o por su titulo.
function column(dataset, name) {
  const wanted = fold(name);
  return dataset.columns.find((c) => c.key === name) || dataset.columns.find((c) => fold(c.key) === wanted || fold(c.label) === wanted) || null;
}

function compare(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (text(a).trim() !== '' && text(b).trim() !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return text(a).localeCompare(text(b), 'es');
}

// Ejecuta una consulta pedida por la IA (o repetida desde "Descargar
// Excel"). Todo lo que llega se valida contra el catalogo; lo que no
// existe se informa como error en vez de adivinar.
//   -> { spec, title, columns, rows, total, shown, reportUrl, notes, grouped }
async function runQuery(sets, raw, cache = new Map(), { limit = SCREEN_ROWS } = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const key = text(input.reporte);
  const dataset = sets[key];
  if (!dataset) throw new Error(`El reporte "${key}" no existe o este usuario no tiene acceso. Disponibles: ${Object.keys(sets).join(', ')}.`);
  const need = (name) => {
    const col = column(dataset, name);
    if (!col) throw new Error(`La columna "${text(name)}" no existe en "${key}". Columnas: ${dataset.columns.map((c) => c.key).join(', ')}.`);
    return col;
  };

  if (!cache.has(key)) cache.set(key, await dataset.load({}));
  const all = cache.get(key);
  const notes = [];

  const filters = (Array.isArray(input.filtros) ? input.filtros : []).slice(0, 8).map((f) => {
    const col = need(f && f.columna);
    const mode = MODES.includes(f.modo) ? f.modo : 'igual';
    const value = text(f.valor).slice(0, 120);
    const wanted = fold(value);
    let test;
    let resolved = null; // valor real de la base cuando "igual" calza con uno solo
    if (mode === 'vacio') test = (v) => text(v).trim() === '';
    else if (mode === 'no_vacio') test = (v) => text(v).trim() !== '';
    else if (mode === 'menor_que') test = (v) => text(v).trim() !== '' && compare(v, value) < 0;
    else if (mode === 'mayor_que') test = (v) => text(v).trim() !== '' && compare(v, value) > 0;
    else if (mode === 'contiene') test = (v) => fold(v).includes(wanted);
    else {
      // "igual" (y "distinto") sin distinguir mayusculas ni acentos; si nada
      // es igual, se acepta lo que lo contenga ("surco" -> "SEDE SURCO").
      const values = [...new Set(all.map((r) => text(r[col.key])))];
      let matches = values.filter((v) => fold(v) === wanted);
      if (!matches.length) matches = values.filter((v) => wanted && fold(v).includes(wanted));
      if (!matches.length) {
        notes.push(`Ningún registro tiene "${value}" en ${col.label}. Valores que existen: ${values.filter(Boolean).sort((a, b) => a.localeCompare(b, 'es')).slice(0, 40).join(', ') || '(ninguno)'}.`);
      }
      if (matches.length === 1) resolved = matches[0];
      const set = new Set(matches);
      test = mode === 'distinto' ? (v) => !set.has(text(v)) : (v) => set.has(text(v));
    }
    return { col, mode, value, test, resolved };
  });

  const search = fold(input.buscar).slice(0, 120);
  const rows = all.filter((r) => filters.every((f) => f.test(r[f.col.key]))
    && (!search || dataset.columns.some((c) => fold(r[c.key]).includes(search))));

  const groupBy = (Array.isArray(input.agrupar_por) ? input.agrupar_por : []).slice(0, 3).map(need);
  const sums = (Array.isArray(input.sumar) ? input.sumar : []).slice(0, 4).map(need);
  const spec = {
    reporte: key,
    filtros: filters.map((f) => ({ columna: f.col.key, modo: f.mode, valor: f.value })),
    buscar: text(input.buscar).slice(0, 120),
    agrupar_por: groupBy.map((c) => c.key),
    sumar: sums.map((c) => c.key),
    columnas: [],
  };
  const round = (n) => Math.round(n * 100) / 100;
  let columns;
  let out;
  if (groupBy.length || sums.length) {
    const groups = new Map();
    rows.forEach((r) => {
      const values = groupBy.map((c) => text(r[c.key]) || 'Sin dato');
      const id = values.join('\u0001');
      if (!groups.has(id)) groups.set(id, { values, count: 0, sums: sums.map(() => 0) });
      const g = groups.get(id);
      g.count += 1;
      sums.forEach((c, i) => { g.sums[i] += Number(r[c.key]) || 0; });
    });
    columns = [...groupBy.map((c) => c.label), 'Cantidad', ...sums.map((c) => `Suma de ${c.label}`)];
    out = [...groups.values()].sort((a, b) => b.count - a.count || a.values.join(' ').localeCompare(b.values.join(' '), 'es'))
      .map((g) => [...g.values, g.count, ...g.sums.map(round)]);
  } else {
    const wanted = (Array.isArray(input.columnas) ? input.columnas : []).slice(0, 14).map(need);
    const cols = wanted.length ? wanted : dataset.columns.slice(0, 9);
    spec.columnas = cols.map((c) => c.key);
    columns = cols.map((c) => c.label);
    out = rows.map((r) => cols.map((c) => { const v = r[c.key]; return v === null || v === undefined ? '' : (typeof v === 'number' ? v : String(v)); }));
  }

  // Enlace al mismo resultado en Reportes (de ahi sale el PDF con codigo de
  // barras), cuando los filtros son de los que esa pantalla sabe aplicar.
  let reportUrl = null;
  const selectKeys = (dataset.selects || []).map((s) => s.key);
  if (reportService.REPORTS[key] && filters.every((f) => f.mode === 'igual' && f.resolved !== null && selectKeys.includes(f.col.key))) {
    const p = new URLSearchParams({ modulo: key });
    filters.forEach((f) => p.set(`f_${f.col.key}`, f.resolved));
    if (spec.buscar) p.set('q', spec.buscar);
    reportUrl = `/reportes?${p.toString()}`;
  }

  const parts = filters.map((f) => `${f.col.label} ${f.mode === 'igual' ? '=' : f.mode.replace('_', ' ')} ${f.mode.includes('vacio') ? '' : f.value}`.trim());
  if (spec.buscar) parts.push(`búsqueda "${spec.buscar}"`);
  const title = `${dataset.label}${groupBy.length ? ` por ${groupBy.map((c) => c.label.toLowerCase()).join(' y ')}` : ''}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  return { spec, title, columns, rows: out.slice(0, limit), shown: Math.min(out.length, limit), lines: out.length, total: rows.length, grouped: !!(groupBy.length || sums.length), reportUrl, notes };
}

// Busqueda en internet: una llamada aparte a Gemini con la busqueda de
// Google activada (no se puede combinar con las otras herramientas en la
// misma llamada).
async function webSearch(query) {
  const data = await geminiClient.generate({
    contents: [{ role: 'user', parts: [{ text: `Busca en internet y responde en español, con datos concretos y actuales (modelos, versiones, fechas, precios si se piden), sin relleno:\n\n${query}` }] }],
    tools: [{ google_search: {} }],
  });
  const candidate = (data.candidates || [])[0] || {};
  const answer = ((candidate.content || {}).parts || []).map((p) => p.text || '').join('').trim();
  const chunks = ((candidate.groundingMetadata || {}).groundingChunks || []).map((c) => c.web).filter((w) => w && /^https?:\/\//i.test(w.uri || ''));
  const seen = new Set();
  const sources = chunks.filter((w) => !seen.has(w.uri) && seen.add(w.uri)).slice(0, 8).map((w) => ({ title: text(w.title || w.uri).slice(0, 120), url: w.uri }));
  return { answer, sources };
}

function toolDeclarations(sets) {
  const names = { type: 'ARRAY', items: { type: 'STRING' } };
  return [{
    name: 'consultar_datos',
    description: 'Consulta los datos reales de la aplicación (solo lectura). Devuelve el total de registros y, según se pida, un resumen agrupado (cantidades y sumas) o un listado de filas. La tabla completa se le muestra al usuario automáticamente.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reporte: { type: 'STRING', enum: Object.keys(sets), description: 'Qué datos consultar.' },
        filtros: {
          type: 'ARRAY',
          description: 'Condiciones que deben cumplirse todas.',
          items: {
            type: 'OBJECT',
            properties: {
              columna: { type: 'STRING', description: 'Clave de la columna.' },
              modo: { type: 'STRING', enum: MODES, description: 'igual (predeterminado; no distingue mayúsculas ni acentos), contiene, distinto, vacio, no_vacio, menor_que, mayor_que (números o fechas AAAA-MM-DD).' },
              valor: { type: 'STRING' },
            },
            required: ['columna'],
          },
        },
        buscar: { type: 'STRING', description: 'Texto a buscar en cualquier columna.' },
        agrupar_por: { ...names, description: 'Claves de columna para contar por grupo (ej. ["sede"] o ["area","estado"]). Úselo para "cuántos hay por...".' },
        sumar: { ...names, description: 'Claves de columnas numéricas a sumar (ej. costos).' },
        columnas: { ...names, description: 'Para listados: qué columnas mostrar.' },
      },
      required: ['reporte'],
    },
  }, {
    name: 'buscar_en_internet',
    description: 'Busca en internet (Google) información que no está en la aplicación: características de un modelo de equipo, una tecnología, versiones, fin de soporte, precios de referencia.',
    parameters: { type: 'OBJECT', properties: { consulta: { type: 'STRING', description: 'Qué buscar, con el modelo o tecnología exactos.' } }, required: ['consulta'] },
  }];
}

function systemPrompt(sets, page, user) {
  const catalog = Object.entries(sets).map(([key, d]) => `- ${key} — ${d.label}. Columnas: ${d.columns.map((c) => `${c.key} (${c.label})`).join(', ')}.`).join('\n');
  return `Eres el asistente de una aplicación interna de gestión de TI (licencias, dominios, contratos ISP, servidores, certificados, celulares y chips, inventario de GLPI, empleados). Respondes en español, de forma breve y directa, a ${user.full_name || 'un usuario'} (rol ${user.role}).

Hoy es ${new Date().toISOString().slice(0, 10)}.${page ? ` El usuario está viendo la pantalla ${page}.` : ''}

Reglas:
- Todo dato de la empresa sale de la herramienta consultar_datos. No inventes cifras, nombres ni códigos: si no lo consultaste, no lo afirmes.
- Para "cuántos", "stock", "por área", "por sede", "por operadora": usa agrupar_por. Para montos: usa sumar. El stock de celulares es estado "En stock".
- Si un filtro no encuentra nada, la herramienta te dice qué valores existen: corrige y vuelve a consultar antes de responder.
- La tabla del resultado se le muestra al usuario debajo de tu respuesta, con botón para descargarla en Excel: no la repitas entera; resume lo importante (totales, lo más alto, lo llamativo).
- Usa buscar_en_internet solo cuando pidan información externa (un modelo, una tecnología, precios, fin de soporte) o cuando lo pidan expresamente. Puedes combinar: primero consultar qué modelos hay y luego buscar sobre ellos.
- Solo puedes consultar; no puedes crear, cambiar ni borrar nada. Si te lo piden, indica en qué pantalla se hace.
- Si la pregunta no tiene que ver con esta aplicación ni con tecnología, dilo en una línea.

Datos disponibles para este usuario:
${catalog}`;
}

// { question, history: [{ q, a }], page, user, enabledModules }
//   -> { answer, tables: [...], sources: [...] }
async function ask({ question, history = [], page = '', user, enabledModules }) {
  const sets = datasets(user, enabledModules);
  const cache = new Map();
  const tables = [];
  const sources = [];
  const contents = [];
  history.slice(-6).forEach((turn) => {
    if (!turn || !turn.q || !turn.a) return;
    contents.push({ role: 'user', parts: [{ text: text(turn.q).slice(0, 2000) }] });
    contents.push({ role: 'model', parts: [{ text: text(turn.a).slice(0, 2000) }] });
  });
  contents.push({ role: 'user', parts: [{ text: text(question).slice(0, 2000) }] });
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt(sets, text(page).slice(0, 80), user) }] },
    tools: [{ functionDeclarations: toolDeclarations(sets) }],
    generationConfig: { temperature: 0.2 },
  };

  let answer = '';
  for (let step = 0; step < MAX_STEPS; step++) {
    const data = await geminiClient.generate({ ...body, contents });
    const candidate = (data.candidates || [])[0];
    const parts = (candidate && candidate.content && candidate.content.parts) || [];
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) {
      answer = parts.map((p) => p.text || '').join('').trim();
      if (!answer && candidate && candidate.finishReason && candidate.finishReason !== 'STOP') {
        answer = `La IA no completó la respuesta (motivo: ${candidate.finishReason}). Intente reformular la pregunta.`;
      }
      break;
    }
    // El turno de la IA se devuelve tal cual (trae firmas que la API exige de vuelta).
    contents.push({ role: 'model', parts });
    const responses = [];
    for (const part of calls) {
      const { name, args } = part.functionCall;
      let response;
      try {
        if (name === 'consultar_datos') {
          const result = await runQuery(sets, args, cache);
          tables.push(result);
          response = {
            total_registros: result.total, columnas: result.columns,
            [result.grouped ? 'grupos' : 'filas']: result.rows.slice(0, result.grouped ? MODEL_GROUPS : MODEL_ROWS),
            ...(result.lines > (result.grouped ? MODEL_GROUPS : MODEL_ROWS) ? { nota: `Aquí solo ves las primeras filas; el usuario ve la tabla (${result.lines} filas) y puede descargarla completa.` } : {}),
            ...(result.notes.length ? { avisos: result.notes } : {}),
          };
        } else if (name === 'buscar_en_internet') {
          const found = await webSearch(text(args && args.consulta).slice(0, 400));
          found.sources.forEach((s) => { if (!sources.some((x) => x.url === s.url)) sources.push(s); });
          response = { resultado: found.answer || 'La búsqueda no devolvió texto.', fuentes: found.sources.map((s) => s.title) };
        } else {
          response = { error: `La herramienta "${name}" no existe.` };
        }
      } catch (err) {
        response = { error: err.message };
      }
      responses.push({ functionResponse: { name, response } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  if (!answer) answer = tables.length ? 'Esto es lo que encontré en los datos:' : 'No pude completar la respuesta. Intente con una pregunta más concreta.';

  // Una consulta que no encontro nada y luego se corrigio no se muestra.
  const useful = tables.filter((t, i) => t.total > 0 || i === tables.length - 1).slice(-MAX_TABLES);
  return {
    answer,
    tables: useful.map((t) => ({ title: t.title, columns: t.columns, rows: t.rows, total: t.total, lines: t.lines, shown: t.shown, grouped: t.grouped, reportUrl: t.reportUrl, spec: t.spec })),
    sources: sources.slice(0, 8),
  };
}

// Excel de un resultado: se vuelve a ejecutar la consulta (con los permisos
// de quien descarga), no se confia en filas enviadas por el navegador.
async function exportQuery({ spec, user, enabledModules }) {
  const result = await runQuery(datasets(user, enabledModules), spec, new Map(), { limit: 100000 });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Resultado');
  sheet.addRow([result.title]).font = { bold: true, size: 13 };
  sheet.addRow([`Generado el ${reportService.now()} por ${user.full_name || user.email || 'usuario'} · ${result.total} registro(s)`]);
  sheet.addRow([]);
  sheet.addRow(result.columns).font = { bold: true };
  result.rows.forEach((r) => sheet.addRow(r));
  sheet.views = [{ state: 'frozen', ySplit: 4 }];
  sheet.columns.forEach((col) => { col.width = 24; });
  return { buffer: await workbook.xlsx.writeBuffer(), result };
}

async function log(user, direction, message) {
  try {
    await pool.query('INSERT INTO agent_message_log (channel, contact, user_id, direction, message_text) VALUES (?, ?, ?, ?, ?)',
      ['web', text(user.email || `usuario ${user.id}`).slice(0, 100), user.id || null, direction, text(message).slice(0, 60000)]);
  } catch (_) { /* el historial no debe impedir responder */ }
}

module.exports = { ask, exportQuery, runQuery, datasets, webSearch, log, _systemPrompt: systemPrompt };
