// Reportes y consultas: un catalogo de reportes con la misma forma, para
// que la pantalla, el Excel, el CSV y el PDF imprimible salgan de un solo
// lugar. Hay tres familias:
//   - vencimientos (licencias, dominios, ISP, servidores, certificados)
//   - inventario (celulares, chips y lo que se lee de GLPI), con codigo de
//     barras para la verificacion fisica
//   - DevOps (repositorios del sidecar)
//
// Cada reporte declara:
//   columns  -> columnas de pantalla y Excel/CSV: [{ key, label }]
//   print    -> columnas del PDF (pocas, las que sirven con el equipo en la mano): [{ key, label, w }]
//   barcodes -> que dato puede ir como codigo de barras: [{ key, label }] (el primero es el predeterminado)
//   selects  -> filtros de lista; sus opciones salen de los propios datos
//   groupBy  -> desgloses del resumen ("cuantos hay por...")
//   load()   -> todas las filas, ya con textos listos para mostrar
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { daysUntil, statusFromDays } = require('./expirationService');
const mobileLabels = require('../config/mobileLabels');
const mobileLineService = require('./mobileLineService');
const glpiClient = require('./glpiClient');
const devopsSidecarClient = require('./devopsSidecarClient');

const STATUS_LABEL = { vencido: 'Vencido', por_vencer: 'Por vencer', activo: 'Activo', sin_fecha: 'Sin fecha' };
const STATUS_BADGE = { vencido: 'bg-danger', por_vencer: 'bg-warning text-dark', activo: 'bg-success', sin_fecha: 'bg-secondary' };
const join = (...parts) => parts.filter((p) => p !== null && p !== undefined && String(p).trim() !== '').join(' ');
const pair = (a, b, sep = ' / ') => [a, b].filter((p) => p !== null && p !== undefined && String(p).trim() !== '').join(sep);
const stacked = (a, b) => pair(a, b, '\n'); // en el PDF, un dato por renglon de la celda
const money = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toFixed(2));

// ---------------------------------------------------------------------
// Vencimientos
// ---------------------------------------------------------------------
function expiry({ label, table, dateField, columns }) {
  return {
    label,
    group: 'Vencimientos',
    kind: 'vencimientos',
    columns: [...columns.map(([key, text]) => ({ key, label: text })), { key: 'days_left', label: 'Días restantes' },
      { key: 'estado', label: 'Estado', badge: (r) => STATUS_BADGE[r.computed_status] }],
    print: [...columns.map(([key, text]) => ({ key, label: text, w: key === columns[0][0] ? 2 : 1 })), { key: 'days_left', label: 'Días', w: 0.6 },
      { key: 'estado', label: 'Estado', w: 0.9 }],
    barcodes: [],
    selects: [],
    groupBy: [{ key: 'estado', label: 'Por estado' }],
    async load({ from, to, status } = {}) {
      const [rows] = await pool.query(`SELECT * FROM ${table}`);
      let list = rows.map((r) => {
        const days = daysUntil(r[dateField]);
        const computed = statusFromDays(days);
        return { ...r, _date: r[dateField], days_left: days, computed_status: computed, estado: STATUS_LABEL[computed] };
      });
      if (from) list = list.filter((r) => r._date && r._date >= from);
      if (to) list = list.filter((r) => r._date && r._date <= to);
      if (status) list = list.filter((r) => r.computed_status === status);
      return list.sort((a, b) => (a.days_left ?? 9999) - (b.days_left ?? 9999));
    },
  };
}

