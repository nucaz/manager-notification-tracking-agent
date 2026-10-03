// Chips (lineas) del modulo Celulares: /celulares/chips. Mismo permiso de
// modulo que Celulares. La logica (y la sincronizacion con el numero del
// celular) vive en src/services/mobileLineService.js.
const express = require('express');
const crypto = require('crypto');
const { Readable } = require('stream');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { requireAuth, canWrite } = require('../middleware/auth');
const { moduleRequired } = require('../middleware/modules');
const { verifyCsrfToken } = require('../middleware/csrf');
const catalogService = require('../services/catalogService');
const employeeService = require('../services/employeeService');
const auditService = require('../services/auditService');
const lineService = require('../services/mobileLineService');
const notesService = require('../services/mobileLineNotesService');
const chipUsageService = require('../services/chipUsageService');
const importService = require('../services/importService');
const { importUploader } = require('../services/uploadService');
const labels = require('../config/mobileLabels');

const router = express.Router();
router.use(requireAuth, moduleRequired('celulares'));

const FILTERS = ['q', 'estado', 'ubicacion', 'operadora', 'area', 'sede', 'costo'];

function readFilters(query) {
  const out = {};
  for (const k of FILTERS) out[k] = typeof query[k] === 'string' ? query[k].trim() : '';
  return out;
}

function queryString(filters) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  const s = params.toString();
  return s ? `?${s}` : '';
}

function readForm(body) {
  const clean = (v) => {
    const s = v === undefined || v === null ? '' : String(v).trim();
    return s === '' ? null : s;
  };
  return {
    phone_country_code_id: clean(body.phone_country_code_id),
    phone_number: clean(body.phone_number),
    iccid: clean(body.iccid),
    operadora: clean(body.operadora),
    plan: clean(body.plan),
    costo_plan: clean(body.costo_plan),
    descuento_plan: clean(body.descuento_plan),
    descuento_nota: clean(body.descuento_nota),
    estado: clean(body.estado) || 'activo',
    notes: clean(body.notes),
  };
}

async function formOptions() {
  const [operadoras, countries, areas, sedes] = await Promise.all([
    catalogService.getActive('operadora'),
    catalogService.getActiveCountries(),
    catalogService.getActive('area'),
    catalogService.getActive('sede'),
  ]);
  return { operadoras, countries, areas, sedes };
}

function lineLabel(line) {
  return `Chip ${line.phone_number}`;
}

