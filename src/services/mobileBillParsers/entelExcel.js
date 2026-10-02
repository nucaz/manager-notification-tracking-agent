// Excel de detalle que entrega Entel Peru por cada recibo. Hojas:
// - "Resumen": etiqueta / valor (recibo, cuenta, periodo, total, vencimiento).
// - la de lineas (lleva el numero de cuenta por nombre): encabezado en varias
//   filas y una fila por numero; se ubica por la columna "Número Entel".
// - "Otros Cargos y Abonos" (y su variante "ya gravados con IGV"): texto y
//   monto; las cuotas de equipos traen modelo, IMEI y folio en el texto.
const { BillFormatError, norm, money, round2, isoDate, reciboNumber, chargeFromText } = require('./common');

function raw(cell) {
  const v = cell.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) return v.result;
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    return cell.text;
  }
  return v;
}

// Columna de cada encabezado buscado (el encabezado ocupa varias filas con
// celdas combinadas, asi que se busca el texto en las primeras filas).
function findColumns(sheet, wanted) {
  const cols = {};
  for (let r = 1; r <= Math.min(8, sheet.rowCount); r++) {
    sheet.getRow(r).eachCell((cell, c) => {
      const key = norm(raw(cell));
      if (wanted.includes(key) && !cols[key]) cols[key] = c;
    });
  }
  return cols;
}

function linesSheet(workbook) {
  return workbook.worksheets.find((s) => findColumns(s, ['numero entel'])['numero entel']);
}

function detect(workbook) {
  return !!linesSheet(workbook);
}

function parse(workbook) {
  const sheet = linesSheet(workbook);
  const H = ['numero entel', 'plan tarifario', 'cargo fijo', 'prom. y dsctos.', 'monto total', 'recibo no', 'cuenta'];
  const col = findColumns(sheet, H);
  for (const k of ['plan tarifario', 'cargo fijo', 'prom. y dsctos.', 'monto total']) {
    if (!col[k]) throw new BillFormatError(`El Excel parece de Entel, pero no se encontró la columna "${k}". ¿Cambió el formato del archivo?`);
  }

  const resumen = {};
  const rs = workbook.worksheets.find((s) => norm(s.name) === 'resumen');
  if (rs) {
    rs.eachRow((row) => {
      const label = norm(raw(row.getCell(1))).replace(/:$/, '').trim();
      if (label) resumen[label] = raw(row.getCell(2));
    });
  }

  const lines = [];
  let recibo = resumen['recibo no'];
  let cuenta = resumen.cuenta;
  sheet.eachRow((row) => {
    const numero = String(raw(row.getCell(col['numero entel'])) ?? '').trim();
    if (!/^\d{7,12}$/.test(numero)) return; // encabezados, subtotales y filas vacias
    const cargoFijo = money(raw(row.getCell(col['cargo fijo']))) || 0;
    const descuento = money(raw(row.getCell(col['prom. y dsctos.']))) || 0;
    const total = money(raw(row.getCell(col['monto total']))) || 0;
    if (!recibo && col['recibo no']) recibo = raw(row.getCell(col['recibo no']));
    if (!cuenta && col.cuenta) cuenta = raw(row.getCell(col.cuenta));
    lines.push({
      phone_number: numero,
      plan: String(raw(row.getCell(col['plan tarifario'])) ?? '').trim().slice(0, 80) || null,
      cargo_fijo: cargoFijo,
      descuento,
      otros: round2(total - cargoFijo - descuento),
      monto_total: total,
      descuento_tipo: null,
      descuento_cuota: null,
      descuento_cuotas: null,
    });
  });

  const charges = [];
  workbook.worksheets.filter((s) => norm(s.name).startsWith('otros cargos')).forEach((s) => {
    s.eachRow((row, r) => {
      if (r === 1) return;
      const text = String(raw(row.getCell(1)) ?? '').trim();
      const monto = money(raw(row.getCell(2)));
      if (!text || monto === null) return; // la ultima fila es el total, sin texto
      charges.push(chargeFromText(text, monto));
    });
  });

  return {
    operadora: 'Entel',
    origen: 'excel',
    recibo_nro: reciboNumber(recibo),
    cuenta: cuenta ? String(cuenta).trim() : null,
    razon_social: resumen['razon social'] ? String(resumen['razon social']).trim() : null,
    ruc: resumen.ruc ? String(resumen.ruc).trim() : null,
    fecha_emision: isoDate(resumen['emision del recibo']),
    periodo_inicio: isoDate(resumen['inicio del periodo']),
    periodo_fin: isoDate(resumen['fin del periodo']),
    fecha_vencimiento: isoDate(resumen['ultimo dia de pago']),
    total_pagar: money(resumen['recibo del mes']),
    saldo_anterior: 0,
    lines,
    charges,
  };
}

module.exports = { name: 'Entel (Excel de detalle)', detect, parse };
