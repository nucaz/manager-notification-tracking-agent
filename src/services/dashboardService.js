// Tablero de celulares y chips: indicadores para decidir (comprar, dar de
// baja, subir o bajar el stock, renovar el contrato) y widgets: los
// predefinidos y los que arma cada usuario (agrupar por un campo, medir
// cantidad o monto, filtrar, barras / dona / tabla).
//
// Un widget es solo una configuracion validada contra este catalogo
// (conjunto de datos, campo, medida, filtro): nunca SQL. Se calcula sobre
// los mismos datos que Estadisticas y Uso real.
const pool = require('../db/pool');
const statsService = require('./deviceStatsService');
const usageService = require('./chipUsageService');
const labels = require('../config/mobileLabels');

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const text = (v, empty) => (v === null || v === undefined || String(v).trim() === '' ? empty : String(v));

// Meses que le quedan a un equipo en cuotas (la cuota actual ya se paga este mes).
function cuotasRestantes(d) {
  if (!d.cuota || !d.cuota.total || !d.cuota.cuota) return null;
  return Math.max(0, d.cuota.total - d.cuota.cuota);
}
function tramoCuotas(rest) {
  if (rest === null) return 'Sin cuotas en el recibo';
  if (rest === 0) return 'Última cuota (termina este mes)';
  if (rest <= 3) return 'Termina en 1 a 3 meses';
  if (rest <= 6) return 'Termina en 4 a 6 meses';
  if (rest <= 12) return 'Termina en 7 a 12 meses';
  return 'Más de 12 meses';
}

const DATASETS = {
  celulares: {
    label: 'Celulares',
    fields: {
      marca: 'Marca', modelo: 'Marca y modelo', estado: 'Estado', sede: 'Sede', area: 'Área', operadora: 'Operadora',
      chips: 'Chips por celular', respaldo: 'Respaldo de compra', cuotas: 'Fin de las cuotas', en_cuotas: 'En cuotas (recibo)',
      linea: 'Línea en el recibo', usuario: 'Persona asignada', condicion: 'Condición',
    },
    metrics: { cantidad: 'Cantidad de celulares', cuota: 'Cuota mensual del equipo (S/)' },
    // Columnas de la lista de detalle (al hacer clic en una cifra de un widget).
    columns: [['imei', 'IMEI'], ['codigo', 'Código'], ['marca', 'Marca'], ['modelo_solo', 'Modelo'], ['estado', 'Estado'], ['area', 'Área'], ['sede', 'Sede'],
      ['usuario', 'Usuario'], ['numero', 'Número'], ['chips', 'Chips'], ['equipo_recibo', 'Equipo en recibo'], ['respaldo', 'Respaldo de compra']],
    async rows() {
      const devices = await statsService.loadDevices();
      return devices.map((d) => {
        const rest = cuotasRestantes(d);
        return {
          marca: text(d.brand, 'Sin marca'), modelo: `${text(d.brand, 'Sin marca')} ${text(d.model, 'sin modelo')}`, estado: labels.deviceStatus(d.status).label,
          sede: text(d.sede, 'Sin sede'), area: text(d.area, 'Sin área'), operadora: text(d.operadora, 'Sin operadora'),
          chips: d.chips >= 2 ? '2 chips (doble SIM)' : d.chips === 1 ? '1 chip' : 'Sin chip',
          respaldo: d.respaldo_label, cuotas: tramoCuotas(rest), en_cuotas: d.cuota ? 'Sí' : 'No',
          linea: { 'Sí': 'Figura en el recibo', No: 'No figura en el recibo', 'Sin número': 'Sin número' }[d.linea_recibo],
          usuario: text(d.holder_name, 'Sin usuario'), condicion: { nuevo: 'Nuevo', usado: 'Usado' }[d.condicion] || 'Sin dato',
          _cuota: d.cuota ? d.cuota.monto : 0, _rest: rest, _status: d.status,
          imei: d.imei, codigo: text(d.asset_code, '—'), modelo_solo: text(d.model, '—'), numero: text(d.phone_number, '—'), equipo_recibo: d.equipo_recibo,
          _href: `/celulares/${d.id}`, _key: d.imei,
        };
      });
    },
  },
  chips: {
    label: 'Chips (líneas)',
    fields: {
      uso: 'Uso real', donde: 'Dónde está', operadora: 'Operadora', sede: 'Sede', area: 'Área', persona: 'Persona',
      plan: 'Plan', en_recibo: 'En el recibo',
    },
    metrics: { cantidad: 'Cantidad de chips', costo: 'Costo mensual (S/)' },
    columns: [['numero', 'Número'], ['operadora', 'Operadora'], ['plan', 'Plan'], ['uso', 'Uso real'], ['donde', 'Dónde está'], ['persona', 'Persona'],
      ['celular', 'Celular'], ['area', 'Área'], ['sede', 'Sede'], ['al_mes', 'Al mes (S/)'], ['en_recibo', 'En el recibo']],
    async rows() {
      const u = await usageService.usage();
      const out = [];
      Object.values(u.categories).forEach((c) => c.items.forEach((i) => out.push({
        uso: { uso: 'En uso', guardado: 'Guardado (se paga y no se usa)', baja: 'De baja' }[c.group], donde: c.label,
        operadora: text(i.operadora, 'Sin operadora'), sede: text(i.sede, 'Sin sede'), area: text(i.area, 'Sin área'),
        persona: text(i.holder, 'Sin persona'), plan: text(i.plan, 'Sin plan'), en_recibo: i.fromBill ? 'Sí' : 'No',
        _costo: Number(i.monthly) || 0, _group: c.group,
        numero: i.number, celular: text(i.device, '—'), al_mes: i.monthly === null || i.monthly === undefined ? '—' : Number(i.monthly).toFixed(2),
        _href: `/celulares/chips/${i.id}`, _key: i.number,
      })));
      return out;
    },
  },
};