router.get('/', async (req, res, next) => {
  try {
    const filters = readFilters(req.query);
    const rows = await lineService.listLines(filters);
    const summary = lineService.summarize(rows);
    const [opRows] = await pool.query("SELECT DISTINCT operadora FROM mobile_lines WHERE operadora IS NOT NULL AND operadora <> '' ORDER BY operadora");
    const [areaRows] = await pool.query(
      `SELECT DISTINCT area FROM (
         SELECT d.area FROM mobile_lines l JOIN mobile_devices d ON d.id = l.device_id
         UNION SELECT e.area FROM mobile_line_assignments a JOIN employees e ON e.id = a.employee_id WHERE a.returned_date IS NULL
       ) x WHERE area IS NOT NULL AND area <> '' ORDER BY area`
    );
    const [sedeRows] = await pool.query(
      `SELECT DISTINCT sede FROM (
         SELECT d.sede FROM mobile_lines l JOIN mobile_devices d ON d.id = l.device_id
         UNION SELECT e.sede FROM mobile_line_assignments a JOIN employees e ON e.id = a.employee_id WHERE a.returned_date IS NULL
       ) x WHERE sede IS NOT NULL AND sede <> '' ORDER BY sede`
    );
    res.render('mobileLines/list', {
      title: 'Chips',
      items: rows,
      summary,
      filters,
      filterQuery: queryString(filters),
      operadoras: opRows.map((r) => r.operadora),
      catalogOperadoras: await catalogService.getActive('operadora'),
      areas: areaRows.map((r) => r.area),
      sedes: sedeRows.map((r) => r.sede),
      activeFilters: FILTERS.filter((k) => filters[k]).length,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/exportar.xlsx', async (req, res, next) => {
  try {
    const rows = await lineService.listLines(readFilters(req.query));
    const summary = lineService.summarize(rows);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Chips');
    const headers = ['Número', 'Código de país', 'ICCID', 'Operadora', 'Plan', 'Costo sin descuento (S/)', 'Descuento (S/)',
      'Costo con descuento (S/)', 'Detalle del descuento', 'Estado', 'Fecha de baja', 'Motivo de la baja', 'Ubicación',
      'Usuario', 'Área', 'Sede', 'IMEI del celular', 'Código de activo', 'Notas'];
    sheet.addRow(headers);
    rows.forEach((r) => sheet.addRow([
      String(r.phone_number), r.calling_code ? `+${r.calling_code}` : '', r.iccid ? String(r.iccid) : '', r.operadora || '',
      r.plan || '', r.costo_plan === null ? '' : Number(r.costo_plan), r.costo_plan === null ? '' : Number(r.descuento_plan) || 0,
      r.costo_plan === null ? '' : lineService.netCost(r), r.descuento_nota || '', labels.lineEstado(r.estado).label,
      r.fecha_baja || '', r.motivo_baja || '',
      labels.lineUbicacion(r.ubicacion).label, r.holder || '', r.area || '', r.sede || '', r.imei ? String(r.imei) : '',
      r.asset_code || '', r.notes || '',
    ]));
    sheet.addRow([]);
    const total = sheet.addRow(['TOTAL (sin los de baja)', '', '', '', `${summary.total} chip(s)`, summary.costoTotal, summary.descuentoTotal, summary.netoTotal]);
    total.font = { bold: true };
    sheet.getRow(1).font = { bold: true };
    [6, 7, 8].forEach((c) => { sheet.getColumn(c).numFmt = '#,##0.00'; });
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
    [14, 10, 22, 12, 18, 16, 14, 16, 34, 16, 14, 30, 20, 22, 32, 24, 16, 18, 14, 30].forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
    const buffer = await workbook.xlsx.writeBuffer();
    const fecha = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="chips_${fecha}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Carga por lote: Excel, escaneo de codigos de barras y operadora masiva.
// Van antes de las rutas con /:id para que Express no tome "importar" o
// "escanear" como el id de un chip.
// ---------------------------------------------------------------------
const IMPORT_COLUMNS = [
  { header: 'Número', field: 'phone_number', required: true },
  { header: 'ICCID', field: 'iccid' },
  { header: 'Operadora', field: 'operadora' },
  { header: 'Plan', field: 'plan' },
  { header: 'Costo sin descuento', field: 'costo_plan' },
  { header: 'Descuento', field: 'descuento_plan' },
  { header: 'Detalle del descuento', field: 'descuento_nota' },
  { header: 'Notas', field: 'notes' },
];

// Como puede llamarse cada columna en el archivo (sin tildes ni
// mayusculas). "serie" no es un campo del chip: va a las notas.
const IMPORT_ALIASES = {
  phone_number: ['numero', 'número', 'n', 'no', 'nro', 'numero de linea', 'linea', 'telefono', 'celular', 'numero entel'],
  iccid: ['iccid', 'icc', 'sim', 'numero de chip'],
  operadora: ['operadora', 'operador'],
  plan: ['plan', 'plan tarifario'],
  costo_plan: ['costo sin descuento', 'costo', 'cargo fijo', 'costo mensual'],
  descuento_plan: ['descuento', 'descuento mensual'],
  descuento_nota: ['detalle del descuento'],
  notes: ['notas', 'nota', 'observacion', 'observaciones'],
  serie: ['serie', 'serial', 'imeif', 'codigo', 'codigo de serie'],
};
const normHeader = (v) => String(v === null || v === undefined ? '' : v).normalize('NFD').replace(/[^\x20-\x7e]/g, '')
  .replace(/[.:°º]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

function cellValue(cell) {
  const v = cell.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) return v.result === undefined || v.result === null ? '' : v.result;
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    return cell.text || '';
  }
  return v === undefined || v === null ? '' : v;
}

// Lee la hoja buscando la fila de encabezados (no tiene que ser la primera
// ni empezar en la columna A) y devuelve las filas ya con sus campos.
async function readChipSheet(buffer, filename) {
  const workbook = new ExcelJS.Workbook();
  let sheet;
  if (/\.csv$/i.test(filename || '')) sheet = await workbook.csv.read(Readable.from(buffer));
  else { await workbook.xlsx.load(buffer); sheet = workbook.worksheets[0]; }
  if (!sheet) return { rows: [], unknown: [], headerRow: null };
  let headerRow = null;
  let cols = {};
  let unknown = [];
  for (let r = 1; r <= Math.min(15, sheet.rowCount) && !headerRow; r++) {
    const found = {};
    const other = [];
    sheet.getRow(r).eachCell((cell, c) => {
      const h = normHeader(cellValue(cell));
      if (!h) return;
      const field = Object.keys(IMPORT_ALIASES).find((f) => IMPORT_ALIASES[f].map(normHeader).includes(h));
      if (field && !found[field]) found[field] = c; else other.push(String(cellValue(cell)).trim());
    });
    if (found.phone_number) { headerRow = r; cols = found; unknown = other; }
  }
  if (!headerRow) return { rows: [], unknown: [], headerRow: null };
  const rows = [];
  sheet.eachRow((row, r) => {
    if (r <= headerRow) return;
    const item = { row: r };
    Object.keys(cols).forEach((f) => { item[f] = cellValue(row.getCell(cols[f])); });
    if (Object.keys(cols).every((f) => String(item[f]).trim() === '')) return; // fila vacia
    // Excel guarda un numero con 15 cifras: un ICCID (19-20) escrito como
    // numero ya perdio las ultimas y no se puede recuperar del archivo.
    if (typeof item.iccid === 'number') {
      item.iccid = '';
      item.warning = 'ICCID ilegible: Excel lo guardó como número y perdió sus últimas cifras. Se registra sin ICCID (puede completarlo después).';
    }
    if (item.serie !== undefined && String(item.serie).trim() !== '') {
      item.notes = [String(item.notes === undefined ? '' : item.notes).trim(), `Serie ${String(item.serie).trim()}`].filter(Boolean).join(' · ');
    }
    delete item.serie;
    rows.push(item);
  });
  return { rows, unknown, headerRow };
}

// Archivos subidos que esperan la confirmacion del usuario (revision antes
// de registrar). En memoria: son pocos, viven minutos, y si el proceso se
// reinicia basta con volver a subir el archivo.
const pendingImports = new Map();
function keepImport(entry) {
  const now = Date.now();
  for (const [k, v] of pendingImports) if (now - v.at > 30 * 60 * 1000) pendingImports.delete(k);
  while (pendingImports.size >= 30) pendingImports.delete(pendingImports.keys().next().value);
  const token = crypto.randomBytes(16).toString('hex');
  pendingImports.set(token, { ...entry, at: now });
  return token;
}

const importView = (results) => ({
  title: 'Importar chips',
  listUrl: '/celulares/chips',
  actionUrl: '/celulares/chips/importar',
  templateUrl: '/celulares/chips/importar/plantilla',
  columns: IMPORT_COLUMNS,
  results,
  submitLabel: 'Revisar el archivo',
  note: 'Primero verá una revisión fila por fila; nada se registra hasta que la confirme. Los encabezados pueden estar en cualquier fila y sin tildes; una columna "Serie" o "IMEIF" se guarda en las notas.',
});

router.get('/importar', canWrite, (req, res) => res.render('import', importView(null)));

// Plantilla con Número e ICCID como TEXTO: si Excel los toma como numero,
// recorta el ICCID (19-20 digitos) a 15 cifras y lo completa con ceros.
router.get('/importar/plantilla', canWrite, async (req, res, next) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Chips');
    sheet.addRow(IMPORT_COLUMNS.map((c) => c.header)).font = { bold: true };
    sheet.getColumn(1).numFmt = '@';
    sheet.getColumn(2).numFmt = '@';
    [14, 26, 14, 26, 20, 12, 36, 36].forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_chips.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    next(err);
  }
});

// Paso 1: leer el archivo y mostrar la revision. No registra nada.
router.post('/importar', canWrite, importUploader.single('file'), verifyCsrfToken, async (req, res, next) => {
  try {
    if (!req.file) {
      req.flash('error', 'Debes seleccionar un archivo.');
      return res.redirect('/celulares/chips/importar');
    }
    let sheet;
    try {
      sheet = await readChipSheet(req.file.buffer, req.file.originalname);
    } catch (err) {
      req.flash('error', 'No se pudo abrir el archivo: está dañado o no es un Excel (.xlsx) ni un CSV.');
      return res.redirect('/celulares/chips/importar');
    }
    if (!sheet.headerRow) {
      req.flash('error', 'No se encontró la fila de encabezados: el archivo debe tener una columna llamada "Número" (use la plantilla).');
      return res.redirect('/celulares/chips/importar');
    }
    if (!sheet.rows.length) {
      req.flash('error', 'El archivo no tiene filas con datos debajo de los encabezados.');
      return res.redirect('/celulares/chips/importar');
    }
    const result = await lineService.createLinesBulk(sheet.rows, req.session.user.id, { dryRun: true });
    const token = keepImport({ rows: sheet.rows, filename: req.file.originalname, userId: req.session.user.id });
    res.render('mobileLines/importPreview', {
      title: 'Revisar antes de registrar', token, filename: req.file.originalname, unknown: sheet.unknown, headerRow: sheet.headerRow,
      checked: result.checked.sort((a, b) => a.row - b.row),
      counts: {
        ok: result.checked.filter((c) => c.ok && !c.warning).length, warning: result.checked.filter((c) => c.ok && c.warning).length,
        error: result.errors.length,
      },
      operadoras: await catalogService.getActive('operadora'),
    });
  } catch (err) {
    next(err);
  }
});

// Paso 2: registrar lo revisado. Los datos "para completar" solo llenan lo
// que el archivo dejo vacio. Se valida todo de nuevo: entre la revision y
// la confirmacion alguien pudo registrar uno de esos numeros.
router.post('/importar/confirmar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const pending = pendingImports.get(String(req.body.token || ''));
    if (!pending || pending.userId !== req.session.user.id) {
      req.flash('error', 'La revisión venció o ya se registró. Suba el archivo de nuevo.');
      return res.redirect('/celulares/chips/importar');
    }
    pendingImports.delete(req.body.token);
    const fill = {};
    ['operadora', 'plan', 'costo_plan', 'descuento_plan', 'notes'].forEach((k) => { fill[k] = String(req.body[k] || '').trim(); });
    const rows = pending.rows.map((r) => {
      const out = { ...r };
      Object.keys(fill).forEach((k) => { if (fill[k] && String(out[k] === undefined ? '' : out[k]).trim() === '') out[k] = fill[k]; });
      return out;
    });
    const result = await lineService.createLinesBulk(rows, req.session.user.id);
    if (result.imported) {
      await auditService.log(req, {
        user: req.session.user, action: 'chips_importados', target: `${result.imported} chip(s)`,
        detail: `Desde ${pending.filename}; ${result.errors.length} fila(s) con error`,
      });
    }
    res.render('import', importView({ imported: result.imported, errors: result.errors.sort((a, b) => a.row - b.row) }));
  } catch (err) {
    next(err);
  }
});

// ¿Existe ya este numero o ICCID? Lo consultan el formulario y la pantalla
// de escaneo mientras se escribe, para avisar "chip existente" sin esperar
// a guardar. Solo lectura.
router.get('/existe', async (req, res, next) => {
  try {
    const numero = lineService.digits(req.query.numero);
    const iccid = lineService.digits(req.query.iccid);
    if (!numero && !iccid) return res.json({ existe: false });
    const exceptId = /^\d+$/.test(String(req.query.excepto || '')) ? Number(req.query.excepto) : null;
    const found = await lineService.findExisting({ numero, iccid: numero ? '' : iccid, exceptId });
    if (!found) return res.json({ existe: false });
    const partes = [labels.lineEstado(found.estado).label, labels.lineUbicacion(found.ubicacion).label];
    if (found.holder) partes.push(found.holder);
    if (found.operadora) partes.push(found.operadora);
    if (found.asset_code || found.imei) partes.push(`celular ${found.asset_code || found.imei}`);
    res.json({
      existe: true, numero: found.phone_number, estado: found.estado, detalle: partes.join(' · '),
      url: found.id ? `/celulares/chips/${found.id}` : `/celulares/${found.device_id}`,
    });
  } catch (err) {
    next(err);
  }
});

const scanView = async (extra) => ({
  title: 'Ingresar chips por escaneo',
  operadoras: await catalogService.getActive('operadora'),
  lote: {}, pendientes: [], errores: [], registrados: null,
  ...extra,
});

// Uso real de las lineas: cuanto se paga y se usa, cuanto se paga y esta
// guardado (repuesto, stock, celulares en stock) y cuanto se factura sin
// estar en el inventario.
router.get('/uso', async (req, res, next) => {
  try {
    res.render('mobileLines/usage', { title: 'Uso real de las líneas', ...(await chipUsageService.usage()) });
  } catch (err) {
    next(err);
  }
});

router.get('/uso/exportar.xlsx', async (req, res, next) => {
  try {
    const u = await chipUsageService.usage();
    const wb = new ExcelJS.Workbook();
    const resumen = wb.addWorksheet('Resumen');
    resumen.addRow(['Uso real de las líneas']).font = { bold: true, size: 13 };
    resumen.addRow([]);
    resumen.addRow(['Grupo', 'Detalle', 'Chips', 'Al mes (S/)', 'Sin costo conocido']).font = { bold: true };
    Object.values(u.categories).forEach((c) => resumen.addRow([u.groups[c.group], c.label, c.count, c.monthly, c.withoutCost]));
    resumen.addRow(['Facturado y no registrado', 'Se paga y no está en el inventario', u.totals.unlocated.count, u.totals.unlocated.monthly, 0]);
    resumen.addRow([]);
    resumen.addRow(['Total del último recibo', '', u.totals.billedLines, u.totals.billedMonthly]).font = { bold: true };
    resumen.columns.forEach((c, i) => { c.width = [34, 44, 10, 14, 18][i]; });
    const sheet = (name, rows, columns) => {
      const ws = wb.addWorksheet(name);
      ws.addRow(columns.map((c) => c[1])).font = { bold: true };
      rows.forEach((r) => ws.addRow(columns.map((c) => (r[c[0]] === null || r[c[0]] === undefined ? '' : r[c[0]]))));
      ws.columns.forEach((c) => { c.width = 22; });
    };
    const cols = [['number', 'Número'], ['operadora', 'Operadora'], ['plan', 'Plan'], ['monthly', 'Al mes (S/)'], ['holder', 'Persona'], ['device', 'Celular'], ['area', 'Área'], ['sede', 'Sede']];
    sheet('Guardados', ['guardado_repuesto', 'guardado_celular', 'guardado_stock'].flatMap((k) => u.categories[k].items.map((i) => ({ ...i, tipo: u.categories[k].label }))),
      [['tipo', 'Dónde está'], ...cols]);
    sheet('En uso', ['uso_celular', 'uso_personal', 'uso_emergencia'].flatMap((k) => u.categories[k].items.map((i) => ({ ...i, tipo: u.categories[k].label }))), [['tipo', 'Uso'], ...cols]);
    sheet('Facturado sin registrar', u.unlocated, [['number', 'Número'], ['operadora', 'Operadora'], ['recibo', 'Recibo'], ['plan', 'Plan'], ['monthly', 'Al mes (S/)']]);
    sheet('Registrado sin recibo', u.notBilled, [['category', 'Dónde está'], ...cols]);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="uso_real_lineas_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(await wb.xlsx.writeBuffer());
  } catch (err) {
    next(err);
  }
});

// Segundas lineas anotadas en las notas de los celulares: revision antes de
// registrarlas como 2.o chip, cruzadas con el ultimo recibo de cada operadora.
router.get('/desde-notas', canWrite, async (req, res, next) => {
  try {
    const data = await notesService.candidates();
    const summary = lineService.summarize(await lineService.listLines({}));
    res.render('mobileLines/notesReview', { title: 'Segundas líneas anotadas en celulares', ...data, summary, result: req.session.notesResult || null });
    delete req.session.notesResult;
  } catch (err) {
    next(err);
  }
});

router.post('/desde-notas', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const { done, failed } = await notesService.register(req.body.items, req.session.user.id);
    if (done.length) {
      const facturados = done.filter((i) => i.billed && i.billed.missing).length;
      await auditService.log(req, {
        user: req.session.user, action: 'chips_desde_notas', target: `${done.length} chip(s) como 2.º chip`,
        detail: `${facturados} figuraban como faltantes en el recibo; ${failed.length} no se pudieron registrar`,
      });
    }
    req.session.notesResult = {
      done: done.map((i) => ({ number: i.number, device: i.device.asset_code || i.device.imei, billed: !!(i.billed && i.billed.missing) })),
      failed: failed.map((f) => ({ number: f.item.number, device: f.item.device.asset_code || f.item.device.imei, error: f.error })),
    };
    if (!done.length && !failed.length) req.flash('error', 'No marcó ningún número para registrar.');
    else req.flash(done.length ? 'success' : 'error', `${done.length} chip(s) registrados como 2.º chip de su celular${failed.length ? `; ${failed.length} no se pudieron registrar (ver abajo)` : ''}.`);
    res.redirect('/celulares/chips/desde-notas');
  } catch (err) {
    next(err);
  }
});

