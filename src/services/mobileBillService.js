// Recibos de operadoras del modulo Celulares: carga, cruce contra el
// inventario y acciones sobre los chips.
//
// Del recibo solo se guarda lo facturado (mobile_bills, _lines, _charges).
// El cruce se calcula cada vez que se consulta, contra el inventario de ese
// momento: al registrar un chip faltante, deja de salir como faltante.
//
// El recibo trae dos listas que no se relacionan entre si: numeros (lineas)
// y equipos con cuota (IMEI). Por eso hay tres cruces independientes:
// numero del recibo -> chips, IMEI del recibo -> celulares, e inventario ->
// recibo (lo que se tiene registrado y la operadora no factura).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const lineService = require('./mobileLineService');
const labels = require('../config/mobileLabels');
const { DIRS } = require('./uploadService');
const { parseBill, BillFormatError } = require('./mobileBillParsers');

const RESULTS = ['coincide', 'observado', 'faltante'];
const round2 = (n) => Math.round(n * 100) / 100;
const sum = (rows, f) => round2(rows.reduce((s, r) => s + (Number(f(r)) || 0), 0));

// ---------------------------------------------------------------------
// Carga
// ---------------------------------------------------------------------
function checkParsed(parsed) {
  if (!parsed.recibo_nro) throw new BillFormatError('No se pudo leer el número de recibo del archivo.');
  if (!parsed.lines.length) throw new BillFormatError('El archivo no trae ninguna línea facturada.');
  const seen = new Set();
  for (const l of parsed.lines) {
    if (seen.has(l.phone_number)) throw new BillFormatError(`El número ${l.phone_number} aparece más de una vez en el recibo: no se cargó nada.`);
    seen.add(l.phone_number);
  }
  parsed.total_lineas = sum(parsed.lines, (l) => l.monto_total);
  parsed.total_cargos = sum(parsed.charges, (c) => c.monto);
}

async function insertMany(conn, sql, rows) {
  for (let i = 0; i < rows.length; i += 500) await conn.query(sql, [rows.slice(i, i + 500)]);
}

function removeStored(name) {
  if (!name) return;
  fs.promises.unlink(path.join(DIRS.recibos, path.basename(name))).catch(() => {});
}