const CHARTS = { barras: 'Barras', dona: 'Dona', tabla: 'Tabla' };

// Widgets que trae el tablero (no se pueden borrar; los propios si).
const PRESETS = [
  { title: 'Celulares por marca', dataset: 'celulares', groupBy: 'marca', metric: 'cantidad', chart: 'dona', top: 10 },
  { title: 'Celulares por cantidad de chips', dataset: 'celulares', groupBy: 'chips', metric: 'cantidad', chart: 'barras', top: 5 },
  { title: 'Celulares por sede', dataset: 'celulares', groupBy: 'sede', metric: 'cantidad', chart: 'barras', top: 12 },
  { title: 'Fin de las cuotas de los equipos (renovación)', dataset: 'celulares', groupBy: 'cuotas', metric: 'cantidad', chart: 'barras', top: 8 },
  { title: 'Chips por sede', dataset: 'chips', groupBy: 'sede', metric: 'cantidad', chart: 'barras', top: 12 },
  { title: 'Chips por uso real (costo mensual)', dataset: 'chips', groupBy: 'uso', metric: 'costo', chart: 'dona', top: 5 },
  { title: 'Áreas con chips (costo mensual)', dataset: 'chips', groupBy: 'area', metric: 'costo', chart: 'barras', top: 15, filter: { field: 'uso', value: 'En uso' } },
  { title: 'Personas con más chips', dataset: 'chips', groupBy: 'persona', metric: 'cantidad', chart: 'tabla', top: 15, filter: { field: 'uso', value: 'En uso' }, hideEmpty: 'Sin persona' },
  { title: 'Equipos en stock por modelo (disponibles)', dataset: 'celulares', groupBy: 'modelo', metric: 'cantidad', chart: 'tabla', top: 15, filter: { field: 'estado', value: 'En stock' } },
];

function validate(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const ds = DATASETS[c.dataset];
  if (!ds) throw new Error('Elija los datos del widget (celulares o chips).');
  if (!ds.fields[c.groupBy]) throw new Error('Elija por qué campo agrupar.');
  if (!ds.metrics[c.metric]) throw new Error('Elija qué medir.');
  const chart = CHARTS[c.chart] ? c.chart : 'barras';
  const top = Math.min(Math.max(parseInt(c.top, 10) || 10, 3), 50);
  let filter = null;
  if (c.filter && c.filter.field) {
    if (!ds.fields[c.filter.field]) throw new Error('El campo del filtro no existe.');
    const value = String(c.filter.value || '').trim().slice(0, 100);
    if (!value) throw new Error('Escriba el valor del filtro (o deje el filtro vacío).');
    filter = { field: c.filter.field, value };
  }
  const title = String(c.title || '').trim().slice(0, 80) || `${ds.label} por ${ds.fields[c.groupBy].toLowerCase()}`;
  return { title, dataset: c.dataset, groupBy: c.groupBy, metric: c.metric, chart, top, filter, hideEmpty: c.hideEmpty || null };
}