router.get('/escanear', canWrite, async (req, res, next) => {
  try {
    res.render('mobileLines/scan', await scanView());
  } catch (err) {
    next(err);
  }
});

// `chips` trae un chip por renglon: "numero;iccid" (lo arma la pantalla a
// medida que se escanea). Los datos del lote se aplican a todos.
router.post('/escanear', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const lote = {
      operadora: String(req.body.operadora || '').trim(), plan: String(req.body.plan || '').trim(),
      costo_plan: String(req.body.costo_plan || '').trim(), descuento_plan: String(req.body.descuento_plan || '').trim(),
      notes: String(req.body.notes || '').trim(),
    };
    const items = String(req.body.chips || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 2000)
      .map((l, i) => { const [numero, iccid] = l.split(';'); return { row: i + 1, phone_number: numero, iccid: iccid || '', ...lote }; });
    if (!items.length) {
      req.flash('error', 'No hay chips en la lista: escanee o escriba al menos uno.');
      return res.redirect('/celulares/chips/escanear');
    }
    const result = await lineService.createLinesBulk(items, req.session.user.id);
    if (result.imported) {
      await auditService.log(req, {
        user: req.session.user, action: 'chips_ingresados_por_escaneo', target: `${result.imported} chip(s)`,
        detail: `Operadora ${lote.operadora || '—'}, plan ${lote.plan || '—'}; ${result.errors.length} con error`,
      });
    }
    if (!result.errors.length) {
      req.flash('success', `${result.imported} chip(s) registrados en stock.`);
      return res.redirect('/celulares/chips?ubicacion=en_stock');
    }
    // Los que fallaron vuelven a la lista para corregirlos sin reescanear todo.
    const failed = new Set(result.errors.map((e) => e.row));
    res.render('mobileLines/scan', await scanView({
      lote, registrados: result.imported, errores: result.errors,
      pendientes: items.filter((it) => failed.has(it.row)).map((it) => ({ numero: lineService.digits(it.phone_number), iccid: lineService.digits(it.iccid) })),
    }));
  } catch (err) {
    next(err);
  }
});

