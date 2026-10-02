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
//   - buscar_en_internet: una busqueda de Google hecha por Gemini.
// Solo se ofrecen los datos que el usuario puede abrir.
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const geminiClient = require('./geminiClient');
const reportService = require('./reportService');
const mobileLabels = require('../config/mobileLabels');

const MAX_STEPS = 8;        // idas y vueltas con la IA por pregunta
const MODEL_ROWS = 40;      // filas de un listado que se le pasan a la IA
const MODEL_GROUPS = 80;    // grupos de un resumen que se le pasan a la IA
const SCREEN_ROWS = 300;    // filas que se muestran en el panel (el reporte y el Excel las traen todas)
const REPORT_ROWS = 20000;  // tope de un reporte temporal
const MAX_TABLES = 3;
const MODES = ['igual', 'contiene', 'distinto', 'vacio', 'no_vacio', 'menor_que', 'mayor_que'];

const text = (value) => (value === null || value === undefined ? '' : String(value));
const fold = (value) => text(value).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const cols = (...pairs) => pairs.map(([key, label]) => ({ key, label }));
const yesNo = (v) => (v ? 'Sí' : 'No');

// ---------------------------------------------------------------------
// Datos que solo consulta el asistente (ademas de los reportes de Reportes).
// Misma forma que un reporte: { label, module | adminOnly, columns, load }.
// ---------------------------------------------------------------------
const table = (label, access, columns, sql, map) => ({
  label, ...access, columns, selects: [],
  async load() {
    const [rows] = await pool.query(sql);
    return map ? rows.map(map) : rows;
  },
});

