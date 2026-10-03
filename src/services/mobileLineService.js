// Chips (lineas) del modulo Celulares.
//
// Un chip es siempre un numero de linea (mobile_lines). Puede estar:
// - puesto en un celular (device_id),
// - asignado a una persona sin celular (mobile_line_assignments): 'personal'
//   = lo usa en su propio equipo; 'emergencia' = numero de respaldo por si
//   se bloquea el principal, aunque esa persona ya tenga celular con chip,
// - o en stock.
//
// El celular sigue teniendo phone_number/has_chip: es su chip PRINCIPAL (lo
// que ya usan el formulario, el QR, la importacion y las exportaciones).
// Todo cambio que toque las dos cosas pasa por este archivo, para que el
// numero del celular y el chip no se desalineen.
const pool = require('../db/pool');
const employeeService = require('./employeeService');

const ESTADOS = ['activo', 'suspendido', 'de_baja'];
const USOS = ['personal', 'emergencia', 'repuesto'];
const UBICACIONES = ['en_celular', 'personal', 'emergencia', 'repuesto', 'en_stock'];
// Un celular admite como maximo dos chips (doble SIM). Los chips extra que
// tenga una persona se le asignan como "repuesto".
const MAX_CHIPS_PER_DEVICE = 2;
const TOO_MANY = 'Ese celular ya tiene 2 chips (el máximo de un equipo doble SIM). Retire uno primero, o asigne este chip a la persona como repuesto.';

async function validateLineData(data) {
  const errors = [];
  if (!data.phone_number || !/^\d+$/.test(data.phone_number)) {
    errors.push('El número de línea es obligatorio y debe tener solo dígitos, sin espacios ni guiones.');
  } else if (data.phone_country_code_id) {
    const [[country]] = await pool.query(
      'SELECT mobile_length, country_name FROM phone_country_codes WHERE id = ?',
      [data.phone_country_code_id]
    );
    if (country && data.phone_number.length !== country.mobile_length) {
      errors.push(`El número de línea de ${country.country_name} debe tener ${country.mobile_length} dígitos.`);
    }
  }
  // ICCID: el numero impreso en el chip. Estandar ITU-T E.118: 19 o 20
  // digitos (algunas operadoras imprimen 18 o 22); solo digitos.
  if (data.iccid && !/^\d{18,22}$/.test(data.iccid)) {
    errors.push('El ICCID debe tener entre 18 y 22 dígitos (el número impreso en el chip).');
  }
  if (data.operadora && data.operadora.length > 50) errors.push('La operadora no puede superar los 50 caracteres.');
  if (data.plan && data.plan.length > 60) errors.push('El plan no puede superar los 60 caracteres.');
  if (data.costo_plan !== null && data.costo_plan !== undefined && data.costo_plan !== '') {
    const n = Number(data.costo_plan);
    if (!Number.isFinite(n) || n < 0 || n > 99999999) errors.push('El costo del plan debe ser un monto válido (0 o más).');
  }
  if (data.descuento_plan !== null && data.descuento_plan !== undefined && data.descuento_plan !== '') {
    const d = Number(data.descuento_plan);
    if (!Number.isFinite(d) || d < 0) errors.push('El descuento debe ser un monto válido (0 o más).');
    else if (data.costo_plan === null || data.costo_plan === undefined || data.costo_plan === '') errors.push('Para registrar un descuento indique primero el costo mensual del plan.');
    else if (d > Number(data.costo_plan)) errors.push('El descuento no puede ser mayor que el costo mensual del plan.');
  }
  if (data.descuento_nota && data.descuento_nota.length > 150) errors.push('El detalle del descuento no puede superar los 150 caracteres.');
  if (data.estado && !ESTADOS.includes(data.estado)) errors.push('Estado de chip no válido.');
  if (data.notes && data.notes.length > 250) errors.push('Las notas no pueden superar los 250 caracteres.');
  return errors;
}

async function numberTaken(number, exceptLineId = null) {
  const [[row]] = await pool.query('SELECT id FROM mobile_lines WHERE phone_number = ? AND id <> ? LIMIT 1', [number, exceptLineId || 0]);
  return !!row;
}