// ---------------------------------------------------------------------
// Inventario propio: celulares y chips
// ---------------------------------------------------------------------
const celulares = {
  label: 'Celulares (equipos)',
  group: 'Inventario',
  module: 'celulares',
  columns: [
    { key: 'asset_code', label: 'Código' }, { key: 'imei', label: 'IMEI' }, { key: 'brand', label: 'Marca' }, { key: 'model', label: 'Modelo' },
    { key: 'phone_number', label: 'Número' }, { key: 'numero_2', label: 'Número 2 (doble SIM)' }, { key: 'operadora', label: 'Operadora' },
    { key: 'estado', label: 'Estado' }, { key: 'area', label: 'Área' }, { key: 'sede', label: 'Sede' }, { key: 'holder_name', label: 'Asignado a' }, { key: 'cargo', label: 'Cargo' },
    { key: 'condicion', label: 'Condición' }, { key: 'purchase_date', label: 'Fecha de compra' },
  ],
  print: [
    { key: 'asset_code', label: 'Código', w: 0.75 }, { key: 'equipo', label: 'Equipo', w: 1.05 }, { key: 'numeros', label: 'Número(s)', w: 0.95 },
    { key: 'holder_name', label: 'Asignado a', w: 1.4 }, { key: 'lugar', label: 'Área / Sede', w: 1.3 }, { key: 'estado', label: 'Estado', w: 0.75 },
  ],
  barcodes: [{ key: 'imei', label: 'IMEI' }, { key: 'asset_code', label: 'Código interno' }, { key: 'phone_number', label: 'Número' }, { key: 'numero_2', label: 'Número 2' }],
  selects: [{ key: 'estado', label: 'Estado' }, { key: 'sede', label: 'Sede' }, { key: 'area', label: 'Área' }, { key: 'operadora', label: 'Operadora' }],
  groupBy: [{ key: 'estado', label: 'Por estado' }, { key: 'sede', label: 'Por sede' }],
  async load() {
    const [rows] = await pool.query(`
      SELECT d.*, a.holder_name, a.cargo,
             (SELECT GROUP_CONCAT(l.phone_number ORDER BY l.id SEPARATOR ', ') FROM mobile_lines l
              WHERE l.device_id = d.id AND (d.phone_number IS NULL OR l.phone_number <> d.phone_number)) AS numero_2
      FROM mobile_devices d
      LEFT JOIN mobile_device_assignments a ON a.device_id = d.id AND a.returned_date IS NULL
      ORDER BY d.sede IS NULL, d.sede, d.area, d.asset_code, d.id`);
    return rows.map((d) => ({
      ...d, estado: mobileLabels.deviceStatus(d.status).label, equipo: join(d.brand, d.model), lugar: stacked(d.area, d.sede),
      numeros: stacked(d.phone_number, d.numero_2),
    }));
  },
};

const chips = {
  label: 'Chips (líneas)',
  group: 'Inventario',
  module: 'celulares',
  columns: [
    { key: 'phone_number', label: 'Número' }, { key: 'operadora', label: 'Operadora' }, { key: 'iccid', label: 'ICCID' }, { key: 'plan', label: 'Plan' },
    { key: 'estado_label', label: 'Estado' }, { key: 'ubicacion_label', label: 'Ubicación' }, { key: 'asset_code', label: 'Celular (código)' },
    { key: 'imei', label: 'Celular (IMEI)' }, { key: 'holder', label: 'Titular' }, { key: 'area', label: 'Área' }, { key: 'sede', label: 'Sede' },
    { key: 'costo', label: 'Costo del plan' }, { key: 'descuento', label: 'Descuento' }, { key: 'neto', label: 'Se paga' },
  ],
  print: [
    { key: 'phone_number', label: 'Número', w: 1 }, { key: 'operadora', label: 'Operadora', w: 0.95 }, { key: 'ubicacion_label', label: 'Ubicación', w: 1 },
    { key: 'donde', label: 'Celular / Titular', w: 1.55 }, { key: 'lugar', label: 'Área / Sede', w: 1.5 }, { key: 'estado_label', label: 'Estado', w: 0.9 },
  ],
  barcodes: [{ key: 'phone_number', label: 'Número' }, { key: 'iccid', label: 'ICCID' }],
  selects: [{ key: 'estado_label', label: 'Estado' }, { key: 'operadora', label: 'Operadora' }, { key: 'ubicacion_label', label: 'Ubicación' },
    { key: 'sede', label: 'Sede' }],
  groupBy: [{ key: 'operadora', label: 'Por operadora' }, { key: 'estado_label', label: 'Por estado' }, { key: 'ubicacion_label', label: 'Por ubicación' }],
  async load() {
    const rows = await mobileLineService.listLines({});
    return rows.map((l) => ({
      ...l, estado_label: mobileLabels.lineEstado(l.estado).label, ubicacion_label: mobileLabels.lineUbicacion(l.ubicacion).label,
      donde: stacked(l.asset_code, l.holder), lugar: stacked(l.area, l.sede),
      costo: money(l.costo_plan), descuento: money(l.descuento_plan), neto: money(mobileLineService.netCost(l)),
    }));
  },
};

// ---------------------------------------------------------------------
// Inventario de GLPI: computadoras, monitores e impresoras
// ---------------------------------------------------------------------
function glpi(typeKey) {
  const type = glpiClient.ASSET_TYPES[typeKey];
  return {
    label: `${type.label} (GLPI)`,
    group: 'Inventario',
    module: 'glpi_inventario',
    columns: [{ key: 'id', label: 'ID GLPI' }, ...type.columns.map((c) => ({ key: c.key, label: c.label }))],
    print: [
      { key: 'name', label: 'Nombre', w: 1.2 }, { key: 'equipo', label: 'Fabricante / Modelo', w: 1.4 }, { key: 'user', label: 'Usuario', w: 1 },
      { key: 'location', label: 'Ubicación', w: 1.3 }, { key: 'state', label: 'Estado', w: 0.8 },
    ],
    barcodes: [{ key: 'serial', label: 'N.º de serie' }, { key: 'otherserial', label: 'N.º de inventario' }, { key: 'name', label: 'Nombre' }],
    selects: [{ key: 'state', label: 'Estado' }, { key: 'entity', label: 'Entidad' }, { key: 'location', label: 'Ubicación' }, { key: 'type', label: 'Tipo' }],
    groupBy: [{ key: 'state', label: 'Por estado' }, { key: 'entity', label: 'Por entidad' }, { key: 'type', label: 'Por tipo' }],
    async load() {
      const rows = await glpiClient.listAllItems(typeKey, {});
      return rows.map((r) => ({ ...r, equipo: pair(r.manufacturer, r.model) }))
        .sort((a, b) => String(a.location || '').localeCompare(String(b.location || ''), 'es') || String(a.name || '').localeCompare(String(b.name || ''), 'es'));
    },
  };
}