const EXTRA = {
  empleados: table('Empleados', { module: 'empleados' },
    cols(['dni', 'DNI'], ['first_name', 'Nombres'], ['last_name', 'Apellidos'], ['area', 'Área'], ['sede', 'Sede'], ['cargo', 'Cargo']),
    'SELECT dni, first_name, last_name, area, sede, cargo FROM employees ORDER BY last_name, first_name'),
  asignaciones_celulares: table('Asignaciones de celulares (historial: quién tuvo cada equipo)', { module: 'celulares' },
    cols(['asset_code', 'Código'], ['imei', 'IMEI'], ['model', 'Modelo'], ['holder_name', 'Persona'], ['cargo', 'Cargo'], ['turno', 'Turno'],
      ['assigned_date', 'Desde'], ['returned_date', 'Hasta'], ['vigente', 'Vigente'], ['area', 'Área'], ['sede', 'Sede'], ['observacion', 'Observación']),
    `SELECT d.asset_code, d.imei, d.model, d.area, d.sede, a.holder_name, a.cargo, a.turno, a.assigned_date, a.returned_date, a.observacion
     FROM mobile_device_assignments a JOIN mobile_devices d ON d.id = a.device_id ORDER BY a.assigned_date DESC, a.id DESC`,
    (r) => ({ ...r, vigente: yesNo(!r.returned_date) })),
  incidentes_celulares: table('Incidentes de celulares (reparaciones, accidentes, decomisos, bajas)', { module: 'celulares' },
    cols(['asset_code', 'Código'], ['imei', 'IMEI'], ['tipo', 'Tipo'], ['motivo', 'Motivo'], ['fecha', 'Fecha'], ['fecha_resolucion', 'Resuelto el'],
      ['costo', 'Costo'], ['descripcion', 'Descripción'], ['area', 'Área'], ['sede', 'Sede']),
    `SELECT d.asset_code, d.imei, d.area, d.sede, i.tipo, i.motivo, i.fecha, i.fecha_resolucion, i.costo, i.descripcion
     FROM mobile_device_incidents i JOIN mobile_devices d ON d.id = i.device_id ORDER BY i.fecha DESC, i.id DESC`,
    (r) => ({ ...r, tipo: mobileLabels.incidentTipo(r.tipo).label, motivo: mobileLabels.DECOMISO_MOTIVO[r.motivo] || r.motivo })),
  recibos: table('Recibos de la operadora (totales por recibo)', { module: 'celulares' },
    cols(['operadora', 'Operadora'], ['recibo_nro', 'N.º de recibo'], ['fecha_emision', 'Emisión'], ['periodo_inicio', 'Periodo desde'], ['periodo_fin', 'Periodo hasta'],
      ['fecha_vencimiento', 'Vence'], ['total_pagar', 'Total a pagar'], ['total_lineas', 'Total líneas'], ['total_cargos', 'Total otros cargos'], ['saldo_anterior', 'Saldo anterior']),
    'SELECT operadora, recibo_nro, fecha_emision, periodo_inicio, periodo_fin, fecha_vencimiento, total_pagar, total_lineas, total_cargos, saldo_anterior FROM mobile_bills ORDER BY fecha_emision DESC'),
  recibos_lineas: table('Detalle de recibos: lo facturado por cada número', { module: 'celulares' },
    cols(['operadora', 'Operadora'], ['recibo_nro', 'N.º de recibo'], ['fecha_emision', 'Emisión'], ['phone_number', 'Número'], ['plan', 'Plan'],
      ['cargo_fijo', 'Cargo fijo'], ['descuento', 'Descuento'], ['otros', 'Otros'], ['monto_total', 'Monto total'], ['descuento_tipo', 'Tipo de descuento']),
    `SELECT b.operadora, b.recibo_nro, b.fecha_emision, l.phone_number, l.plan, l.cargo_fijo, l.descuento, l.otros, l.monto_total, l.descuento_tipo
     FROM mobile_bill_lines l JOIN mobile_bills b ON b.id = l.bill_id ORDER BY b.fecha_emision DESC, l.phone_number`),
  recibos_cargos: table('Detalle de recibos: equipos en cuotas y otros cargos', { module: 'celulares' },
    cols(['operadora', 'Operadora'], ['recibo_nro', 'N.º de recibo'], ['fecha_emision', 'Emisión'], ['descripcion', 'Descripción'], ['imei', 'IMEI'], ['modelo', 'Modelo'],
      ['cuota_nro', 'Cuota'], ['cuota_total', 'De cuotas'], ['monto', 'Monto']),
    `SELECT b.operadora, b.recibo_nro, b.fecha_emision, c.descripcion, c.imei, c.modelo, c.cuota_nro, c.cuota_total, c.monto
     FROM mobile_bill_charges c JOIN mobile_bills b ON b.id = c.bill_id ORDER BY b.fecha_emision DESC, c.id`),
  catalogos: table('Catálogos (sedes, áreas, marcas, modelos, operadoras)', {},
    cols(['catalog_type', 'Catálogo'], ['value', 'Valor'], ['activo', 'Activo']),
    'SELECT catalog_type, value, active FROM catalog_items ORDER BY catalog_type, value', (r) => ({ ...r, activo: yesNo(r.active) })),
  adjuntos: table('Adjuntos y facturas (con lo que extrajo la IA)', { module: 'licencias' },
    cols(['entity_type', 'Pertenece a'], ['doc_type', 'Tipo de documento'], ['original_name', 'Archivo'], ['uploaded_at', 'Subido el'], ['extracted_provider', 'Proveedor'],
      ['extracted_invoice_number', 'N.º de factura'], ['extracted_amount', 'Monto'], ['extracted_currency', 'Moneda'], ['extracted_concept', 'Concepto'],
      ['extracted_issue_date', 'Emisión'], ['extracted_due_date', 'Vencimiento'], ['extracted_site', 'Local']),
    `SELECT entity_type, doc_type, original_name, uploaded_at, extracted_provider, extracted_invoice_number, extracted_amount, extracted_currency,
            extracted_concept, extracted_issue_date, extracted_due_date, extracted_site FROM attachments ORDER BY uploaded_at DESC`),
  diagramas_red: table('Diagramas de red', { module: 'red' },
    cols(['category', 'Categoría'], ['title', 'Título'], ['description', 'Descripción'], ['version', 'Versión'], ['original_name', 'Archivo'], ['uploaded_at', 'Subido el']),
    'SELECT category, title, description, version, original_name, uploaded_at FROM network_diagrams ORDER BY category, title'),
  // Solo administradores. Nunca se exponen contrasenas, secretos de 2FA ni tokens.
  usuarios: table('Usuarios de la aplicación', { adminOnly: true },
    cols(['full_name', 'Nombre'], ['email', 'Correo'], ['role', 'Rol'], ['activo', 'Activo'], ['dos_pasos', '2FA activo'], ['bloqueado', 'Bloqueado'], ['created_at', 'Creado el']),
    'SELECT full_name, email, role, active, otp_enabled, locked, created_at FROM users ORDER BY full_name',
    (r) => ({ full_name: r.full_name, email: r.email, role: r.role, activo: yesNo(r.active), dos_pasos: yesNo(r.otp_enabled), bloqueado: yesNo(r.locked), created_at: r.created_at })),
  auditoria: table('Auditoría (quién hizo qué)', { adminOnly: true },
    cols(['created_at', 'Fecha'], ['user_email', 'Usuario'], ['action', 'Acción'], ['target', 'Sobre'], ['detail', 'Detalle'], ['ip_address', 'IP']),
    'SELECT created_at, user_email, action, target, detail, ip_address FROM audit_log ORDER BY created_at DESC LIMIT 5000'),
};