// Lee el archivo y guarda el recibo. Subir de nuevo el mismo recibo (misma
// operadora y numero) lo reemplaza completo.
async function importBill({ buffer, filename, userId }) {
  const parsed = await parseBill(buffer, filename);
  checkParsed(parsed);
  const [[existing]] = await pool.query(
    'SELECT id, origen, archivo_guardado FROM mobile_bills WHERE operadora = ? AND recibo_nro = ?',
    [parsed.operadora, parsed.recibo_nro]
  );
  if (existing && existing.origen === 'pdf' && parsed.origen === 'excel') {
    throw new BillFormatError(
      `El recibo ${parsed.recibo_nro} ya está cargado desde su PDF, que trae más detalle que el Excel (tipo de descuento y número de cuota). `
      + 'Si quiere reemplazarlo por el Excel, elimine primero el recibo cargado.'
    );
  }
  const stored = `${Date.now()}_${crypto.randomBytes(12).toString('hex')}${path.extname(filename).toLowerCase()}`;
  await fs.promises.writeFile(path.join(DIRS.recibos, stored), buffer);

  const head = [
    parsed.cuenta, parsed.razon_social, parsed.ruc, parsed.fecha_emision, parsed.periodo_inicio, parsed.periodo_fin,
    parsed.fecha_vencimiento, parsed.total_pagar, parsed.total_lineas, parsed.total_cargos, parsed.saldo_anterior || 0,
    parsed.origen, String(filename).slice(0, 255), stored, userId || null,
  ];
  const conn = await pool.getConnection();
  let id;
  try {
    await conn.beginTransaction();
    if (existing) {
      id = existing.id;
      await conn.query(
        `UPDATE mobile_bills SET cuenta = ?, razon_social = ?, ruc = ?, fecha_emision = ?, periodo_inicio = ?, periodo_fin = ?,
           fecha_vencimiento = ?, total_pagar = ?, total_lineas = ?, total_cargos = ?, saldo_anterior = ?, origen = ?,
           archivo_nombre = ?, archivo_guardado = ?, uploaded_by = ? WHERE id = ?`,
        [...head, id]
      );
      await conn.query('DELETE FROM mobile_bill_lines WHERE bill_id = ?', [id]);
      await conn.query('DELETE FROM mobile_bill_charges WHERE bill_id = ?', [id]);
    } else {
      const [ins] = await conn.query(
        `INSERT INTO mobile_bills (operadora, recibo_nro, cuenta, razon_social, ruc, fecha_emision, periodo_inicio, periodo_fin,
           fecha_vencimiento, total_pagar, total_lineas, total_cargos, saldo_anterior, origen, archivo_nombre, archivo_guardado, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [parsed.operadora, parsed.recibo_nro, ...head]
      );
      id = ins.insertId;
    }
    await insertMany(
      conn,
      `INSERT INTO mobile_bill_lines (bill_id, phone_number, plan, cargo_fijo, descuento, otros, monto_total,
         descuento_tipo, descuento_cuota, descuento_cuotas) VALUES ?`,
      parsed.lines.map((l) => [id, l.phone_number, l.plan, l.cargo_fijo, l.descuento, l.otros, l.monto_total,
        l.descuento_tipo, l.descuento_cuota, l.descuento_cuotas])
    );
    await insertMany(
      conn,
      'INSERT INTO mobile_bill_charges (bill_id, descripcion, imei, modelo, folio, cuota_nro, cuota_total, monto) VALUES ?',
      parsed.charges.map((c) => [id, c.descripcion, c.imei, c.modelo, c.folio, c.cuota_nro, c.cuota_total, c.monto])
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    removeStored(stored);
    throw err;
  } finally {
    conn.release();
  }
  if (existing) removeStored(existing.archivo_guardado);
  return { id, replaced: !!existing, parsed };
}

// Diferencia entre el total del recibo y lo que se leyo (lineas + cargos de
// cuenta + saldo anterior). Distinta de cero = revisar: falto leer algo.
function diferencia(bill) {
  if (bill.total_pagar === null || bill.total_pagar === undefined) return null;
  return round2(Number(bill.total_pagar) - Number(bill.total_lineas) - Number(bill.total_cargos) - Number(bill.saldo_anterior));
}

async function listBills() {
  const [rows] = await pool.query(
    `SELECT b.*, u.full_name AS uploaded_by_name,
            (SELECT COUNT(*) FROM mobile_bill_lines l WHERE l.bill_id = b.id) AS lineas,
            (SELECT COUNT(*) FROM mobile_bill_charges c WHERE c.bill_id = b.id AND c.imei IS NOT NULL) AS equipos,
            (SELECT COUNT(*) FROM mobile_bill_lines l LEFT JOIN mobile_lines m ON m.phone_number = l.phone_number
              WHERE l.bill_id = b.id AND m.id IS NULL) AS lineas_faltantes
     FROM mobile_bills b LEFT JOIN users u ON u.id = b.uploaded_by
     ORDER BY b.fecha_emision IS NULL, b.fecha_emision DESC, b.id DESC`
  );
  rows.forEach((b) => { b.diferencia = diferencia(b); });
  return rows;
}

async function getBill(id) {
  const [[bill]] = await pool.query(
    'SELECT b.*, u.full_name AS uploaded_by_name FROM mobile_bills b LEFT JOIN users u ON u.id = b.uploaded_by WHERE b.id = ?',
    [id]
  );
  if (!bill) return null;
  bill.diferencia = diferencia(bill);
  return bill;
}

async function deleteBill(id) {
  const bill = await getBill(id);
  if (!bill) return null;
  await pool.query('DELETE FROM mobile_bills WHERE id = ?', [id]);
  removeStored(bill.archivo_guardado);
  return bill;
}

function storedPath(bill) {
  return bill.archivo_guardado ? path.join(DIRS.recibos, path.basename(bill.archivo_guardado)) : null;
}

// ---------------------------------------------------------------------
// Cruce
// ---------------------------------------------------------------------
function classifyLine(chip) {
  if (!chip) return ['faltante', 'No figura en el inventario'];
  if (chip.estado === 'de_baja') return ['observado', 'Chip dado de baja en el inventario, pero se sigue facturando'];
  if (chip.estado === 'suspendido') return ['observado', 'Chip suspendido en el inventario, pero se sigue facturando'];
  if (chip.ubicacion === 'en_stock') return ['observado', 'Chip en stock: sin celular ni persona asignada'];
  if (chip.ubicacion === 'en_celular') {
    if (chip.device_status !== 'asignado') return ['observado', `Su celular está: ${labels.deviceStatus(chip.device_status).label.toLowerCase()}`];
    if (!chip.holder) return ['observado', 'Su celular no tiene usuario asignado'];
  }
  return ['coincide', 'Coincide con el inventario'];
}

function classifyDevice(device) {
  if (!device) return ['faltante', 'IMEI no figura en el inventario'];
  if (device.status === 'de_baja' || device.status === 'en_decomiso') {
    return ['observado', `Celular ${labels.deviceStatus(device.status).label.toLowerCase()}, pero se sigue cobrando su cuota`];
  }
  if (!device.phone_number) return ['observado', 'En inventario pero sin número'];
  if (!device.holder_name) return ['observado', 'En inventario pero sin usuario asignado'];
  return ['coincide', 'Coincide con el inventario'];
}

function tally(rows, amount) {
  const t = { total: rows.length, monto: amount ? sum(rows, amount) : null };
  for (const r of RESULTS) {
    const sel = rows.filter((x) => x.resultado === r);
    t[r] = { cantidad: sel.length, monto: amount ? sum(sel, amount) : null };
  }
  return t;
}

async function reconcile(bill) {
  const [billLines] = await pool.query('SELECT * FROM mobile_bill_lines WHERE bill_id = ? ORDER BY id', [bill.id]);
  const [charges] = await pool.query('SELECT * FROM mobile_bill_charges WHERE bill_id = ? ORDER BY id', [bill.id]);
  const chips = await lineService.listLines({});
  const [devices] = await pool.query(
    `SELECT d.id, d.imei, d.asset_code, d.phone_number, d.status, d.area, d.sede, d.brand, d.model, d.operadora, a.holder_name
     FROM mobile_devices d
     LEFT JOIN mobile_device_assignments a ON a.device_id = d.id AND a.returned_date IS NULL`
  );
  const chipByNumber = new Map(chips.map((c) => [c.phone_number, c]));
  const deviceByImei = new Map(devices.map((d) => [d.imei, d]));

  const lineas = billLines.map((l) => {
    const chip = chipByNumber.get(l.phone_number) || null;
    const [resultado, detalle] = classifyLine(chip);
    return {
      ...l, resultado, detalle, chip_id: chip ? chip.id : null, device_id: chip ? chip.device_id : null,
      imei: chip ? chip.imei : null, holder: chip ? chip.holder : null, area: chip ? chip.area : null, sede: chip ? chip.sede : null,
    };
  });

  const otrosCargos = charges.filter((c) => !c.imei);
  const equipos = charges.filter((c) => c.imei).map((c) => {
    const device = deviceByImei.get(c.imei) || null;
    const [resultado, detalle] = classifyDevice(device);
    return {
      ...c, resultado, detalle, device_id: device ? device.id : null, asset_code: device ? device.asset_code : null,
      phone_number: device ? device.phone_number : null, holder: device ? device.holder_name : null, sede: device ? device.sede : null,
    };
  });

  // Inventario -> recibo: solo los chips que podrian estar en ESTE recibo
  // (de esta operadora, o sin operadora registrada) y que no esten de baja.
  const billed = new Set(billLines.map((l) => l.phone_number));
  const billedImei = new Set(charges.filter((c) => c.imei).map((c) => c.imei));
  const op = bill.operadora.toLowerCase();
  let otrasOperadoras = 0;
  const inventario = [];
  for (const c of chips) {
    if (c.estado === 'de_baja') continue;
    const sinOperadora = !c.operadora;
    if (!sinOperadora && c.operadora.toLowerCase() !== op) { otrasOperadoras += 1; continue; }
    let resultado = 'coincide';
    let detalle = 'Número facturado en el recibo';
    if (!billed.has(c.phone_number)) {
      if (c.imei && billedImei.has(c.imei)) {
        resultado = 'observado';
        detalle = 'Número no facturado, pero su IMEI sí tiene cuota de equipo';
      } else {
        resultado = 'faltante';
        detalle = sinOperadora
          ? 'Número no figura en el recibo (el chip no tiene operadora registrada: puede ser de otra)'
          : 'Número no figura en el recibo';
      }
    }
    inventario.push({
      chip_id: c.id, device_id: c.device_id, phone_number: c.phone_number, imei: c.imei, asset_code: c.asset_code, operadora: c.operadora,
      holder: c.holder, area: c.area, sede: c.sede, ubicacion: c.ubicacion, resultado, detalle,
    });
  }
  for (const d of devices) {
    if (d.phone_number || d.status === 'de_baja') continue;
    inventario.push({
      chip_id: null, device_id: d.id, phone_number: null, imei: d.imei, asset_code: d.asset_code, operadora: d.operadora,
      holder: d.holder_name, area: d.area, sede: d.sede, ubicacion: null, resultado: 'observado',
      detalle: billedImei.has(d.imei) ? 'Equipo sin número en el inventario (su IMEI sí tiene cuota)' : 'Equipo sin número en el inventario',
    });
  }

  const porPlan = [];
  for (const l of lineas) {
    let p = porPlan.find((x) => x.plan === (l.plan || '—'));
    if (!p) { p = { plan: l.plan || '—', lineas: 0, monto: 0, faltantes: 0, montoFaltantes: 0 }; porPlan.push(p); }
    p.lineas += 1; p.monto = round2(p.monto + Number(l.monto_total));
    if (l.resultado === 'faltante') { p.faltantes += 1; p.montoFaltantes = round2(p.montoFaltantes + Number(l.monto_total)); }
  }
  porPlan.sort((a, b) => b.lineas - a.lineas);

  // Vencimientos (solo si el recibo vino en PDF, que trae "n/total").
  const group = (rows, key, amount) => {
    const out = [];
    for (const r of rows) {
      const k = key(r);
      let g = out.find((x) => x.key === k.key);
      if (!g) { g = { ...k, cantidad: 0, monto: 0 }; out.push(g); }
      g.cantidad += 1; g.monto = round2(g.monto + Math.abs(Number(amount(r))));
    }
    return out.sort((a, b) => a.restantes - b.restantes);
  };
  const descuentosPorVencer = group(
    lineas.filter((l) => l.descuento_cuotas),
    (l) => ({ key: `${l.descuento_tipo}|${l.descuento_cuota}/${l.descuento_cuotas}`, tipo: l.descuento_tipo, avance: `${l.descuento_cuota}/${l.descuento_cuotas}`, restantes: l.descuento_cuotas - l.descuento_cuota }),
    (l) => l.descuento
  );
  const cuotasPorTerminar = group(
    equipos.filter((e) => e.cuota_total),
    (e) => ({ key: `${e.cuota_nro}/${e.cuota_total}`, avance: `${e.cuota_nro}/${e.cuota_total}`, restantes: e.cuota_total - e.cuota_nro }),
    (e) => e.monto
  );

  return {
    lineas, equipos, inventario, otrosCargos,
    stats: {
      lineas: tally(lineas, (l) => l.monto_total),
      equipos: tally(equipos, (e) => e.monto),
      inventario: tally(inventario, null),
      otrasOperadoras, porPlan, descuentosPorVencer, cuotasPorTerminar,
      otrosCargos: { cantidad: otrosCargos.length, monto: sum(otrosCargos, (c) => c.monto) },
    },
  };
}

// ---------------------------------------------------------------------
// Acciones sobre el inventario
// ---------------------------------------------------------------------
// Registra como chips los numeros facturados que no estan en el inventario.
// `numbers` = lista a crear, o null para todos los faltantes. Quedan en
// stock (sin celular ni persona), salvo que un celular ya use ese numero.
async function createMissingLines(bill, numbers, userId) {
  const [missing] = await pool.query(
    `SELECT b.phone_number, b.plan, b.monto_total FROM mobile_bill_lines b
     LEFT JOIN mobile_lines m ON m.phone_number = b.phone_number
     WHERE b.bill_id = ? AND m.id IS NULL ORDER BY b.id`,
    [bill.id]
  );
  const wanted = numbers ? new Set(numbers) : null;
  const rows = wanted ? missing.filter((m) => wanted.has(m.phone_number)) : missing;
  if (!rows.length) return 0;
  const [[peru]] = await pool.query("SELECT id, mobile_length FROM phone_country_codes WHERE calling_code = '51' LIMIT 1");
  const [devs] = await pool.query(
    'SELECT id, phone_number FROM mobile_devices WHERE has_chip = 1 AND phone_number IN (?)',
    [rows.map((r) => r.phone_number)]
  );
  const deviceOf = new Map(devs.map((d) => [d.phone_number, d.id]));
  const note = `Creado desde el recibo ${bill.operadora} N.º ${bill.recibo_nro}`;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let created = 0;
    const values = rows.map((r) => [
      peru && r.phone_number.length === peru.mobile_length ? peru.id : null, r.phone_number, bill.operadora,
      r.plan ? r.plan.slice(0, 60) : null, r.monto_total, 'activo', deviceOf.get(r.phone_number) || null, note, userId || null,
    ]);
    for (let i = 0; i < values.length; i += 500) {
      const [res] = await conn.query(
        `INSERT IGNORE INTO mobile_lines (phone_country_code_id, phone_number, operadora, plan, costo_plan, estado, device_id, notes, created_by)
         VALUES ?`,
        [values.slice(i, i + 500)]
      );
      created += res.affectedRows;
    }
    await conn.commit();
    return created;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Copia a los chips que SI estan en el recibo su plan y lo que se paga por
// mes (monto neto de la linea); la operadora solo si estaba vacia.
async function syncPlans(bill) {
  const [res] = await pool.query(
    `UPDATE mobile_lines l JOIN mobile_bill_lines b ON b.phone_number = l.phone_number AND b.bill_id = ?
     SET l.plan = LEFT(b.plan, 60), l.costo_plan = b.monto_total,
         l.operadora = IF(l.operadora IS NULL OR l.operadora = '', ?, l.operadora)
     WHERE l.estado <> 'de_baja'`,
    [bill.id, bill.operadora]
  );
  await pool.query(
    `UPDATE mobile_devices d
     JOIN mobile_lines l ON l.device_id = d.id AND l.phone_number = d.phone_number
     JOIN mobile_bill_lines b ON b.phone_number = l.phone_number AND b.bill_id = ?
     SET d.operadora = ? WHERE d.operadora IS NULL OR d.operadora = ''`,
    [bill.id, bill.operadora]
  );
  return res.changedRows;
}

// ---------------------------------------------------------------------
// Exportacion
// ---------------------------------------------------------------------
const RES_LABEL = { coincide: 'COINCIDE', observado: 'OBSERVADO', faltante: 'FALTANTE' };

function addTable(sheet, headers, rows, widths) {
  const start = sheet.rowCount ? sheet.rowCount + 2 : 1;
  sheet.getRow(start).values = headers;
  sheet.getRow(start).font = { bold: true };
  rows.forEach((r) => sheet.addRow(r));
  if (widths) widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
  return start;
}

async function buildWorkbook(bill, rec) {
  const wb = new ExcelJS.Workbook();
  const s = rec.stats;
  const titulo = `Recibo ${bill.operadora} N.º ${bill.recibo_nro} — Cuenta ${bill.cuenta || '—'} — Periodo ${bill.periodo_inicio || '—'} al ${bill.periodo_fin || '—'}`;

  const est = wb.addWorksheet('Estadísticas');
  est.addRow([titulo]).font = { bold: true };
  const bloque = (nombre, t, conMonto) => {
    const start = addTable(est, [nombre, 'Cantidad', '% del total', ...(conMonto ? ['Monto S/'] : [])], [
      ['Total', t.total, 1, ...(conMonto ? [t.monto] : [])],
      ...RESULTS.map((r) => [RES_LABEL[r], t[r].cantidad, t.total ? t[r].cantidad / t.total : 0, ...(conMonto ? [t[r].monto] : [])]),
    ]);
    for (let r = start + 1; r <= start + 4; r++) est.getCell(r, 3).numFmt = '0.0%';
  };
  bloque('1. Líneas del recibo vs. chips del inventario', s.lineas, true);
  bloque('2. Equipos con cuota (IMEI) vs. celulares del inventario', s.equipos, true);
  bloque('3. Inventario vs. recibo', s.inventario, false);
  addTable(est, ['4. Líneas por plan', 'Líneas', 'Monto S/', 'Faltantes', 'Monto faltantes S/'],
    s.porPlan.map((p) => [p.plan, p.lineas, p.monto, p.faltantes, p.montoFaltantes]));
  if (s.descuentosPorVencer.length) {
    addTable(est, ['5. Descuentos con vencimiento', 'Líneas', 'Descuento mensual S/', 'Avance', 'Recibos que faltan'],
      s.descuentosPorVencer.map((d) => [d.tipo, d.cantidad, d.monto, d.avance, d.restantes]));
  }
  if (s.cuotasPorTerminar.length) {
    addTable(est, ['6. Cuotas de equipos', 'Equipos', 'Cuota mensual S/', 'Avance', 'Cuotas que faltan'],
      s.cuotasPorTerminar.map((c) => ['Cuota diferida', c.cantidad, c.monto, c.avance, c.restantes]));
  }
  est.getColumn(1).width = 58; [2, 3, 4, 5].forEach((c) => { est.getColumn(c).width = 20; });

  const fal = wb.addWorksheet('Faltantes');
  const faltLineas = rec.lineas.filter((l) => l.resultado === 'faltante');
  const faltEquipos = rec.equipos.filter((e) => e.resultado === 'faltante');
  fal.addRow([`PENDIENTES / FALTANTES — ${titulo}`]).font = { bold: true };
  addTable(fal, ['Resumen', 'Cantidad', 'Monto mensual S/', 'Proyección anual S/'], [
    ['Líneas facturadas sin registro en el inventario', faltLineas.length, s.lineas.faltante.monto, round2(s.lineas.faltante.monto * 12)],
    ['Equipos (IMEI) facturados sin registro en el inventario', faltEquipos.length, s.equipos.faltante.monto, round2(s.equipos.faltante.monto * 12)],
    ['Chips del inventario no facturados', s.inventario.faltante.cantidad, null, null],
  ]);
  addTable(fal, ['Número', 'Plan', 'Cargo fijo S/', 'Prom. y dsctos. S/', 'Monto mensual S/'],
    faltLineas.map((l) => [l.phone_number, l.plan, Number(l.cargo_fijo), Number(l.descuento), Number(l.monto_total)]));
  addTable(fal, ['IMEI', 'Modelo', 'Folio de venta', 'Cuota', 'Cuota mensual S/'],
    faltEquipos.map((e) => [e.imei, e.modelo, e.folio, e.cuota_total ? `${e.cuota_nro}/${e.cuota_total}` : '', Number(e.monto)]),
    [52, 30, 18, 18, 18]);

  const table = (name, headers, rows, widths) => {
    const sh = wb.addWorksheet(name);
    addTable(sh, headers, rows, widths);
    sh.views = [{ state: 'frozen', ySplit: 1 }];
    sh.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  };
  table('Recibo',
    ['Número', 'Plan', 'Cargo fijo S/', 'Prom. y dsctos. S/', 'Otros S/', 'Monto total S/', 'Tipo de descuento', 'Avance del descuento',
      'IMEI inventario', 'Usuario', 'Área', 'Sede', 'Resultado', 'Detalle'],
    rec.lineas.map((l) => [l.phone_number, l.plan, Number(l.cargo_fijo), Number(l.descuento), Number(l.otros), Number(l.monto_total),
      l.descuento_tipo || '', l.descuento_cuotas ? `${l.descuento_cuota}/${l.descuento_cuotas}` : '', l.imei || '', l.holder || '',
      l.area || '', l.sede || '', RES_LABEL[l.resultado], l.detalle]),
    [13, 24, 13, 16, 10, 14, 36, 12, 18, 30, 20, 16, 13, 50]);
  table('Equipos recibo',
    ['IMEI facturado', 'Modelo', 'Folio de venta', 'Cuota', 'Cuota mensual S/', 'Código de activo', 'Número inventario', 'Usuario', 'Sede',
      'Resultado', 'Detalle'],
    rec.equipos.map((e) => [e.imei, e.modelo, e.folio, e.cuota_total ? `${e.cuota_nro}/${e.cuota_total}` : '', Number(e.monto),
      e.asset_code || '', e.phone_number || '', e.holder || '', e.sede || '', RES_LABEL[e.resultado], e.detalle]),
    [18, 32, 16, 8, 16, 14, 16, 30, 16, 13, 46]);
  table('Inventario vs recibo',
    ['Número inventario', 'IMEI inventario', 'Código de activo', 'Operadora', 'Usuario', 'Área', 'Sede', 'Resultado', 'Detalle'],
    rec.inventario.map((i) => [i.phone_number || '', i.imei || '', i.asset_code || '', i.operadora || '', i.holder || '', i.area || '',
      i.sede || '', RES_LABEL[i.resultado], i.detalle]),
    [16, 18, 14, 12, 30, 20, 16, 13, 60]);
  if (rec.otrosCargos.length) {
    table('Otros cargos', ['Descripción', 'Monto S/'], rec.otrosCargos.map((c) => [c.descripcion, Number(c.monto)]), [80, 14]);
  }
  return wb.xlsx.writeBuffer();
}

module.exports = {
  RESULTS, BillFormatError,
  importBill, listBills, getBill, deleteBill, storedPath, reconcile, createMissingLines, syncPlans, buildWorkbook,
};