// Filas que entran en un widget (su filtro y, si tiene, el grupo que oculta).
function widgetRows(config, rows) {
  const wanted = config.filter ? config.filter.value.toLowerCase() : null;
  return rows.filter((r) => (!config.filter || String(r[config.filter.field]).toLowerCase() === wanted)
    && !(config.hideEmpty && r[config.groupBy] === config.hideEmpty));
}

// Calcula un widget sobre filas ya cargadas: [{ label, value, count }], total y resto.
function compute(config, rows) {
  const metricKey = config.metric === 'cantidad' ? null : `_${config.metric}`;
  const list = widgetRows(config, rows);
  const map = new Map();
  list.forEach((r) => {
    const k = r[config.groupBy];
    const g = map.get(k) || { label: k, value: 0, count: 0 };
    g.count += 1;
    g.value = metricKey ? money(g.value + (Number(r[metricKey]) || 0)) : g.count;
    map.set(k, g);
  });
  const all = [...map.values()].sort((a, b) => b.value - a.value || String(a.label).localeCompare(String(b.label), 'es'));
  const items = all.slice(0, config.top);
  const rest = all.slice(config.top);
  const total = metricKey ? money(all.reduce((t, g) => t + g.value, 0)) : all.reduce((t, g) => t + g.count, 0);
  if (rest.length) items.push({ label: `Otros (${rest.length})`, value: metricKey ? money(rest.reduce((t, g) => t + g.value, 0)) : rest.reduce((t, g) => t + g.count, 0), count: rest.reduce((t, g) => t + g.count, 0), otros: true });
  return { items, total, money: !!metricKey, rows: list.length, topLabels: items.filter((i) => !i.otros).map((i) => i.label) };
}

// Enlace a la lista de lo que hay detras de una cifra de un widget:
// value = el grupo; otros = el resto ("Otros (n)"); sin ninguno = todo el widget.
function detailUrl(config, { value, otros } = {}) {
  const p = new URLSearchParams({ dataset: config.dataset, groupBy: config.groupBy, metric: config.metric, top: String(config.top), title: config.title });
  if (config.filter) { p.set('filter_field', config.filter.field); p.set('filter_value', config.filter.value); }
  if (config.hideEmpty) p.set('hide', config.hideEmpty);
  if (otros) p.set('otros', '1');
  else if (value !== undefined && value !== null) p.set('value', String(value));
  return `/celulares/tablero/detalle?${p.toString()}`;
}

// La lista detras de una cifra. Vuelve a calcular el widget (para saber
// que grupos quedan en "Otros") y devuelve las filas, ordenadas.
async function detail(query) {
  const config = validate({
    title: query.title, dataset: query.dataset, groupBy: query.groupBy, metric: query.metric, top: query.top,
    filter: query.filter_field ? { field: query.filter_field, value: query.filter_value } : null, hideEmpty: query.hide || null,
  });
  const ds = DATASETS[config.dataset];
  const rows = await ds.rows();
  const base = widgetRows(config, rows);
  let list = base;
  let label = 'Todos';
  if (query.otros === '1') {
    const top = new Set(compute(config, rows).topLabels);
    list = base.filter((r) => !top.has(r[config.groupBy]));
    label = 'Otros';
  } else if (query.value !== undefined) {
    const v = String(query.value);
    list = base.filter((r) => String(r[config.groupBy]) === v);
    label = v;
  }
  const metricKey = config.metric === 'cantidad' ? null : `_${config.metric}`;
  list = [...list].sort((a, b) => (metricKey ? (b[metricKey] || 0) - (a[metricKey] || 0) : 0) || String(a._key).localeCompare(String(b._key), 'es', { numeric: true }));
  return {
    config, dataset: ds, label, groupLabel: ds.fields[config.groupBy], rows: list,
    total: metricKey ? money(list.reduce((t, r) => t + (Number(r[metricKey]) || 0), 0)) : list.length, money: !!metricKey,
  };
}