// Lo que este usuario puede consultar.
function datasets(user, enabledModules) {
  const sets = { ...reportService.available(user, enabledModules) };
  for (const [key, d] of Object.entries(EXTRA)) {
    if (d.adminOnly ? user && user.role === 'admin' : (!d.module || !!(enabledModules || {})[d.module])) sets[key] = d;
  }
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
// Excel" / "Abrir como reporte"). Todo lo que llega se valida contra el
// catalogo; lo que no existe se informa como error en vez de adivinar.
//   -> { spec, title, columns, rows, total, lines, shown, grouped, reportUrl, notes, barcodes }
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
  const grouped = !!(groupBy.length || sums.length);
  const top = Number.isInteger(input.limite) && input.limite > 0 ? Math.min(input.limite, REPORT_ROWS) : null;
  const descending = input.descendente === true;
  const spec = {
    reporte: key,
    filtros: filters.map((f) => ({ columna: f.col.key, modo: f.mode, valor: f.value })),
    buscar: text(input.buscar).slice(0, 120),
    agrupar_por: groupBy.map((c) => c.key),
    sumar: sums.map((c) => c.key),
    columnas: [],
    ordenar_por: '',
    descendente: descending,
    limite: top,
  };
  const round = (n) => Math.round(n * 100) / 100;
  let columns;
  let out;
  let source = null; // filas originales (objetos), solo en listados: para el codigo de barras del PDF
  if (grouped) {
    const groups = new Map();
    rows.forEach((r) => {
      const values = groupBy.map((c) => text(r[c.key]) || 'Sin dato');
      const id = JSON.stringify(values);
      if (!groups.has(id)) groups.set(id, { values, count: 0, sums: sums.map(() => 0) });
      const g = groups.get(id);
      g.count += 1;
      sums.forEach((c, i) => { g.sums[i] += Number(r[c.key]) || 0; });
    });
    columns = [...groupBy.map((c) => c.label), 'Cantidad', ...sums.map((c) => `Suma de ${c.label}`)];
    out = [...groups.values()].sort((a, b) => b.count - a.count || a.values.join(' ').localeCompare(b.values.join(' '), 'es'))
      .map((g) => [...g.values, g.count, ...g.sums.map(round)]);
    // Orden pedido: por una de las columnas del resumen ("cantidad", una suma o un grupo).
    const wantedOrder = fold(input.ordenar_por);
    const index = wantedOrder ? columns.findIndex((label, i) => fold(label) === wantedOrder
      || (i < groupBy.length && fold(groupBy[i].key) === wantedOrder)
      || (i > groupBy.length && fold(sums[i - groupBy.length - 1].key) === wantedOrder)) : -1;
    if (index > -1) {
      out.sort((a, b) => compare(a[index], b[index]) * (descending ? -1 : 1));
      spec.ordenar_por = columns[index];
    }
  } else {
    const wanted = (Array.isArray(input.columnas) ? input.columnas : []).slice(0, 14).map(need);
    const shown = wanted.length ? wanted : dataset.columns.slice(0, 9);
    spec.columnas = shown.map((c) => c.key);
    columns = shown.map((c) => c.label);
    source = rows;
    if (text(input.ordenar_por)) {
      const by = need(input.ordenar_por);
      spec.ordenar_por = by.key;
      source = [...rows].sort((a, b) => compare(a[by.key], b[by.key]) * (descending ? -1 : 1));
    }
    if (top) source = source.slice(0, top);
    out = source.map((r) => shown.map((c) => { const v = r[c.key]; return v === null || v === undefined ? '' : (typeof v === 'number' ? v : String(v)); }));
    source = source.slice(0, limit);
  }
  if (grouped && top) out = out.slice(0, top);

  // Enlace al mismo resultado en Reportes (de ahi sale el PDF con codigo de
  // barras), cuando los filtros son de los que esa pantalla sabe aplicar.
  let reportUrl = null;
  const selectKeys = (dataset.selects || []).map((s) => s.key);
  if (reportService.REPORTS[key] && !top && filters.every((f) => f.mode === 'igual' && f.resolved !== null && selectKeys.includes(f.col.key))) {
    const p = new URLSearchParams({ modulo: key });
    filters.forEach((f) => p.set(`f_${f.col.key}`, f.resolved));
    if (spec.buscar) p.set('q', spec.buscar);
    reportUrl = `/reportes?${p.toString()}`;
  }

  const parts = filters.map((f) => `${f.col.label} ${f.mode === 'igual' ? '=' : f.mode.replace('_', ' ')} ${f.mode.includes('vacio') ? '' : f.value}`.trim());
  if (spec.buscar) parts.push(`búsqueda "${spec.buscar}"`);
  if (top) parts.push(`primeros ${top}`);
  const title = `${dataset.label}${groupBy.length ? ` por ${groupBy.map((c) => c.label.toLowerCase()).join(' y ')}` : ''}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  return {
    spec, title, columns, rows: out.slice(0, limit), shown: Math.min(out.length, limit), lines: out.length, total: rows.length, grouped, reportUrl, notes,
    source, barcodes: grouped ? [] : (dataset.barcodes || []),
  };
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
    description: 'Consulta los datos reales de la aplicación (solo lectura). Devuelve el total de registros y, según se pida, un resumen agrupado (cantidades y sumas) o un listado de filas. La tabla completa se le muestra al usuario automáticamente y puede abrirla como reporte, en Excel o en PDF.',
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
        ordenar_por: { type: 'STRING', description: 'Columna por la que ordenar. En resúmenes también vale "cantidad" o el título de una suma.' },
        descendente: { type: 'BOOLEAN', description: 'true = de mayor a menor.' },
        limite: { type: 'INTEGER', description: 'Quedarse solo con los primeros N (para "los 10 más...").' },
      },
      required: ['reporte'],
    },
  }, {
    name: 'buscar_en_internet',
    description: 'Busca en internet (Google): características de un modelo de equipo, una tecnología, versiones, fin de soporte, precios de referencia, noticias, documentación, cómo hacer algo. Úsela con libertad cuando la respuesta dependa de información actual o externa.',
    parameters: { type: 'OBJECT', properties: { consulta: { type: 'STRING', description: 'Qué buscar, con el modelo o tecnología exactos.' } }, required: ['consulta'] },
  }];
}

function systemPrompt(sets, page, user) {
  const catalog = Object.entries(sets).map(([key, d]) => `- ${key} — ${d.label}. Columnas: ${d.columns.map((c) => `${c.key} (${c.label})`).join(', ')}.`).join('\n');
  return `Eres el asistente de una aplicación interna de gestión de TI (licencias, dominios, contratos ISP, servidores, certificados, celulares y chips, recibos de operadoras, inventario de GLPI, empleados, repositorios). Conversas en español con ${user.full_name || 'un usuario'} (rol ${user.role}), con naturalidad y sin rodeos.

Hoy es ${new Date().toISOString().slice(0, 10)}.${page ? ` El usuario está viendo la pantalla ${page}.` : ''}

Qué puedes hacer, con libertad:
- Conversar, explicar, comparar, recomendar y razonar sobre cualquier tema que el usuario plantee (tecnología, gestión de TI, redacción, cálculos, lo que necesite). No te limites a esta aplicación.
- Consultar los datos de la aplicación con consultar_datos tantas veces como haga falta, cruzando varios reportes si la pregunta lo pide, y sacar conclusiones propias (tendencias, anomalías, lo que conviene revisar).
- Armar reportes: cada consulta produce una tabla que el usuario ve debajo de tu respuesta y puede abrir como reporte temporal, descargar en Excel o en PDF. Si pide "un reporte de...", haz la consulta que lo produce y dile que lo abra con esos botones.
- Buscar en internet con buscar_en_internet cuando ayude: modelos, tecnologías, precios, fin de soporte, documentación, novedades. Puedes combinar: consultar qué hay y luego buscar sobre eso.

Lo único que no puedes hacer:
- Crear, cambiar o borrar datos de la aplicación. No tienes ninguna herramienta para eso. Si te lo piden, dilo y explica en qué pantalla lo hace el usuario.
- Inventar datos de la empresa. Cifras, nombres, códigos y estados salen solo de consultar_datos; si no lo consultaste, no lo afirmes. Lo que sepas por conocimiento general o por internet, dilo como tal.

Cómo consultar bien:
- Para "cuántos", "stock", "por área", "por sede", "por operadora": usa agrupar_por. Para montos: sumar. Para "los N más...": ordenar_por con descendente y limite. El stock de celulares es estado "En stock".
- Si un filtro no encuentra nada, la herramienta te dice qué valores existen: corrige y vuelve a consultar antes de responder.
- No repitas la tabla entera en el texto: resume lo importante (totales, lo más alto, lo llamativo) y deja el detalle a la tabla.

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
    generationConfig: { temperature: 0.4 },
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

// Reporte temporal / exportacion de un resultado: se vuelve a ejecutar la
// consulta (con los permisos de quien la pide); no se confia en filas
// enviadas por el navegador, y nada de esto se guarda.
async function rerun({ spec, user, enabledModules }) {
  return runQuery(datasets(user, enabledModules), spec, new Map(), { limit: REPORT_ROWS });
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