// Para el formulario del celular: ¿se puede usar este numero como chip
// principal del equipo? Un chip en stock se "toma" (pasa al equipo); uno
// que ya esta en otro celular o asignado a una persona no.
async function deviceChipConflict(number, deviceId) {
  if (!number) return null;
  const [[line]] = await pool.query(
    `SELECT l.id, l.device_id, l.estado, d.imei, d.asset_code, a.holder_name, a.uso
     FROM mobile_lines l
     LEFT JOIN mobile_devices d ON d.id = l.device_id
     LEFT JOIN mobile_line_assignments a ON a.line_id = l.id AND a.returned_date IS NULL
     WHERE l.phone_number = ?`,
    [number]
  );
  if (line) {
    if (line.device_id && String(line.device_id) !== String(deviceId || '')) {
      return `El número ${number} ya está en otro celular (IMEI ${line.imei}${line.asset_code ? `, ${line.asset_code}` : ''}). Retírelo de ese equipo primero.`;
    }
    if (line.holder_name) {
      return `El número ${number} está asignado a ${line.holder_name} (${line.uso === 'emergencia' ? 'número de emergencia' : 'sin celular'}). Devuélvalo desde Chips antes de ponerlo en un equipo.`;
    }
    if (line.estado === 'de_baja') return `El chip ${number} está dado de baja.`;
    if (String(line.device_id || '') !== String(deviceId || '') && deviceId && (await otherChips(deviceId, number)) >= MAX_CHIPS_PER_DEVICE) return TOO_MANY;
    return null;
  }
  if (deviceId && (await otherChips(deviceId, number)) >= MAX_CHIPS_PER_DEVICE) return TOO_MANY;
  // Datos anteriores al registro de chips: otro celular con ese numero.
  const [[dev]] = await pool.query(
    'SELECT imei FROM mobile_devices WHERE phone_number = ? AND has_chip = 1 AND id <> ? LIMIT 1',
    [number, deviceId || 0]
  );
  return dev ? `El número ${number} ya lo usa el celular IMEI ${dev.imei}.` : null;
}

