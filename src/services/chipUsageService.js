// Uso real de las lineas: de todo lo que se paga, cuanto se usa de verdad
// y cuanto esta guardado (en custodia de una persona o de TI) pagandose sin
// uso. Cruza el inventario de chips con el ultimo recibo de cada operadora.
//
//   En uso     chip en un celular que tiene usuario (asignado o en reparacion),
//              asignado a una persona para su propio equipo, o de emergencia.
//   Guardado   chip de repuesto (lo guarda una persona), chip puesto en un
//              celular que esta en stock o en decomiso, o chip en stock.
//   De baja    ya no se paga.
//
// El monto de cada chip es el del ultimo recibo que lo factura (cargo fijo
// menos su descuento mensual); si no figura en ningun recibo, el costo
// registrado en el chip.
const lineService = require('./mobileLineService');
const notesService = require('./mobileLineNotesService');
const billService = require('./mobileBillService');

const DEVICE_IN_USE = ['asignado', 'en_reparacion'];

const CATEGORIES = {
  uso_celular: { group: 'uso', label: 'En un celular con usuario' },
  uso_personal: { group: 'uso', label: 'Asignado a una persona sin celular' },
  uso_emergencia: { group: 'uso', label: 'Número de emergencia' },
  guardado_repuesto: { group: 'guardado', label: 'Repuesto (lo guarda una persona)', ubicacion: 'repuesto' },
  guardado_celular: { group: 'guardado', label: 'En un celular que está en stock o en decomiso' },
  guardado_stock: { group: 'guardado', label: 'En stock (sin celular ni persona)', ubicacion: 'en_stock' },
  baja: { group: 'baja', label: 'De baja (ya no se paga)' },
};

const GROUPS = {
  uso: 'En uso',
  guardado: 'Guardado: se paga y no se usa (en custodia)',
  baja: 'De baja',
};

function categoryOf(chip) {
  if (chip.estado === 'de_baja') return 'baja';
  if (chip.ubicacion === 'en_celular') return DEVICE_IN_USE.includes(chip.device_status) ? 'uso_celular' : 'guardado_celular';
  if (chip.ubicacion === 'personal') return 'uso_personal';
  if (chip.ubicacion === 'emergencia') return 'uso_emergencia';
  if (chip.ubicacion === 'repuesto') return 'guardado_repuesto';
  return 'guardado_stock';
}

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const billNet = (l) => money(Math.max(0, (Number(l.cargo_fijo) || 0) - (billService.recurringDiscount(l) || 0)));

async function usage() {
  const chips = await lineService.listLines({});
  const { bills, lineOf } = await notesService.latestBills();
  const categories = Object.fromEntries(Object.entries(CATEGORIES).map(([k, c]) => [k, { ...c, key: k, count: 0, monthly: 0, withoutCost: 0, items: [] }]));
  const registered = new Set();
  const notBilled = [];

  for (const chip of chips) {
    registered.add(chip.phone_number);
    const key = categoryOf(chip);
    const billed = lineOf.get(chip.phone_number);
    const monthly = key === 'baja' ? 0 : (billed ? billNet(billed.line) : lineService.netCost(chip));
    const item = {
      id: chip.id, number: chip.phone_number, operadora: chip.operadora, plan: chip.plan || (billed && billed.line.plan) || null,
      monthly, fromBill: !!billed, holder: chip.holder || chip.line_holder || null, device: chip.asset_code || chip.imei || null,
      deviceStatus: chip.device_status || null, area: chip.area || null, sede: chip.sede || null,
    };
    const cat = categories[key];
    cat.count += 1;
    if (monthly === null || monthly === undefined) cat.withoutCost += 1;
    else cat.monthly = money(cat.monthly + monthly);
    cat.items.push(item);
    if (key !== 'baja' && !billed) notBilled.push({ ...item, category: cat.label });
  }

  // Lo que el recibo cobra y no esta en el inventario.
  const unlocated = [];
  for (const [number, { bill, line }] of lineOf.entries()) {
    if (!registered.has(number)) unlocated.push({ number, operadora: bill.operadora, recibo: bill.recibo_nro, plan: line.plan, monthly: billNet(line) });
  }
  const sum = (list) => money(list.reduce((t, i) => t + (Number(i.monthly) || 0), 0));
  const groupTotal = (group) => {
    const cats = Object.values(categories).filter((c) => c.group === group);
    return { count: cats.reduce((t, c) => t + c.count, 0), monthly: money(cats.reduce((t, c) => t + c.monthly, 0)), withoutCost: cats.reduce((t, c) => t + c.withoutCost, 0) };
  };
  const totals = {
    uso: groupTotal('uso'),
    guardado: groupTotal('guardado'),
    baja: groupTotal('baja'),
    unlocated: { count: unlocated.length, monthly: sum(unlocated) },
    notBilled: { count: notBilled.length, monthly: sum(notBilled) },
  };
  // Lo que se paga al mes segun los ultimos recibos (suma de sus lineas).
  totals.billedMonthly = money([...lineOf.values()].reduce((t, { line }) => t + billNet(line), 0));
  totals.billedLines = lineOf.size;
  const base = totals.uso.monthly + totals.guardado.monthly + totals.unlocated.monthly;
  const pct = (n) => (base ? Math.round((n / base) * 1000) / 10 : 0);
  totals.pct = { uso: pct(totals.uso.monthly), guardado: pct(totals.guardado.monthly), unlocated: pct(totals.unlocated.monthly) };

  unlocated.sort((a, b) => b.monthly - a.monthly || a.number.localeCompare(b.number));
  return { categories, groups: GROUPS, totals, unlocated, notBilled, bills: bills.map((b) => b.bill) };
}

module.exports = { CATEGORIES, GROUPS, categoryOf, usage };
