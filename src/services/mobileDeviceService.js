// Reglas de negocio del modulo Celulares compartidas entre el formulario
// (src/routes/mobileDevices.js) y la importacion masiva (mas abajo).
const pool = require('../db/pool');

// IMEI: estandar GSMA (TS 23.003) - 15 digitos numericos (TAC 8 + serie 6
// + digito de control 1). El "8 alfanumerico" que se sugirio corresponde
// en realidad solo al TAC (los primeros 8 digitos, y son numericos, no
// alfanumericos) - el IMEI completo que identifica un equipo son los 15.
const IMEI_REGEX = /^\d{15}$/;
// Alfanumerico + espacio/guion (nombres reales de modelo como "Galaxy A10"
// o "Redmi 9" no son puramente alfanumericos sin espacio).
const MODEL_REGEX = /^[A-Za-zÀ-ÿ0-9\s-]{1,20}$/;

const STATUSES = ['en_stock', 'asignado', 'en_reparacion', 'de_baja'];

// Validaciones de negocio que no se pueden expresar solo con atributos
// HTML (requieren consultar el largo esperado del pais elegido). Devuelve
// un array de mensajes; vacio = todo valido.
async function validateDeviceData(data) {
  const errors = [];
  if (!data.imei || !IMEI_REGEX.test(data.imei)) {
    errors.push('El IMEI debe tener exactamente 15 dígitos numéricos.');
  }
  if (!data.area) {
    errors.push('El área es obligatoria.');
  } else if (data.area.length > 100) {
    errors.push('El área no puede superar los 100 caracteres.');
  }
  if (data.sede && data.sede.length > 100) {
    errors.push('La sede no puede superar los 100 caracteres.');
  }
  if (data.model && !MODEL_REGEX.test(data.model)) {
    errors.push('El modelo debe ser alfanumérico (letras, números, espacios o guiones), máximo 20 caracteres.');
  }
  if (data.brand && data.brand.length > 100) {
    errors.push('La marca no puede superar los 100 caracteres.');
  }
  if (data.operadora && data.operadora.length > 50) {
    errors.push('La operadora no puede superar los 50 caracteres.');
  }
  if (data.asset_code && !/^[A-Za-z0-9-]{1,12}$/.test(data.asset_code)) {
    errors.push('El código de activo debe ser alfanumérico (se permite un guion), máximo 12 caracteres.');
  }
  if (data.notes && data.notes.length > 250) {
    errors.push('Las notas no pueden superar los 250 caracteres.');
  }
  if (data.phone_number) {
    if (!/^\d+$/.test(data.phone_number)) {
      errors.push('El número de línea debe ser solo dígitos, sin espacios ni guiones.');
    } else if (data.phone_country_code_id) {
      const [[country]] = await pool.query(
        'SELECT mobile_length, country_name FROM phone_country_codes WHERE id = ?',
        [data.phone_country_code_id]
      );
      if (country && data.phone_number.length !== country.mobile_length) {
        errors.push(`El número de línea de ${country.country_name} debe tener ${country.mobile_length} dígitos.`);
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------
// Importacion masiva desde Excel/CSV
// ---------------------------------------------------------------------
function cell(row, header) {
  const v = row[header];
  if (v === undefined || v === null) return '';
  // exceljs puede devolver objetos (formula, hipervinculo, texto rico):
  // se toma su resultado/texto en vez de imprimir "[object Object]".
  if (typeof v === 'object' && !(v instanceof Date)) {
    if (v.result !== undefined) return String(v.result).trim();
    if (v.text !== undefined) return String(v.text).trim();
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('').trim();
  }
  return v instanceof Date ? v : String(v).trim();
}

function parseBool(v) {
  return ['si', 'sí', 'yes', 'true', '1'].includes(String(v).toLowerCase()) ? 1 : 0;
}

// Date de exceljs (UTC medianoche), AAAA-MM-DD o DD/MM/AAAA -> 'AAAA-MM-DD'.
// Devuelve null si esta vacio y undefined si no se entiende.
function parseDate(v) {
  if (v === '' || v === null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return undefined;
}

// rows: filas ya leidas (encabezado -> valor). Cada equipo se guarda con su
// asignacion activa (si trae usuario y no esta en stock) y, si su estado es
// "en_reparacion", con su incidente de reparacion abierto - todo en una
// transaccion por fila, para no dejar un equipo a medias si algo falla.
// Un IMEI que ya existe se omite (no se duplica ni se pisa): reimportar el
// mismo archivo es inofensivo.
async function importDevices(rows, userId, { dryRun = false } = {}) {
  const errors = [];
  const byStatus = {};
  let imported = 0;

  const [[peru]] = await pool.query(
    "SELECT id FROM phone_country_codes WHERE calling_code = '51' LIMIT 1"
  );
  const today = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2; // fila 1 es el encabezado
    const row = rows[i];
    const fail = (message) => errors.push({ row: rowNum, message });

    const imei = String(cell(row, 'IMEI'));
    const area = String(cell(row, 'Área'));
    if (!imei) { fail('Falta el campo obligatorio "IMEI"'); continue; }
    if (!area) { fail(`IMEI ${imei}: falta el campo obligatorio "Área"`); continue; }

    const phone = String(cell(row, 'Número'));
    const hasChipRaw = String(cell(row, 'Tiene chip'));
    const holder = String(cell(row, 'Usuario asignado'));
    const cargo = String(cell(row, 'Cargo'));
    const turno = String(cell(row, 'Turno'));
    const obs = String(cell(row, 'Observación'));
    const estadoRaw = String(cell(row, 'Estado')).toLowerCase();
    const assignedDate = parseDate(cell(row, 'Fecha de entrega'));

    const data = {
      imei,
      phone_number: phone || null,
      phone_country_code_id: phone && peru ? peru.id : null,
      asset_code: String(cell(row, 'Código')) || null,
      brand: String(cell(row, 'Marca')) || null,
      model: String(cell(row, 'Modelo')) || null,
      operadora: String(cell(row, 'Operadora')) || null,
      area,
      sede: String(cell(row, 'Sede')) || null,
      notes: obs || null,
    };

    const problems = await validateDeviceData(data);
    if (assignedDate === undefined) problems.push('La fecha de entrega no se entiende (usa AAAA-MM-DD o DD/MM/AAAA).');
    if (estadoRaw && !STATUSES.includes(estadoRaw)) problems.push(`Estado inválido "${estadoRaw}" (usa ${STATUSES.join(', ')}).`);
    if (holder.length > 150) problems.push('El usuario asignado supera los 150 caracteres.');
    if (cargo.length > 150) problems.push('El cargo supera los 150 caracteres.');
    if (turno.length > 50) problems.push('El turno supera los 50 caracteres.');
    if (problems.length > 0) { fail(`IMEI ${imei}: ${problems.join(' ')}`); continue; }

    const [[dup]] = await pool.query('SELECT id FROM mobile_devices WHERE imei = ? LIMIT 1', [imei]);
    if (dup) { fail(`IMEI ${imei}: ya estaba registrado, se omitió.`); continue; }

    const status = estadoRaw || (holder ? 'asignado' : 'en_stock');
    const withAssignment = holder && (status === 'asignado' || status === 'en_reparacion');

    if (dryRun) {
      imported += 1;
      byStatus[status] = (byStatus[status] || 0) + 1;
      continue;
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `INSERT INTO mobile_devices
          (imei, phone_country_code_id, phone_number, has_chip, asset_code, brand, model, operadora,
           area, sede, status, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.imei, data.phone_country_code_id, data.phone_number,
          hasChipRaw ? parseBool(hasChipRaw) : (phone ? 1 : 0),
          data.asset_code, data.brand, data.model, data.operadora,
          data.area, data.sede, status, data.notes, userId,
        ]
      );
      const deviceId = result.insertId;
      if (withAssignment) {
        await conn.query(
          `INSERT INTO mobile_device_assignments
            (device_id, holder_name, cargo, turno, assigned_date, observacion, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [deviceId, holder, cargo || null, turno || null, assignedDate, obs || null, userId]
        );
      }
      if (status === 'en_reparacion') {
        await conn.query(
          `INSERT INTO mobile_device_incidents (device_id, tipo, fecha, descripcion, created_by)
           VALUES (?, 'reparacion', ?, ?, ?)`,
          [deviceId, today, obs || 'Registrado como en reparación al importar el inventario', userId]
        );
      }
      await conn.commit();
      imported += 1;
      byStatus[status] = (byStatus[status] || 0) + 1;
    } catch (err) {
      await conn.rollback();
      fail(`IMEI ${imei}: ${err.message}`);
    } finally {
      conn.release();
    }
  }

  return { imported, errors, byStatus };
}

module.exports = { IMEI_REGEX, MODEL_REGEX, STATUSES, validateDeviceData, importDevices };
