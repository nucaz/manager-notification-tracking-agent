// Lo que dicen los recibos de la operadora sobre cada celular:
//   - el EQUIPO: si su IMEI se cobra en cuotas (cuota n de m, monto al mes)
//   - su LINEA: si el numero principal figura en el recibo
//   - su RESPALDO de compra: recibo (cuotas), fecha de compra o contrato
//     adjunto; si no tiene ninguno, "Sin respaldo"
// Se usa el ultimo recibo de cada operadora.
const pool = require('../db/pool');

const RESPALDO = {
  recibo: 'En cuotas (recibo)',
  compra: 'Fecha de compra',
  documento: 'Contrato o factura adjunta',
  ninguno: 'Sin respaldo de compra',
};

async function latestBillIds() {
  const [rows] = await pool.query(`
    SELECT b.id FROM mobile_bills b
    JOIN (SELECT operadora, MAX(fecha_emision) AS f FROM mobile_bills GROUP BY operadora) u ON u.operadora = b.operadora AND u.f = b.fecha_emision`);
  return rows.map((r) => r.id);
}

// Map imei -> { cuota, total, monto, operadora, recibo, modelo } (cuotas del ultimo recibo)
async function chargesByImei(billIds) {
  const map = new Map();
  if (!billIds.length) return map;
  const [rows] = await pool.query(
    `SELECT c.imei, c.cuota_nro, c.cuota_total, c.monto, c.modelo, b.operadora, b.recibo_nro
     FROM mobile_bill_charges c JOIN mobile_bills b ON b.id = c.bill_id
     WHERE c.bill_id IN (?) AND c.imei IS NOT NULL ORDER BY c.id`,
    [billIds]
  );
  rows.forEach((r) => {
    const prev = map.get(r.imei);
    if (prev) {
      prev.monto = Math.round((prev.monto + Number(r.monto || 0)) * 100) / 100;
      if ((r.cuota_nro || 0) > (prev.cuota || 0)) { prev.cuota = r.cuota_nro; prev.total = r.cuota_total; }
    } else {
      map.set(r.imei, { cuota: r.cuota_nro, total: r.cuota_total, monto: Number(r.monto || 0), operadora: r.operadora, recibo: r.recibo_nro, modelo: r.modelo });
    }
  });
  return map;
}

// Para cada celular (filas con id, imei, phone_number, has_chip, purchase_date)
// agrega: cuota, linea_en_recibo, respaldo (clave) y sus textos.
async function decorate(devices) {
  if (!devices.length) return devices;
  const billIds = await latestBillIds();
  const charges = await chargesByImei(billIds);
  const billed = new Set();
  if (billIds.length) {
    const [lines] = await pool.query('SELECT DISTINCT phone_number FROM mobile_bill_lines WHERE bill_id IN (?)', [billIds]);
    lines.forEach((l) => billed.add(l.phone_number));
  }
  const [docs] = await pool.query("SELECT DISTINCT entity_id FROM attachments WHERE entity_type = 'mobile_device'");
  const withDoc = new Set(docs.map((d) => String(d.entity_id)));
  return devices.map((d) => {
    const cuota = charges.get(d.imei) || null;
    const respaldo = cuota ? 'recibo' : d.purchase_date ? 'compra' : withDoc.has(String(d.id)) ? 'documento' : 'ninguno';
    const lineaEnRecibo = d.has_chip && d.phone_number ? billed.has(d.phone_number) : null;
    return {
      ...d,
      cuota,
      equipo_recibo: cuota ? `Cuota ${cuota.cuota || '?'} de ${cuota.total || '?'} · S/ ${cuota.monto.toFixed(2)}` : 'No',
      linea_recibo: lineaEnRecibo === null ? 'Sin número' : lineaEnRecibo ? 'Sí' : 'No',
      respaldo,
      respaldo_label: RESPALDO[respaldo],
    };
  });
}

module.exports = { RESPALDO, latestBillIds, chargesByImei, decorate };