// ---------------------------------------------------------------------
// DevOps: repositorios que vigila el sidecar
// ---------------------------------------------------------------------
const dateTime = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) : '');
const repositorios = {
  label: 'Repositorios (DevOps)',
  group: 'DevOps',
  adminOnly: true, // el modulo DevOps es solo de administradores
  columns: [
    { key: 'name', label: 'Repositorio' }, { key: 'github_url', label: 'GitHub' }, { key: 'activo', label: 'Activo' },
    { key: 'sync_interval_minutes', label: 'Sincroniza cada (min)' }, { key: 'ultima_sync', label: 'Última sincronización' },
    { key: 'last_sync_status', label: 'Resultado' }, { key: 'ultima_auditoria', label: 'Última auditoría IA' },
  ],
  print: [
    { key: 'name', label: 'Repositorio', w: 1.2 }, { key: 'github_url', label: 'GitHub', w: 2 }, { key: 'activo', label: 'Activo', w: 0.5 },
    { key: 'ultima_sync', label: 'Última sincronización', w: 1 }, { key: 'last_sync_status', label: 'Resultado', w: 1 },
    { key: 'ultima_auditoria', label: 'Última auditoría IA', w: 1 },
  ],
  barcodes: [],
  selects: [{ key: 'activo', label: 'Activo' }],
  groupBy: [{ key: 'activo', label: 'Activos' }, { key: 'last_sync_status', label: 'Por resultado de la última sincronización' }],
  async load() {
    const repos = await devopsSidecarClient.listRepos();
    return Promise.all(repos.map(async (repo) => {
      let audit = '';
      try {
        const last = await devopsSidecarClient.latestReport(repo.id);
        audit = last && last.found ? join(last.report_date, last.ai_provider_used ? `(${last.ai_provider_used})` : '') : 'Sin auditorías';
      } catch (_) { audit = ''; }
      return { ...repo, activo: repo.active ? 'Sí' : 'No', ultima_sync: dateTime(repo.last_synced_at) || 'Nunca', ultima_auditoria: audit };
    }));
  },
};

const REPORTS = {
  license: expiry({ label: 'Licencias de software', table: 'software_licenses', dateField: 'expiration_date',
    columns: [['product_name', 'Producto'], ['vendor', 'Proveedor'], ['assigned_to', 'Asignado a'], ['seats', 'Puestos'], ['cost', 'Costo'],
      ['currency', 'Moneda'], ['expiration_date', 'Vence']] }),
  domain: expiry({ label: 'Dominios', table: 'domains', dateField: 'expiration_date',
    columns: [['domain_name', 'Dominio'], ['registrar', 'Registrador'], ['responsible', 'Responsable'], ['renewal_cost', 'Costo de renovación'],
      ['currency', 'Moneda'], ['expiration_date', 'Vence']] }),
  isp_contract: expiry({ label: 'Contratos ISP', table: 'isp_contracts', dateField: 'end_date',
    columns: [['provider', 'Proveedor'], ['contract_number', 'N.º de contrato'], ['bandwidth_down', 'Bajada'], ['bandwidth_up', 'Subida'],
      ['monthly_cost', 'Costo mensual'], ['currency', 'Moneda'], ['end_date', 'Termina']] }),
  server: expiry({ label: 'Servidores y Activos TI', table: 'servers', dateField: 'support_expiration_date',
    columns: [['name', 'Nombre'], ['asset_type', 'Tipo de activo'], ['environment', 'Ambiente'], ['criticality', 'Criticidad'],
      ['responsible', 'Responsable'], ['status', 'Situación'], ['support_expiration_date', 'Vence el soporte']] }),
  certificate: expiry({ label: 'Certificados TLS', table: 'certificates', dateField: 'expiration_date',
    columns: [['common_name', 'Dominio cubierto'], ['certificate_type', 'Tipo'], ['issuer', 'Emisor'], ['responsible', 'Responsable'],
      ['cost', 'Costo'], ['currency', 'Moneda'], ['expiration_date', 'Vence']] }),
  celulares,
  chips,
  glpi_computadoras: glpi('computadoras'),
  glpi_monitores: glpi('monitores'),
  glpi_impresoras: glpi('impresoras'),
  repositorios,
};