// Indicadores para decidir, sobre los datos de los dos conjuntos.
function decisions(cel, chips) {
  const enStock = cel.filter((d) => d._status === 'en_stock');
  const enUso = cel.filter((d) => d._status === 'asignado');
  const renovar = cel.filter((d) => d._rest !== null && d._rest <= 3);
  const guardados = chips.filter((c) => c._group === 'guardado');
  return {
    stock: { count: enStock.length, pagando: enStock.filter((d) => d.en_cuotas === 'Sí').length, cuota: money(enStock.reduce((t, d) => t + d._cuota, 0)),
      cobertura: enUso.length ? Math.round((enStock.length / enUso.length) * 1000) / 10 : 0 },
    reparacion: cel.filter((d) => ['en_reparacion', 'en_decomiso'].includes(d._status)).length,
    renovar: { count: renovar.length, cuota: money(renovar.reduce((t, d) => t + d._cuota, 0)), ultima: cel.filter((d) => d._rest === 0).length },
    guardados: { count: guardados.length, costo: money(guardados.reduce((t, c) => t + c._costo, 0)) },
    dobleSim: cel.filter((d) => d.chips === '2 chips (doble SIM)').length,
    sinRespaldo: cel.filter((d) => d.respaldo === 'Sin respaldo de compra').length,
  };
}

async function listWidgets(user) {
  const [rows] = await pool.query(
    'SELECT * FROM dashboard_widgets WHERE user_id = ? OR shared = 1 ORDER BY position, id',
    [user.id]
  );
  return rows.map((w) => {
    let config = null;
    try { config = validate(JSON.parse(w.config)); } catch (_) { config = null; }
    return { id: w.id, mine: w.user_id === user.id, shared: !!w.shared, config };
  }).filter((w) => w.config);
}

async function addWidget(user, raw, shared) {
  const config = validate(raw);
  const [[pos]] = await pool.query('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM dashboard_widgets');
  await pool.query('INSERT INTO dashboard_widgets (user_id, title, config, shared, position) VALUES (?, ?, ?, ?, ?)',
    [user.id, config.title, JSON.stringify(config), shared ? 1 : 0, pos.p]);
  return config;
}

// Solo quien lo creo (o un admin, si es compartido) lo puede quitar.
async function removeWidget(user, id) {
  const [res] = await pool.query(
    'DELETE FROM dashboard_widgets WHERE id = ? AND (user_id = ? OR (shared = 1 AND ? = 1))',
    [id, user.id, user.role === 'admin' ? 1 : 0]
  );
  return res.affectedRows > 0;
}

async function board(user) {
  const rowsByDataset = {};
  for (const [k, ds] of Object.entries(DATASETS)) rowsByDataset[k] = await ds.rows();
  const widgets = await listWidgets(user);
  const build = (config, extra) => ({ ...extra, config, result: compute(config, rowsByDataset[config.dataset]) });
  // Valores posibles de cada campo, para el formulario de "nuevo widget" (filtro).
  const values = {};
  for (const [k, ds] of Object.entries(DATASETS)) {
    values[k] = {};
    Object.keys(ds.fields).forEach((f) => { values[k][f] = [...new Set(rowsByDataset[k].map((r) => r[f]))].sort((a, b) => String(a).localeCompare(String(b), 'es')).slice(0, 200); });
  }
  return {
    decisions: decisions(rowsByDataset.celulares, rowsByDataset.chips),
    presets: PRESETS.map((p) => build(validate(p), { preset: true })),
    custom: widgets.map((w) => build(w.config, { id: w.id, mine: w.mine, shared: w.shared })),
    values,
  };
}

module.exports = { DATASETS, CHARTS, PRESETS, validate, compute, decisions, board, addWidget, removeWidget, listWidgets, cuotasRestantes, tramoCuotas, detailUrl, detail };
