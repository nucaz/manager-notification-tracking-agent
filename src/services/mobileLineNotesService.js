// Segundas lineas anotadas a mano en las notas de los celulares (ej.
// "N° 2 (uso WhatsApp): 912 345 678"): antes de existir el doble SIM en la
// aplicacion, el segundo chip se escribia en las notas. Aqui se encuentran,
// se cruzan con los chips registrados y con los recibos de la operadora, y
// se registran como 2.o chip del equipo los que el usuario confirme.
const pool = require('../db/pool');
const mobileLineService = require('./mobileLineService');
const mobileBillService = require('./mobileBillService');

// Numeros moviles de Peru (9 digitos que empiezan con 9), con o sin +51 y
// con espacios, puntos o guiones entre digitos. No toma un tramo de una
// cifra mas larga (IMEI, ICCID).
const NUMBER = /(?<!\d)(?:\+?51[\s.-]*)?(9(?:[\s.-]?\d){8})(?![\d])/g;

function numbersIn(text) {
  const found = [];
  for (const m of String(text || '').matchAll(NUMBER)) {
    const n = m[1].replace(/\D/g, '');
    if (!found.includes(n)) found.push(n);
  }
  return found;
}

// El recibo mas reciente de cada operadora, con sus lineas por numero.
async function latestBills() {
  const [bills] = await pool.query(`
    SELECT b.* FROM mobile_bills b
    JOIN (SELECT operadora, MAX(fecha_emision) AS f FROM mobile_bills GROUP BY operadora) u ON u.operadora = b.operadora AND u.f = b.fecha_emision
    ORDER BY b.operadora`);
  const lineOf = new Map();
  const stats = [];
  for (const bill of bills) {
    const [lines] = await pool.query(
      `SELECT b.*, (m.id IS NOT NULL) AS registrado FROM mobile_bill_lines b
       LEFT JOIN mobile_lines m ON m.phone_number = b.phone_number WHERE b.bill_id = ?`,
      [bill.id]
    );
    lines.forEach((l) => { if (!lineOf.has(l.phone_number)) lineOf.set(l.phone_number, { bill, line: l }); });
    const registered = lines.filter((l) => Number(l.registrado)).length;
    stats.push({ bill, total: lines.length, registered, missing: lines.length - registered });
  }
  return { bills: stats, lineOf };
}

// Cada numero hallado en las notas, con lo que se puede hacer con el.
//   action: 'crear' (no existe como chip) | 'poner' (existe, en stock) | null (no se puede)
async function candidates() {
  const [devices] = await pool.query(`
    SELECT d.id, d.imei, d.asset_code, d.model, d.area, d.sede, d.status, d.phone_number, d.notes,
           (SELECT COUNT(*) FROM mobile_lines l WHERE l.device_id = d.id) AS chips
    FROM mobile_devices d WHERE d.notes REGEXP '9' ORDER BY d.area, d.asset_code, d.id`);
  const found = [];
  devices.forEach((d) => numbersIn(d.notes).forEach((number) => { if (number !== d.phone_number) found.push({ device: d, number }); }));
  if (!found.length) return { items: [], ...(await latestBills()) };

  const [chips] = await pool.query(
    `SELECT l.id, l.phone_number, l.device_id, l.estado, d.asset_code, d.imei, a.holder_name, a.uso
     FROM mobile_lines l
     LEFT JOIN mobile_devices d ON d.id = l.device_id
     LEFT JOIN mobile_line_assignments a ON a.line_id = l.id AND a.returned_date IS NULL
     WHERE l.phone_number IN (?)`,
    [[...new Set(found.map((f) => f.number))]]
  );
  const chipOf = new Map(chips.map((c) => [c.phone_number, c]));
  const billing = await latestBills();
  const seen = new Map(); // un mismo numero anotado en dos celulares
  found.forEach((f) => seen.set(f.number, (seen.get(f.number) || 0) + 1));

  const items = found.map(({ device, number }) => {
    const chip = chipOf.get(number);
    const billed = billing.lineOf.get(number) || null;
    let action = null;
    let reason = '';
    if (chip && String(chip.device_id) === String(device.id)) reason = 'Ya está registrado como chip de este celular.';
    else if (chip && chip.device_id) reason = `Está registrado en otro celular (${chip.asset_code || chip.imei}).`;
    else if (chip && chip.holder_name) reason = `Está asignado a ${chip.holder_name}.`;
    else if (chip && chip.estado === 'de_baja') reason = 'El chip está dado de baja.';
    else if (device.status === 'de_baja') reason = 'El celular está dado de baja.';
    else if (Number(device.chips) >= mobileLineService.MAX_CHIPS_PER_DEVICE) reason = 'El celular ya tiene 2 chips.';
    else if (seen.get(number) > 1) reason = 'El mismo número está anotado en más de un celular: revise cuál lo tiene.';
    else action = chip ? 'poner' : 'crear';
    return {
      key: `${device.id}:${number}`, device, number, chip: chip || null, action, reason,
      billed: billed ? { operadora: billed.bill.operadora, recibo: billed.bill.recibo_nro, fecha: billed.bill.fecha_emision, plan: billed.line.plan, cargo: billed.line.cargo_fijo,
        missing: !chip } : null,
    };
  });
  return { items, ...billing };
}

// Registra como 2.o chip los numeros elegidos (claves "idCelular:numero").
// Todo se vuelve a calcular aqui: solo se aplica lo que sigue siendo posible.
async function register(keys, userId) {
  const wanted = new Set((Array.isArray(keys) ? keys : [keys]).filter(Boolean).map(String));
  const { items, lineOf } = await candidates();
  const done = [];
  const failed = [];
  for (const item of items.filter((i) => wanted.has(i.key))) {
    if (!item.action) { failed.push({ item, error: item.reason }); continue; }
    try {
      let lineId = item.chip && item.chip.id;
      if (!lineId) {
        const billed = lineOf.get(item.number);
        const [[peru]] = await pool.query("SELECT id, mobile_length FROM phone_country_codes WHERE calling_code = '51' LIMIT 1");
        const note = `Registrado desde las notas del celular ${item.device.asset_code || item.device.imei}: ${item.device.notes}`.slice(0, 250);
        const [res] = await pool.query(
          `INSERT INTO mobile_lines (phone_country_code_id, phone_number, operadora, plan, costo_plan, descuento_plan, descuento_nota, estado, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'activo', ?, ?)`,
          [peru && item.number.length === peru.mobile_length ? peru.id : null, item.number,
            billed ? billed.bill.operadora : null, billed && billed.line.plan ? billed.line.plan.slice(0, 60) : null,
            billed ? billed.line.cargo_fijo : null, billed ? (mobileBillService.recurringDiscount(billed.line) || null) : null,
            billed ? mobileBillService.discountNote(billed.bill, billed.line) : null, note, userId || null]
        );
        lineId = res.insertId;
        try {
          await mobileLineService.placeInDevice(lineId, item.device.imei);
        } catch (err) {
          await pool.query('DELETE FROM mobile_lines WHERE id = ?', [lineId]);
          throw err;
        }
      } else {
        await mobileLineService.placeInDevice(lineId, item.device.imei);
      }
      done.push(item);
    } catch (err) {
      failed.push({ item, error: err.message });
    }
  }
  return { done, failed };
}

module.exports = { numbersIn, candidates, register, latestBills };
