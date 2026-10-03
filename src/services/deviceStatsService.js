// Estadisticas de celulares: cuantos hay y donde, que se paga por los
// equipos (cuotas en el recibo de la operadora), cuales no tienen respaldo
// de compra, cuales cobra el recibo sin estar en el inventario, y que datos
// faltan (con la marca y el modelo que se pueden completar desde el recibo).
const pool = require('../db/pool');
const labels = require('../config/mobileLabels');
const billing = require('./deviceBillingService');
const modelService = require('./mobileModelService');

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const blank = (v) => v === null || v === undefined || String(v).trim() === '';

function countBy(rows, fn) {
  const map = new Map();
  rows.forEach((r) => { const k = fn(r); map.set(k, (map.get(k) || 0) + 1); });
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'es'));
}

async function loadDevices() {
  const [devices] = await pool.query(`
    SELECT d.*, a.holder_name, (SELECT COUNT(*) FROM mobile_lines l WHERE l.device_id = d.id) AS chips
    FROM mobile_devices d
    LEFT JOIN mobile_device_assignments a ON a.device_id = d.id AND a.returned_date IS NULL
    ORDER BY d.area, d.asset_code, d.id`);
  return billing.decorate(devices);
}

// Celulares sin marca o sin modelo cuyo equipo figura en algun recibo: se
// propone lo que dice el recibo, solo si es un modelo del catalogo. Nunca
// se pisa un dato ya cargado.
async function modelSuggestions(rows) {
  const missing = rows.filter((d) => blank(d.brand) || blank(d.model));
  if (!missing.length) return { items: [], unknown: [] };
  const [charges] = await pool.query(
    `SELECT c.imei, c.modelo FROM mobile_bill_charges c JOIN mobile_bills b ON b.id = c.bill_id
     WHERE c.imei IN (?) AND c.modelo IS NOT NULL ORDER BY b.fecha_emision DESC, c.id DESC`,
    [missing.map((d) => d.imei)]
  );
  const descOf = new Map();
  charges.forEach((c) => { if (!descOf.has(c.imei)) descOf.set(c.imei, c.modelo); });
  const models = await modelService.list({ activeOnly: true });
  const items = [];
  const unknown = [];
  for (const d of missing) {
    const desc = descOf.get(d.imei);
    if (!desc) continue;
    const match = modelService.matchDescription(desc, models);
    if (!match) { unknown.push({ id: d.id, asset_code: d.asset_code, imei: d.imei, desc }); continue; }
    const brand = blank(d.brand) ? match.brand : null;
    const model = blank(d.model) ? match.model : null;
    // Si ya tenia una marca distinta a la del recibo, no se completa el modelo (seria de otra marca).
    if (!blank(d.brand) && modelService.fold(d.brand) !== modelService.fold(match.brand)) { unknown.push({ id: d.id, asset_code: d.asset_code, imei: d.imei, desc }); continue; }
    if (brand || model) items.push({ id: d.id, asset_code: d.asset_code, imei: d.imei, desc, brand, model, currentBrand: d.brand, currentModel: d.model });
  }
  return { items, unknown };
}

async function applyModelSuggestions(ids) {
  const wanted = new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String));
  const { items } = await modelSuggestions(await loadDevices());
  const applied = [];
  for (const s of items.filter((i) => wanted.has(String(i.id)))) {
    // Solo los campos vacios (la condicion va en el propio UPDATE).
    const [res] = await pool.query(
      `UPDATE mobile_devices SET brand = IF(brand IS NULL OR TRIM(brand) = '', ?, brand), model = IF(model IS NULL OR TRIM(model) = '', ?, model),
         updated_at = NOW() WHERE id = ?`,
      [s.brand || null, s.model || null, s.id]
    );
    if (res.affectedRows) applied.push(s);
  }
  return applied;
}

async function stats() {
  const rows = await loadDevices();
  const billIds = await billing.latestBillIds();
  const charges = await billing.chargesByImei(billIds);
  const inInventory = new Set(rows.map((d) => d.imei));
  const unregistered = [...charges.entries()].filter(([imei]) => !inInventory.has(imei))
    .map(([imei, c]) => ({ imei, ...c })).sort((a, b) => b.monto - a.monto);
  const enCuotas = rows.filter((d) => d.cuota);
  const quality = {
    sinMarca: rows.filter((d) => blank(d.brand)).length,
    sinModelo: rows.filter((d) => blank(d.model)).length,
    sinCodigo: rows.filter((d) => blank(d.asset_code)).length,
    sinSede: rows.filter((d) => blank(d.sede)).length,
    sinOperadora: rows.filter((d) => d.has_chip && blank(d.operadora)).length,
    sinRespaldo: rows.filter((d) => d.respaldo === 'ninguno').length,
  };
  return {
    total: rows.length,
    porEstado: countBy(rows, (d) => labels.deviceStatus(d.status).label),
    porArea: countBy(rows, (d) => d.area || 'Sin área'),
    porSede: countBy(rows, (d) => d.sede || 'Sin sede'),
    porMarca: countBy(rows, (d) => d.brand || 'Sin marca'),
    porModelo: countBy(rows, (d) => [d.brand || 'Sin marca', d.model || 'sin modelo'].join(' · ')),
    porOperadora: countBy(rows, (d) => d.operadora || 'Sin operadora'),
    porRespaldo: countBy(rows, (d) => d.respaldo_label),
    porLinea: countBy(rows, (d) => ({ 'Sí': 'Su línea figura en el recibo', No: 'Su línea NO figura en el recibo', 'Sin número': 'Sin número' }[d.linea_recibo])),
    chips: { con: rows.filter((d) => d.chips > 0).length, sin: rows.filter((d) => !d.chips).length, doble: rows.filter((d) => d.chips >= 2).length },
    cuotas: {
      count: enCuotas.length,
      monthly: money(enCuotas.reduce((t, d) => t + d.cuota.monto, 0)),
      ultimas: enCuotas.filter((d) => d.cuota.total && d.cuota.cuota && d.cuota.total - d.cuota.cuota <= 1).length,
      sinUsuario: enCuotas.filter((d) => !['asignado', 'en_reparacion'].includes(d.status)).length,
      sinUsuarioMonthly: money(enCuotas.filter((d) => !['asignado', 'en_reparacion'].includes(d.status)).reduce((t, d) => t + d.cuota.monto, 0)),
    },
    unregistered: { count: unregistered.length, monthly: money(unregistered.reduce((t, c) => t + c.monto, 0)), items: unregistered },
    quality,
    suggestions: await modelSuggestions(rows),
    rows,
  };
}

module.exports = { stats, loadDevices, modelSuggestions, applyModelSuggestions };