// Operadora para varios chips a la vez (los marcados en el listado).
router.post('/operadora', canWrite, verifyCsrfToken, async (req, res, next) => {
  const back = typeof req.body.back === 'string' && req.body.back.startsWith('?') ? req.body.back : '';
  try {
    const ids = [...new Set(String(req.body.ids || '').split(',').map((v) => v.trim()).filter((v) => /^\d+$/.test(v)).map(Number))];
    const operadora = String(req.body.operadora || '').trim();
    if (!ids.length) req.flash('error', 'Marque al menos un chip.');
    else if (!operadora) req.flash('error', 'Elija la operadora que se asignará a los chips marcados.');
    else if (operadora.length > 50) req.flash('error', 'La operadora no puede superar los 50 caracteres.');
    else {
      const changed = await lineService.setOperadora(ids, operadora);
      await auditService.log(req, {
        user: req.session.user, action: 'chips_operadora_masiva', target: `${ids.length} chip(s)`,
        detail: `Operadora "${operadora}" asignada a ${ids.length} chip(s) marcados (${changed} cambiaron)`,
      });
      req.flash('success', `Operadora ${operadora} asignada a ${ids.length} chip(s)${changed !== ids.length ? ` (${changed} cambiaron; el resto ya la tenía)` : ''}.`);
    }
    res.redirect(`/celulares/chips${back}`);
  } catch (err) {
    next(err);
  }
});