// Reportes que puede abrir este usuario: los de inventario piden tener
// habilitado el modulo de donde salen los datos.
function available(user, enabledModules) {
  return Object.fromEntries(Object.entries(REPORTS).filter(([, r]) => {
    if (r.adminOnly) return user && user.role === 'admin';
    return !r.module || !!(enabledModules || {})[r.module];
  }));
}

const text = (value) => (value === null || value === undefined ? '' : String(value));
const fold = (value) => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Carga el reporte y aplica los filtros de la pantalla. Las opciones de
// cada filtro de lista salen de los datos SIN filtrar, para poder cambiar
// de una opcion a otra.
async function run(report, query = {}) {
  const all = await report.load({ from: query.from || '', to: query.to || '', status: query.status || '' });
  const selects = report.selects.map((s) => ({
    ...s,
    name: `f_${s.key}`,
    value: text(query[`f_${s.key}`]),
    options: [...new Set(all.map((r) => text(r[s.key])).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es')),
  }));
  const q = fold(query.q).trim();
  const keys = [...new Set([...report.columns, ...report.barcodes].map((c) => c.key))];
  const rows = all.filter((r) => selects.every((s) => !s.value || text(r[s.key]) === s.value)
    && (!q || keys.some((k) => fold(r[k]).includes(q))));
  const barcode = report.barcodes.find((b) => b.key === query.barras) || report.barcodes[0] || null;
  return { rows, selects, barcode, summary: summarize(report, rows), filtersText: describeFilters(report, query, selects) };
}

function summarize(report, rows) {
  return {
    total: rows.length,
    groups: report.groupBy.map((g) => {
      const counts = new Map();
      rows.forEach((r) => { const k = text(r[g.key]) || 'Sin dato'; counts.set(k, (counts.get(k) || 0) + 1); });
      return { label: g.label, items: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es')) };
    }).filter((g) => g.items.length),
  };
}

function describeFilters(report, query, selects) {
  const parts = selects.filter((s) => s.value).map((s) => `${s.label}: ${s.value}`);
  if (text(query.q).trim()) parts.push(`Búsqueda: "${text(query.q).trim()}"`);
  if (report.kind === 'vencimientos') {
    if (query.from) parts.push(`Vence desde ${query.from}`);
    if (query.to) parts.push(`Vence hasta ${query.to}`);
    if (query.status && STATUS_LABEL[query.status]) parts.push(`Estado: ${STATUS_LABEL[query.status]}`);
  }
  return parts.join(' · ');
}

function now() {
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: process.env.TZ || 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date()).replace(',', '');
}

function csvEscape(value) {
  const str = text(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function buildCsv(report, rows) {
  const lines = [report.columns.map((c) => csvEscape(c.label)).join(',')];
  rows.forEach((r) => lines.push(report.columns.map((c) => csvEscape(r[c.key])).join(',')));
  return String.fromCharCode(0xFEFF) + lines.join('\n'); // BOM: Excel lee bien los acentos
}

// Excel: hoja "Resumen" (cuantos hay, en total y por grupo) y hoja "Datos".
async function buildWorkbook(report, result, meta) {
  const workbook = new ExcelJS.Workbook();
  const resumen = workbook.addWorksheet('Resumen');
  resumen.addRow([`Reporte: ${report.label}`]).font = { bold: true, size: 14 };
  resumen.addRow([`Generado el ${meta.generatedAt} por ${meta.generatedBy}`]);
  if (result.filtersText) resumen.addRow([`Filtros: ${result.filtersText}`]);
  resumen.addRow([]);
  resumen.addRow(['Total de registros', result.summary.total]).font = { bold: true };
  result.summary.groups.forEach((g) => {
    resumen.addRow([]);
    resumen.addRow([g.label, 'Cantidad']).font = { bold: true };
    g.items.forEach((i) => resumen.addRow([i[0], i[1]]));
  });
  resumen.getColumn(1).width = 46;
  resumen.getColumn(2).width = 14;

  const datos = workbook.addWorksheet('Datos');
  datos.addRow(report.columns.map((c) => c.label)).font = { bold: true };
  result.rows.forEach((r) => datos.addRow(report.columns.map((c) => {
    const v = r[c.key];
    return v === null || v === undefined ? '' : (typeof v === 'number' ? v : String(v));
  })));
  datos.views = [{ state: 'frozen', ySplit: 1 }];
  datos.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: report.columns.length } };
  datos.columns.forEach((col) => { col.width = 22; });
  return workbook.xlsx.writeBuffer();
}

module.exports = { REPORTS, STATUS_LABEL, available, run, now, buildCsv, buildWorkbook };