// Tras crear/editar/importar un celular: su chip principal queda
// registrado y puesto en el equipo; si cambio el numero o se quito el chip,
// el chip anterior vuelve a stock (no se borra: el numero sigue existiendo).
async function syncDeviceChip(deviceId, oldNumber, userId, conn = pool) {
  const [[d]] = await conn.query(
    'SELECT id, imei, phone_number, has_chip, phone_country_code_id, operadora FROM mobile_devices WHERE id = ?',
    [deviceId]
  );
  if (!d) return;
  const newNumber = d.has_chip && d.phone_number ? d.phone_number : null;
  if (oldNumber && oldNumber !== newNumber) {
    await conn.query('UPDATE mobile_lines SET device_id = NULL WHERE phone_number = ? AND device_id = ?', [oldNumber, deviceId]);
  }
  if (!newNumber) return;
  const [[line]] = await conn.query('SELECT id FROM mobile_lines WHERE phone_number = ?', [newNumber]);
  if (!line) {
    await conn.query(
      `INSERT INTO mobile_lines (phone_country_code_id, phone_number, operadora, device_id, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [d.phone_country_code_id, newNumber, d.operadora, deviceId, userId || null]
    );
    return;
  }
  await conn.query(
    `UPDATE mobile_lines SET device_id = ?, phone_country_code_id = COALESCE(?, phone_country_code_id),
       operadora = COALESCE(?, operadora) WHERE id = ?`,
    [deviceId, d.phone_country_code_id, d.operadora, line.id]
  );
}

async function getLine(lineId) {
  const [[line]] = await pool.query('SELECT * FROM mobile_lines WHERE id = ?', [lineId]);
  return line || null;
}

// Si el chip era el principal de su celular, el celular queda sin numero,
// o con otro chip que tenga puesto (doble SIM) como nuevo principal.
async function releaseFromDevice(line, conn = pool) {
  if (!line.device_id) return null;
  const deviceId = line.device_id;
  await conn.query('UPDATE mobile_lines SET device_id = NULL WHERE id = ?', [line.id]);
  const [[d]] = await conn.query('SELECT id, imei, phone_number FROM mobile_devices WHERE id = ?', [deviceId]);
  if (d && d.phone_number === line.phone_number) {
    const [[other]] = await conn.query(
      'SELECT phone_number, phone_country_code_id, operadora FROM mobile_lines WHERE device_id = ? ORDER BY id LIMIT 1',
      [deviceId]
    );
    if (other) {
      await conn.query(
        'UPDATE mobile_devices SET phone_number = ?, phone_country_code_id = ?, operadora = COALESCE(?, operadora), has_chip = 1, updated_at = NOW() WHERE id = ?',
        [other.phone_number, other.phone_country_code_id, other.operadora, deviceId]
      );
    } else {
      await conn.query('UPDATE mobile_devices SET phone_number = NULL, has_chip = 0, updated_at = NOW() WHERE id = ?', [deviceId]);
    }
  }
  return d;
}

async function closeAssignment(lineId, note, conn = pool) {
  const [[active]] = await conn.query(
    'SELECT id, holder_name, uso FROM mobile_line_assignments WHERE line_id = ? AND returned_date IS NULL',
    [lineId]
  );
  if (!active) return null;
  await conn.query(
    `UPDATE mobile_line_assignments SET returned_date = CURDATE(),
       observacion = TRIM(BOTH ' - ' FROM CONCAT_WS(' - ', observacion, ?)) WHERE id = ?`,
    [note || null, active.id]
  );
  return active;
}

// Cuantos chips tiene puestos un celular.
async function chipsInDevice(deviceId, conn = pool) {
  const [[r]] = await conn.query('SELECT COUNT(*) AS n FROM mobile_lines WHERE device_id = ?', [deviceId]);
  return Number(r.n);
}

// Chips del celular que seguirian puestos si `number` pasa a ser su
// principal (el principal actual sale del equipo al cambiarlo).
async function otherChips(deviceId, number) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM mobile_lines l JOIN mobile_devices d ON d.id = l.device_id
     WHERE l.device_id = ? AND l.phone_number <> ? AND (d.phone_number IS NULL OR l.phone_number <> d.phone_number)`,
    [deviceId, number]
  );
  return Number(r.n);
}

// El 2.o chip de un celular pasa a ser su numero principal (el anterior
// principal sigue puesto, como 2.o chip).
async function makePrincipal(lineId) {
  const line = await getLine(lineId);
  if (!line) throw new Error('Chip no encontrado.');
  if (!line.device_id) throw new Error('El chip no está en ningún celular.');
  const [[device]] = await pool.query('SELECT id, imei, phone_number FROM mobile_devices WHERE id = ?', [line.device_id]);
  if (device.phone_number === line.phone_number) throw new Error('Ese chip ya es el número principal del celular.');
  await pool.query(
    `UPDATE mobile_devices SET phone_number = ?, phone_country_code_id = ?, operadora = COALESCE(?, operadora), has_chip = 1, updated_at = NOW()
     WHERE id = ?`,
    [line.phone_number, line.phone_country_code_id, line.operadora, device.id]
  );
  return { device, previous: device.phone_number };
}

// Agrega un chip a un celular desde la ficha del celular: si el numero ya
// existe como chip (en stock) se pone; si no existe, se registra y se pone.
async function addChipToDevice(deviceId, input, userId) {
  const number = digits(input.numero);
  if (!/^\d{6,15}$/.test(number)) throw new Error('Escriba el número del chip (solo dígitos, ej. 912345678).');
  const [[device]] = await pool.query('SELECT id, imei, status FROM mobile_devices WHERE id = ?', [deviceId]);
  if (!device) throw new Error('Celular no encontrado.');
  if ((await chipsInDevice(device.id)) >= MAX_CHIPS_PER_DEVICE) throw new Error(TOO_MANY);
  let [[line]] = await pool.query('SELECT id FROM mobile_lines WHERE phone_number = ?', [number]);
  let created = false;
  if (!line) {
    const iccid = digits(input.iccid);
    if (iccid && !/^\d{18,22}$/.test(iccid)) throw new Error('El ICCID debe tener entre 18 y 22 dígitos.');
    const [[peru]] = await pool.query("SELECT id, mobile_length FROM phone_country_codes WHERE calling_code = '51' LIMIT 1");
    const [res] = await pool.query(
      'INSERT INTO mobile_lines (phone_country_code_id, phone_number, iccid, operadora, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [peru && number.length === peru.mobile_length ? peru.id : null, number, iccid || null, String(input.operadora || '').trim().slice(0, 50) || null,
        input.notes ? String(input.notes).slice(0, 250) : null, userId || null]
    );
    line = { id: res.insertId };
    created = true;
  }
  try {
    const placed = await placeInDevice(line.id, device.imei);
    return { ...placed, lineId: line.id, created, number };
  } catch (err) {
    if (created) await pool.query('DELETE FROM mobile_lines WHERE id = ?', [line.id]); // no deja un chip a medias
    throw err;
  }
}