router.get('/nuevo', canWrite, async (req, res, next) => {
  try {
    res.render('mobileLines/form', { title: 'Nuevo chip', item: { estado: 'activo' }, ...(await formOptions()) });
  } catch (err) {
    next(err);
  }
});

router.post('/nuevo', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const data = readForm(req.body);
    const errors = await lineService.validateLineData(data);
    if (data.phone_number && (await lineService.numberTaken(data.phone_number))) {
      errors.push(`Ya existe un chip con el número ${data.phone_number}.`);
    } else if (data.phone_number) {
      const conflict = await lineService.deviceChipConflict(data.phone_number, null);
      if (conflict) errors.push(conflict);
    }
    if (data.estado === 'de_baja') errors.push('Un chip nuevo no puede registrarse de baja.');
    if (errors.length) {
      errors.forEach((e) => req.flash('error', e));
      return res.redirect('/celulares/chips/nuevo');
    }
    const id = await lineService.saveLine(null, data, req.session.user.id);
    await auditService.log(req, {
      user: req.session.user, action: 'chip_creado', target: lineLabel(data),
      detail: `Operadora ${data.operadora || '—'}, plan ${data.plan || '—'}, costo ${data.costo_plan || '—'}, descuento ${data.descuento_plan || '—'}`,
    });
    req.flash('success', 'Chip registrado. Desde aquí puede ponerlo en un celular o asignarlo a una persona.');
    res.redirect(`/celulares/chips/${id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/editar', canWrite, async (req, res, next) => {
  try {
    const item = await lineService.getLine(req.params.id);
    if (!item) {
      req.flash('error', 'Chip no encontrado.');
      return res.redirect('/celulares/chips');
    }
    res.render('mobileLines/form', { title: `Editar chip ${item.phone_number}`, item, ...(await formOptions()) });
  } catch (err) {
    next(err);
  }
});

const FIELD_LABELS = {
  phone_number: 'Número', phone_country_code_id: 'País', iccid: 'ICCID', operadora: 'Operadora', plan: 'Plan',
  costo_plan: 'Costo mensual', descuento_plan: 'Descuento mensual', descuento_nota: 'Detalle del descuento', estado: 'Estado', notes: 'Notas',
};

router.post('/:id/editar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const old = await lineService.getLine(req.params.id);
    if (!old) {
      req.flash('error', 'Chip no encontrado.');
      return res.redirect('/celulares/chips');
    }
    const data = readForm(req.body);
    const errors = await lineService.validateLineData(data);
    if (data.phone_number && (await lineService.numberTaken(data.phone_number, old.id))) {
      errors.push(`Otro chip ya tiene el número ${data.phone_number}.`);
    }
    if (errors.length) {
      errors.forEach((e) => req.flash('error', e));
      return res.redirect(`/celulares/chips/${old.id}/editar`);
    }
    const norm = (v) => (v === null || v === undefined ? '' : String(v));
    const changes = Object.keys(FIELD_LABELS)
      .filter((k) => (k === 'costo_plan' || k === 'descuento_plan' ? norm(old[k] === null ? '' : Number(old[k])) !== norm(data[k] === null ? '' : Number(data[k])) : norm(old[k]) !== norm(data[k])))
      .map((k) => `${FIELD_LABELS[k]}: "${norm(old[k]) || '—'}" → "${norm(data[k]) || '—'}"`);
    await lineService.saveLine(old.id, data, req.session.user.id);
    if (changes.length) {
      await auditService.log(req, { user: req.session.user, action: 'chip_editado', target: lineLabel(old), detail: changes.join('; ') });
    }
    req.flash('success', changes.length ? 'Chip actualizado.' : 'No había cambios que guardar.');
    res.redirect(`/celulares/chips/${old.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/eliminar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const line = await lineService.deleteLine(req.params.id);
    if (!line) {
      req.flash('error', 'Chip no encontrado.');
      return res.redirect('/celulares/chips');
    }
    await auditService.log(req, {
      user: req.session.user, action: 'chip_eliminado', target: lineLabel(line),
      detail: `Operadora ${line.operadora || '—'}${line.device_id ? ', estaba en un celular (se quitó su número)' : ''}`,
    });
    req.flash('success', `Chip ${line.phone_number} eliminado.`);
    res.redirect('/celulares/chips');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/baja', canWrite, verifyCsrfToken, async (req, res, next) => {
  const back = `/celulares/chips/${req.params.id}`;
  try {
    const fecha = String(req.body.fecha_baja || '').trim();
    const motivo = String(req.body.motivo_baja || '').trim();
    const r = await lineService.dropLine(req.params.id, { fecha, motivo });
    await auditService.log(req, {
      user: req.session.user, action: 'chip_dado_de_baja', target: lineLabel(r.line),
      detail: `Baja desde ${fecha || 'hoy'}${motivo ? `; motivo: ${motivo}` : ''}`
        + (r.device ? `; retirado del celular IMEI ${r.device.imei}` : '')
        + (r.assignment ? `; se cerró su asignación a ${r.assignment.holder_name}` : ''),
    });
    req.flash('success', `Chip ${r.line.phone_number} dado de baja: ya no cuenta en lo que se paga.`);
    res.redirect(back);
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', err.message);
    res.redirect(back);
  }
});

router.post('/:id/reactivar', canWrite, verifyCsrfToken, async (req, res, next) => {
  const back = `/celulares/chips/${req.params.id}`;
  try {
    const line = await lineService.reactivateLine(req.params.id);
    await auditService.log(req, {
      user: req.session.user, action: 'chip_reactivado', target: lineLabel(line),
      detail: `Estaba de baja desde ${line.fecha_baja || '—'}${line.motivo_baja ? ` (${line.motivo_baja})` : ''}; vuelve a stock`,
    });
    req.flash('success', `Chip ${line.phone_number} reactivado: queda activo y en stock.`);
    res.redirect(back);
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', err.message);
    res.redirect(back);
  }
});

router.post('/:id/poner', canWrite, verifyCsrfToken, async (req, res, next) => {
  const back = `/celulares/chips/${req.params.id}`;
  try {
    const line = await lineService.getLine(req.params.id);
    const r = await lineService.placeInDevice(req.params.id, req.body.device);
    await auditService.log(req, {
      user: req.session.user, action: 'chip_puesto_en_celular', target: lineLabel(line),
      detail: `En el celular IMEI ${r.device.imei}${r.principal ? ' (chip principal)' : ' (segundo chip)'}`
        + (r.previous ? `; retirado del celular IMEI ${r.previous.imei}` : '')
        + (r.assignment ? `; se cerró su asignación a ${r.assignment.holder_name}` : ''),
    });
    req.flash('success', `Chip puesto en el celular ${r.device.imei}${r.principal ? ' como su número principal' : ' como segundo chip'}.`);
    res.redirect(back);
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', err.message);
    res.redirect(back);
  }
});

router.post('/:id/retirar', canWrite, verifyCsrfToken, async (req, res, next) => {
  const back = `/celulares/chips/${req.params.id}`;
  try {
    const line = await lineService.getLine(req.params.id);
    const device = await lineService.removeFromDevice(req.params.id);
    await auditService.log(req, {
      user: req.session.user, action: 'chip_retirado_de_celular', target: lineLabel(line),
      detail: `Retirado del celular IMEI ${device ? device.imei : '—'}; queda en stock`,
    });
    req.flash('success', 'Chip retirado del celular: queda en stock.');
    res.redirect(back);
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', err.message);
    res.redirect(back);
  }
});

router.post('/:id/asignar', canWrite, verifyCsrfToken, async (req, res, next) => {
  const back = `/celulares/chips/${req.params.id}`;
  try {
    const line = await lineService.getLine(req.params.id);
    const r = await lineService.assignLine(req.params.id, req.body, req.session.user.id);
    const uso = { emergencia: 'número de emergencia', repuesto: 'chip de repuesto' }[req.body.uso] || 'uso sin celular';
    await auditService.log(req, {
      user: req.session.user, action: 'chip_asignado', target: lineLabel(line),
      detail: `Asignado a ${r.holderName} (DNI ${req.body.dni}) como ${uso}${r.previous ? `; antes lo tenía ${r.previous.holder_name}` : ''}`,
    });
    req.flash('success', `Chip asignado a ${r.holderName} (${uso}).`);
    res.redirect(back);
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', err.message);
    res.redirect(back);
  }
});

router.post('/:id/devolver', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const line = await lineService.getLine(req.params.id);
    if (!line) {
      req.flash('error', 'Chip no encontrado.');
      return res.redirect('/celulares/chips');
    }
    const closed = await lineService.closeAssignment(line.id, 'Devuelto a stock');
    if (closed) {
      await auditService.log(req, {
        user: req.session.user, action: 'chip_devuelto_stock', target: lineLabel(line), detail: `Devuelto por ${closed.holder_name}`,
      });
    }
    req.flash('success', closed ? 'Chip devuelto a stock.' : 'El chip no tenía una asignación activa.');
    res.redirect(`/celulares/chips/${line.id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const detail = await lineService.getLineDetail(req.params.id);
    if (!detail) {
      req.flash('error', 'Chip no encontrado.');
      return res.redirect('/celulares/chips');
    }
    let foundEmployee = null;
    const dniQuery = (req.query.dni || '').trim();
    if (dniQuery) {
      foundEmployee = await employeeService.findByDni(dniQuery);
      if (!foundEmployee) req.flash('error', `No se encontró ningún empleado con DNI "${dniQuery}". Completa los datos para crearlo.`);
    }
    res.render('mobileLines/detail', {
      title: `Chip ${detail.line.phone_number}`,
      item: detail.line,
      history: detail.history,
      dniQuery,
      foundEmployee,
      ...(await formOptions()),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