// Pone el chip en un celular. Devuelve { device, principal } o lanza Error
// con un mensaje para el usuario.
async function placeInDevice(lineId, deviceRef) {
  const line = await getLine(lineId);
  if (!line) throw new Error('Chip no encontrado.');
  if (line.estado === 'de_baja') throw new Error('El chip está dado de baja: no se puede poner en un celular.');
  const ref = String(deviceRef || '').trim();
  const [[device]] = await pool.query(
    'SELECT id, imei, asset_code, phone_number, has_chip, status FROM mobile_devices WHERE imei = ? OR asset_code = ? LIMIT 1',
    [ref, ref]
  );
  if (!device) throw new Error(`No se encontró un celular con IMEI o código "${ref}".`);
  if (device.status === 'de_baja') throw new Error('Ese celular está dado de baja.');
  if (String(line.device_id) === String(device.id)) throw new Error('El chip ya está en ese celular.');
  if ((await chipsInDevice(device.id)) >= MAX_CHIPS_PER_DEVICE) throw new Error(TOO_MANY);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const previous = line.device_id ? await releaseFromDevice(line, conn) : null;
    const assignment = await closeAssignment(line.id, `Chip puesto en el celular ${device.imei}`, conn);
    await conn.query('UPDATE mobile_lines SET device_id = ? WHERE id = ?', [device.id, line.id]);
    const principal = !(device.has_chip && device.phone_number);
    if (principal) {
      await conn.query(
        `UPDATE mobile_devices SET phone_number = ?, phone_country_code_id = ?, operadora = COALESCE(?, operadora),
           has_chip = 1, updated_at = NOW() WHERE id = ?`,
        [line.phone_number, line.phone_country_code_id, line.operadora, device.id]
      );
    } else {
      await conn.query('UPDATE mobile_devices SET updated_at = NOW() WHERE id = ?', [device.id]);
    }
    await conn.commit();
    return { device, principal, previous, assignment };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function removeFromDevice(lineId) {
  const line = await getLine(lineId);
  if (!line) throw new Error('Chip no encontrado.');
  if (!line.device_id) throw new Error('El chip no está en ningún celular.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const device = await releaseFromDevice(line, conn);
    await conn.commit();
    return device;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Asigna el chip (sin celular) a una persona, identificada por DNI.
async function assignLine(lineId, input, userId) {
  const line = await getLine(lineId);
  if (!line) throw new Error('Chip no encontrado.');
  if (line.device_id) throw new Error('El chip está puesto en un celular: se asigna junto con el equipo. Retírelo primero si va a usarse sin celular.');
  if (line.estado === 'de_baja') throw new Error('El chip está dado de baja.');
  const { dni, first_name: first, last_name: last, area, sede, cargo, uso, assigned_date: fecha, observacion } = input;
  if (!dni || !first || !last) throw new Error('DNI, nombres y apellidos son obligatorios.');
  if (!/^\d{8}$/.test(dni)) throw new Error('El DNI debe tener exactamente 8 dígitos numéricos.');
  if (!USOS.includes(uso)) throw new Error('Indique el uso: sin celular (personal), número de emergencia o repuesto.');
  if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error('La fecha de entrega no es válida.');
  if (observacion && observacion.length > 250) throw new Error('La observación no puede superar los 250 caracteres.');
  const employeeId = await employeeService.upsert({ dni, first_name: first, last_name: last, area, sede, cargo }, userId);
  const holderName = `${first} ${last}`;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const previous = await closeAssignment(line.id, `Reasignado a ${holderName}`, conn);
    await conn.query(
      `INSERT INTO mobile_line_assignments (line_id, employee_id, holder_name, uso, assigned_date, observacion, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [line.id, employeeId, holderName, uso, fecha || null, observacion || null, userId]
    );
    await conn.query('UPDATE mobile_lines SET updated_at = NOW() WHERE id = ?', [line.id]);
    await conn.commit();
    return { holderName, previous };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Guarda los datos del chip. Si es el chip principal de su celular, el
// celular se actualiza igual (numero, pais, operadora). Si pasa a "de baja"
// sale del celular y se cierra su asignacion.
async function saveLine(lineId, data, userId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let id = lineId;
    if (!lineId) {
      const [ins] = await conn.query(
        `INSERT INTO mobile_lines (phone_country_code_id, phone_number, iccid, operadora, plan, costo_plan, descuento_plan,
           descuento_nota, estado, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [data.phone_country_code_id, data.phone_number, data.iccid, data.operadora, data.plan, data.costo_plan,
          data.descuento_plan || null, data.descuento_nota || null, data.estado || 'activo', data.notes, userId]
      );
      id = ins.insertId;
    } else {
      const [[old]] = await conn.query('SELECT * FROM mobile_lines WHERE id = ?', [lineId]);
      await conn.query(
        `UPDATE mobile_lines SET phone_country_code_id = ?, phone_number = ?, iccid = ?, operadora = ?, plan = ?,
           costo_plan = ?, descuento_plan = ?, descuento_nota = ?, estado = ?, notes = ?,
           fecha_baja = IF(? = 'de_baja', COALESCE(fecha_baja, CURDATE()), NULL),
           motivo_baja = IF(? = 'de_baja', motivo_baja, NULL) WHERE id = ?`,
        [data.phone_country_code_id, data.phone_number, data.iccid, data.operadora, data.plan, data.costo_plan,
          data.descuento_plan || null, data.descuento_nota || null, data.estado, data.notes, data.estado, data.estado, lineId]
      );
      if (old.device_id) {
        await conn.query(
          `UPDATE mobile_devices SET phone_number = ?, phone_country_code_id = ?, operadora = ?
           WHERE id = ? AND phone_number = ?`,
          [data.phone_number, data.phone_country_code_id, data.operadora, old.device_id, old.phone_number]
        );
      }
      if (data.estado === 'de_baja' && old.estado !== 'de_baja') {
        await releaseFromDevice({ ...old, phone_number: data.phone_number }, conn);
        await closeAssignment(lineId, 'Chip dado de baja', conn);
      }
    }
    await conn.commit();
    return id;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Da de baja el chip: sale de su celular, se cierra su asignacion y deja
// de contar en lo que se paga. Queda en el inventario, con fecha y motivo.
async function dropLine(lineId, { fecha, motivo } = {}) {
  const line = await getLine(lineId);
  if (!line) throw new Error('Chip no encontrado.');
  if (line.estado === 'de_baja') throw new Error('El chip ya está dado de baja.');
  if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error('La fecha de baja no es válida.');
  if (motivo && motivo.length > 150) throw new Error('El motivo no puede superar los 150 caracteres.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const device = await releaseFromDevice(line, conn);
    const assignment = await closeAssignment(line.id, 'Chip dado de baja', conn);
    await conn.query(
      "UPDATE mobile_lines SET estado = 'de_baja', fecha_baja = COALESCE(?, CURDATE()), motivo_baja = ? WHERE id = ?",
      [fecha || null, motivo || null, line.id]
    );
    await conn.commit();
    return { line, device, assignment };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Revierte la baja: el chip vuelve a estar activo, en stock.
async function reactivateLine(lineId) {
  const line = await getLine(lineId);
  if (!line) throw new Error('Chip no encontrado.');
  if (line.estado !== 'de_baja') throw new Error('El chip no está dado de baja.');
  await pool.query("UPDATE mobile_lines SET estado = 'activo', fecha_baja = NULL, motivo_baja = NULL WHERE id = ?", [lineId]);
  return line;
}

// ¿Ya esta registrado este numero (o este ICCID)? Para avisar mientras se
// escribe o se escanea, sin esperar a guardar. Devuelve el chip con su
// ubicacion, o null. `exceptId` = el chip que se esta editando.
async function findExisting({ numero, iccid, exceptId }) {
  const col = numero ? 'phone_number' : 'iccid';
  const value = numero || iccid;
  if (!value) return null;
  const [[line]] = await pool.query(`SELECT * FROM (${BASE_SELECT}) x WHERE x.${col} = ? AND x.id <> ? LIMIT 1`, [value, exceptId || 0]);
  if (line) return line;
  if (!numero) return null;
  // Datos anteriores al registro de chips: un celular que usa ese numero.
  const [[dev]] = await pool.query('SELECT id, imei, asset_code FROM mobile_devices WHERE phone_number = ? AND has_chip = 1 LIMIT 1', [numero]);
  return dev ? { id: null, phone_number: numero, device_id: dev.id, imei: dev.imei, asset_code: dev.asset_code, estado: 'activo', ubicacion: 'en_celular' } : null;
}

async function deleteLine(lineId) {
  const line = await getLine(lineId);
  if (!line) return null;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await releaseFromDevice(line, conn);
    await conn.query('DELETE FROM mobile_lines WHERE id = ?', [lineId]);
    await conn.commit();
    return line;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------
// Carga por lote (escaneo de codigos de barras o Excel) y cambios masivos
// ---------------------------------------------------------------------
// El lector de codigos de barras y Excel entregan el ICCID con adornos: una
// "F" de relleno al final, espacios o guiones. Se dejan solo los digitos.
function digits(value) {
  return String(value === null || value === undefined ? '' : value).replace(/\D/g, '');
}

// Lo que se escribe o se pega en un buscador: sin espacios alrededor (al
// copiar una celda de Excel viene con un salto de linea o un espacio al
// final) y, si es un numero escrito con separadores ("934 530 745"), junto.
function searchTerm(q) {
  const s = String(q === null || q === undefined ? '' : q).trim();
  return /^[\d\s.-]+$/.test(s) ? s.replace(/\D/g, '') : s;
}

// Registra varios chips nuevos, en stock. `rows` = [{ row, phone_number,
// iccid, operadora, plan, costo_plan, descuento_plan, descuento_nota,
// notes, warning }]; `row` es como se nombra la fila en los errores. Cada
// fila se valida igual que el formulario de un chip; las que fallan no
// impiden registrar las demas. Con `dryRun` no guarda nada: sirve para
// revisar un archivo antes de registrarlo. Devuelve { imported, errors:
// [{ row, message }], checked: [{ row, data, ok, message, warning }] }.
async function createLinesBulk(rows, userId, { dryRun = false } = {}) {
  const errors = [];
  const checked = [];
  let imported = 0;
  const [[peru]] = await pool.query("SELECT id FROM phone_country_codes WHERE calling_code = '51' LIMIT 1");
  const seenNumber = new Set();
  const seenIccid = new Set();
  const text = (v, max) => {
    const s = v === null || v === undefined ? '' : String(v).trim();
    return s === '' ? null : s.slice(0, max);
  };
  const amount = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim().replace(',', '.'));
  for (const r of rows) {
    const fail = (message) => { errors.push({ row: r.row, message }); checked.push({ row: r.row, data, ok: false, message }); };
    const data = {
      phone_country_code_id: peru ? peru.id : null,
      phone_number: digits(r.phone_number) || null,
      iccid: digits(r.iccid) || null,
      operadora: text(r.operadora, 50),
      plan: text(r.plan, 60),
      costo_plan: amount(r.costo_plan),
      descuento_plan: amount(r.descuento_plan),
      descuento_nota: text(r.descuento_nota, 150),
      estado: 'activo',
      notes: text(r.notes, 250),
    };
    if (!data.phone_number) { fail('Falta el número: un chip siempre va atado a un número de línea.'); continue; }
    const tag = `Número ${data.phone_number}`;
    const invalid = await validateLineData(data);
    if (invalid.length) { fail(`${tag}: ${invalid.join(' ')}`); continue; }
    if (seenNumber.has(data.phone_number)) { fail(`${tag}: está repetido en este mismo lote.`); continue; }
    if (data.iccid && seenIccid.has(data.iccid)) { fail(`${tag}: el ICCID ${data.iccid} está repetido en este mismo lote.`); continue; }
    if (await numberTaken(data.phone_number)) {
      const ex = await findExisting({ numero: data.phone_number });
      const donde = [ex.ubicacion === 'en_celular' ? `en el celular ${ex.asset_code || ex.imei}` : null, ex.holder, ex.estado === 'de_baja' ? 'de baja' : null]
        .filter(Boolean).join(', ');
      fail(`${tag}: ya existe un chip con ese número${donde ? ` (${donde})` : ''}.`);
      continue;
    }
    const conflict = await deviceChipConflict(data.phone_number, null);
    if (conflict) { fail(conflict); continue; }
    if (data.iccid) {
      const [[dup]] = await pool.query('SELECT phone_number FROM mobile_lines WHERE iccid = ? LIMIT 1', [data.iccid]);
      if (dup) { fail(`${tag}: el ICCID ${data.iccid} ya está registrado en el chip ${dup.phone_number}.`); continue; }
    }
    seenNumber.add(data.phone_number);
    if (data.iccid) seenIccid.add(data.iccid);
    if (!dryRun) await saveLine(null, data, userId);
    imported += 1;
    checked.push({ row: r.row, data, ok: true, message: r.warning || '', warning: !!r.warning });
  }
  return { imported, errors, checked };
}

// Pone la misma operadora a varios chips (y a sus celulares, si el chip es
// el numero principal del equipo). Devuelve cuantos chips cambiaron.
async function setOperadora(ids, operadora) {
  if (!ids.length) return 0;
  const [res] = await pool.query('UPDATE mobile_lines SET operadora = ? WHERE id IN (?)', [operadora, ids]);
  await pool.query(
    `UPDATE mobile_devices d JOIN mobile_lines l ON l.device_id = d.id AND l.phone_number = d.phone_number
     SET d.operadora = ? WHERE l.id IN (?)`,
    [operadora, ids]
  );
  return res.changedRows;
}

// ---------------------------------------------------------------------
// Listado con filtros combinables y totales
// ---------------------------------------------------------------------
const BASE_SELECT = `
  SELECT l.*, c.calling_code, c.country_name,
         d.imei, d.asset_code, d.model, d.status AS device_status,
         la.id AS line_assignment_id, la.holder_name AS line_holder, la.uso, la.assigned_date AS line_assigned_date,
         CASE WHEN l.device_id IS NOT NULL THEN 'en_celular' WHEN la.id IS NOT NULL THEN la.uso ELSE 'en_stock' END AS ubicacion,
         COALESCE(d.area, e.area) AS area, COALESCE(d.sede, e.sede) AS sede,
         COALESCE(da.holder_name, la.holder_name) AS holder,
         (d.phone_number = l.phone_number) AS es_principal
  FROM mobile_lines l
  LEFT JOIN phone_country_codes c ON c.id = l.phone_country_code_id
  LEFT JOIN mobile_devices d ON d.id = l.device_id
  LEFT JOIN mobile_device_assignments da ON da.device_id = d.id AND da.returned_date IS NULL
  LEFT JOIN mobile_line_assignments la ON la.line_id = l.id AND la.returned_date IS NULL
  LEFT JOIN employees e ON e.id = la.employee_id`;

async function listLines({ q: rawQ, estado, ubicacion, operadora, area, sede, costo } = {}) {
  let sql = `SELECT * FROM (${BASE_SELECT}) x WHERE 1=1`;
  const params = [];
  const q = searchTerm(rawQ);
  if (q) {
    sql += ' AND (x.phone_number LIKE ? OR x.iccid LIKE ? OR x.holder LIKE ? OR x.imei LIKE ? OR x.asset_code LIKE ? OR x.plan LIKE ?)';
    for (let i = 0; i < 6; i++) params.push(`%${q}%`);
  }
  if (estado && ESTADOS.includes(estado)) { sql += ' AND x.estado = ?'; params.push(estado); }
  if (ubicacion && UBICACIONES.includes(ubicacion)) { sql += ' AND x.ubicacion = ?'; params.push(ubicacion); }
  if (operadora === '__sin__') sql += " AND (x.operadora IS NULL OR x.operadora = '')";
  else if (operadora) { sql += ' AND x.operadora = ?'; params.push(operadora); }
  if (area) { sql += ' AND x.area = ?'; params.push(area); }
  if (sede) { sql += ' AND x.sede = ?'; params.push(sede); }
  if (costo === 'con') sql += ' AND x.costo_plan IS NOT NULL';
  if (costo === 'sin') sql += ' AND x.costo_plan IS NULL';
  sql += ' ORDER BY x.area IS NULL, x.area, x.phone_number';
  const [rows] = await pool.query(sql, params);
  return rows;
}

// Lo que se paga por el chip al mes: costo del plan menos su descuento.
function netCost(line) {
  if (line.costo_plan === null || line.costo_plan === undefined) return null;
  return Math.round((Number(line.costo_plan) - (Number(line.descuento_plan) || 0)) * 100) / 100;
}

// Totales de lo que se esta viendo (respetan todos los filtros). costoTotal
// es SIN descuento (lo que costarian los planes a precio completo);
// netoTotal es lo que se paga hoy; descuentoTotal, la diferencia.
function summarize(rows) {
  const money = (n) => Math.round(n * 100) / 100;
  const s = {
    total: rows.length, costoTotal: 0, descuentoTotal: 0, netoTotal: 0, conCosto: 0, sinCosto: 0, conDescuento: 0, ahorroBajas: 0,
    porUbicacion: Object.fromEntries(UBICACIONES.map((u) => [u, 0])),
    porEstado: Object.fromEntries(ESTADOS.map((e) => [e, 0])),
    porOperadora: {},
  };
  for (const r of rows) {
    s.porEstado[r.estado] = (s.porEstado[r.estado] || 0) + 1;
    // Un chip de baja ya no se paga: no entra en ningun monto. Lo que
    // costaba se informa aparte (ahorroBajas).
    if (r.estado === 'de_baja') {
      s.ahorroBajas += netCost(r) || 0;
      s.porUbicacion[r.ubicacion] = (s.porUbicacion[r.ubicacion] || 0) + 1;
      const opBaja = r.operadora || 'Sin operadora';
      s.porOperadora[opBaja] = s.porOperadora[opBaja] || { cantidad: 0, costo: 0, neto: 0 };
      s.porOperadora[opBaja].cantidad += 1;
      continue;
    }
    const costo = r.costo_plan === null || r.costo_plan === undefined ? null : Number(r.costo_plan);
    const dscto = costo === null ? 0 : Number(r.descuento_plan) || 0;
    if (costo === null) s.sinCosto += 1; else { s.conCosto += 1; s.costoTotal += costo; }
    if (dscto) { s.conDescuento += 1; s.descuentoTotal += dscto; }
    s.porUbicacion[r.ubicacion] = (s.porUbicacion[r.ubicacion] || 0) + 1;
    const op = r.operadora || 'Sin operadora';
    s.porOperadora[op] = s.porOperadora[op] || { cantidad: 0, costo: 0, neto: 0 };
    s.porOperadora[op].cantidad += 1;
    s.porOperadora[op].costo = money(s.porOperadora[op].costo + (costo || 0));
    s.porOperadora[op].neto = money(s.porOperadora[op].neto + (costo || 0) - dscto);
  }
  s.costoTotal = money(s.costoTotal);
  s.ahorroBajas = money(s.ahorroBajas);
  s.descuentoTotal = money(s.descuentoTotal);
  s.netoTotal = money(s.costoTotal - s.descuentoTotal);
  return s;
}

async function getLineDetail(lineId) {
  const [[line]] = await pool.query(`SELECT * FROM (${BASE_SELECT}) x WHERE x.id = ?`, [lineId]);
  if (!line) return null;
  const [history] = await pool.query(
    `SELECT a.*, e.dni FROM mobile_line_assignments a LEFT JOIN employees e ON e.id = a.employee_id
     WHERE a.line_id = ? ORDER BY a.id DESC`,
    [lineId]
  );
  return { line, history };
}

// Chips de un celular (el principal y, si tiene doble SIM, el segundo).
async function linesOfDevice(deviceId) {
  const [rows] = await pool.query(`SELECT * FROM (${BASE_SELECT}) x WHERE x.device_id = ? ORDER BY x.es_principal DESC, x.id`, [deviceId]);
  return rows;
}

// Chips asignados a una persona sin celular (incluye los de emergencia).
async function linesOfEmployee(employeeId) {
  const [rows] = await pool.query(
    `SELECT l.*, a.uso, a.assigned_date FROM mobile_line_assignments a JOIN mobile_lines l ON l.id = a.line_id
     WHERE a.employee_id = ? AND a.returned_date IS NULL ORDER BY l.phone_number`,
    [employeeId]
  );
  return rows;
}

module.exports = {
  ESTADOS, USOS, UBICACIONES, MAX_CHIPS_PER_DEVICE,
  chipsInDevice, makePrincipal, addChipToDevice,
  validateLineData, numberTaken, deviceChipConflict, syncDeviceChip,
  placeInDevice, removeFromDevice, assignLine, closeAssignment, saveLine, deleteLine, getLine,
  listLines, summarize, netCost, getLineDetail, linesOfDevice, linesOfEmployee,
  createLinesBulk, setOperadora, digits, searchTerm, dropLine, reactivateLine, findExisting,
};
