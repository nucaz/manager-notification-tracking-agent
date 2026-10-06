// Inventario de usuarios de la aplicacion Clinic: quien tiene usuario, con
// que perfil, en que sede y area, quien lo pidio, y su baja. Perfil, sede y
// area salen de los catalogos (perfil_clinic, sede, area). El listado que
// exporta Clinic se importa y actualiza por nombre de usuario.
const pool = require('../db/pool');
const catalogService = require('./catalogService');

const STATUS = {
  activo: { label: 'Activo', badge: 'text-bg-success' },
  inactivo: { label: 'Inactivo', badge: 'text-bg-secondary' },
  baja: { label: 'De baja', badge: 'text-bg-danger' },
};
const USERNAME = /^[A-Za-z0-9._@-]{2,60}$/;

const clean = (v, max = 255) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);
const fold = (v) => clean(v).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ');

async function list({ q, status, perfil, sede, area } = {}) {
  let sql = `SELECT c.*, s.full_name AS supervisor_name, s.username AS supervisor_username,
                    sr.requested_by_name, sr.requested_by_cargo
             FROM clinic_users c
             LEFT JOIN clinic_users s ON s.id = c.supervisor_id
             LEFT JOIN service_requests sr ON sr.id = c.request_id
             WHERE 1=1`;
  const params = [];
  if (status && STATUS[status]) { sql += ' AND c.status = ?'; params.push(status); }
  if (perfil) { sql += ' AND c.perfil = ?'; params.push(perfil); }
  if (sede) { sql += ' AND c.sede = ?'; params.push(sede); }
  if (area) { sql += ' AND c.area = ?'; params.push(area); }
  if (q) {
    sql += ' AND (c.full_name LIKE ? OR c.username LIKE ? OR c.clinic_registered_by LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY c.status = \'baja\', c.full_name, c.username';
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function get(id) {
  const [[row]] = await pool.query(
    `SELECT c.*, s.full_name AS supervisor_name, s.username AS supervisor_username, e.dni AS employee_dni
     FROM clinic_users c LEFT JOIN clinic_users s ON s.id = c.supervisor_id LEFT JOIN employees e ON e.id = c.employee_id
     WHERE c.id = ?`, [id]
  );
  return row || null;
}

async function counts() {
  const [rows] = await pool.query('SELECT status, COUNT(*) AS n FROM clinic_users GROUP BY status');
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

// Valida y normaliza el formulario. Devuelve { data, errors }.
async function validate(body, id = null) {
  const errors = [];
  const data = {
    full_name: clean(body.full_name, 150),
    username: clean(body.username, 60),
    status: STATUS[body.status] && body.status !== 'baja' ? body.status : 'activo',
    perfil: clean(body.perfil, 100) || null,
    sede: clean(body.sede, 100) || null,
    area: clean(body.area, 100) || null,
    supervisor_id: Number(body.supervisor_id) || null,
    approved: body.approved ? 1 : 0,
    notes: clean(body.notes, 2000) || null,
    employee_id: null,
  };
  if (!data.full_name) errors.push('El nombre es obligatorio.');
  if (!USERNAME.test(data.username)) errors.push('Usuario: 2 a 60 caracteres, letras, números, punto, guion o @ (sin espacios).');
  if (!data.perfil) errors.push('El perfil es obligatorio.');
  if (!data.sede) errors.push('La sede es obligatoria.');
  const [[dup]] = await pool.query('SELECT id FROM clinic_users WHERE username = ? AND id <> ?', [data.username, id || 0]);
  if (dup) errors.push(`Ya existe el usuario ${data.username} en el inventario.`);
  if (data.supervisor_id && id && data.supervisor_id === Number(id)) errors.push('Un usuario no puede ser su propio supervisor.');
  const dni = clean(body.dni, 8);
  if (dni) {
    if (!/^\d{8}$/.test(dni)) errors.push('El DNI debe tener 8 dígitos.');
    else {
      const [[e]] = await pool.query('SELECT id FROM employees WHERE dni = ?', [dni]);
      if (e) data.employee_id = e.id;
      else errors.push(`No hay un empleado con DNI ${dni} en el directorio (déjelo vacío o regístrelo en Empleados).`);
    }
  }
  return { data, errors };
}

async function create(data, user, requestId) {
  const [r] = await pool.query(
    `INSERT INTO clinic_users (full_name, username, status, perfil, sede, area, supervisor_id, approved, employee_id, request_id, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.full_name, data.username, data.status, data.perfil, data.sede, data.area, data.supervisor_id, data.approved,
      data.employee_id, requestId || null, data.notes, user.id]
  );
  return r.insertId;
}

async function update(id, data) {
  await pool.query(
    `UPDATE clinic_users SET full_name = ?, username = ?, status = IF(status = 'baja', 'baja', ?), perfil = ?, sede = ?, area = ?,
       supervisor_id = ?, approved = ?, employee_id = ?, notes = ? WHERE id = ?`,
    [data.full_name, data.username, data.status, data.perfil, data.sede, data.area, data.supervisor_id, data.approved,
      data.employee_id, data.notes, id]
  );
}

// --------------------------------- importar ---------------------------------
const HEADERS = {
  full_name: ['nombre', 'nombres', 'nombre completo'],
  username: ['usuario', 'user', 'login'],
  status: ['estado'],
  perfil: ['perfil'],
  sede: ['sede'],
  area: ['area'],
  registered_by: ['registrado por'],
  registered_at: ['fecha registro', 'fecha de registro'],
  supervisor: ['supervisor'],
  approved: ['aprobacion', 'aprobado', 'usuario aprobado'],
};
const IMPORT_COLUMNS = [
  { header: 'NOMBRE', required: false }, { header: 'USUARIO', required: true }, { header: 'ESTADO', required: false },
  { header: 'PERFIL', required: false }, { header: 'SEDE', required: false }, { header: 'ÁREA', required: false },
  { header: 'REGISTRADO POR', required: false }, { header: 'FECHA REGISTRO', required: false },
  { header: 'SUPERVISOR (usuario)', required: false }, { header: 'APROBADO (Sí/No)', required: false },
];

function pick(row, field) {
  const want = HEADERS[field];
  const key = Object.keys(row).find((k) => want.includes(fold(k)));
  if (key === undefined) return '';
  const v = row[key];
  if (v && typeof v === 'object' && !(v instanceof Date)) return clean(v.text || v.result || '');
  return v instanceof Date ? v : clean(v);
}

function parseDateTime(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
  const m = clean(v).match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, d, mo, y, h = '0', mi = '0', s = '0'] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')} ${h.padStart(2, '0')}:${mi}:${s.padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(clean(v))) return clean(v).slice(0, 19);
  return null;
}

// Crea o actualiza por usuario. Lo que dice Clinic manda (nombre, estado,
// perfil, sede), salvo una baja registrada aqui: si Clinic lo muestra
// ACTIVO se informa como diferencia (hay que desactivarlo en Clinic).
async function importRows(rows, user) {
  const errors = [];
  const notes = [];
  let created = 0;
  let updated = 0;
  const sedes = await catalogService.getActive('sede');
  const areas = await catalogService.getActive('area');
  const perfiles = new Set((await catalogService.getActive('perfil_clinic')).map(fold));
  const byFold = (list, v) => list.find((x) => fold(x) === fold(v));
  const newPerfiles = new Set();
  const supervisors = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const line = i + 2;
    const username = clean(pick(row, 'username'), 60);
    if (!username && Object.values(row).every((v) => !clean(v))) continue;
    if (!USERNAME.test(username)) { errors.push({ row: line, message: `Usuario no válido: "${username}".` }); continue; }
    const estado = fold(pick(row, 'status'));
    const status = estado.startsWith('inact') ? 'inactivo' : 'activo';
    const perfil = clean(pick(row, 'perfil'), 100) || null;
    if (perfil && !perfiles.has(fold(perfil))) {
      await catalogService.add('perfil_clinic', perfil, user.id).catch(() => {});
      perfiles.add(fold(perfil));
      newPerfiles.add(perfil);
    }
    const sedeRaw = clean(pick(row, 'sede'), 100);
    const sede = sedeRaw ? (byFold(sedes, sedeRaw) || sedeRaw) : null;
    if (sedeRaw && !byFold(sedes, sedeRaw)) notes.push(`Fila ${line}: la sede "${sedeRaw}" no está en el catálogo (se guardó igual).`);
    const areaRaw = clean(pick(row, 'area'), 100);
    const area = areaRaw ? (byFold(areas, areaRaw) || areaRaw) : null;
    const name = clean(pick(row, 'full_name'), 150);
    const registeredBy = clean(pick(row, 'registered_by'), 150) || null;
    const registeredAt = parseDateTime(pick(row, 'registered_at'));
    const approvedRaw = fold(pick(row, 'approved'));
    const approved = approvedRaw ? (['si', 'yes', '1', 'true', 'aprobado'].includes(approvedRaw) ? 1 : 0) : null;
    const [[existing]] = await pool.query('SELECT id, status, full_name FROM clinic_users WHERE username = ?', [username]);
    if (existing) {
      if (existing.status === 'baja' && status === 'activo') {
        notes.push(`Fila ${line}: ${username} está DE BAJA aquí pero Clinic lo muestra ACTIVO: desactívelo en Clinic.`);
      }
      await pool.query(
        `UPDATE clinic_users SET full_name = IF(? = '', full_name, ?), status = IF(status = 'baja', 'baja', ?),
           perfil = COALESCE(?, perfil), sede = COALESCE(?, sede), area = COALESCE(?, area),
           clinic_registered_by = COALESCE(?, clinic_registered_by), clinic_registered_at = COALESCE(?, clinic_registered_at),
           approved = COALESCE(?, approved) WHERE id = ?`,
        [name, name, status, perfil, sede, area, registeredBy, registeredAt, approved, existing.id]
      );
      updated += 1;
    } else {
      if (!name) notes.push(`Fila ${line}: ${username} no trae nombre en Clinic (complételo en su ficha).`);
      await pool.query(
        `INSERT INTO clinic_users (full_name, username, status, perfil, sede, area, approved, clinic_registered_by, clinic_registered_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, username, status, perfil, sede, area, approved === null ? 1 : approved, registeredBy, registeredAt, user.id]
      );
      created += 1;
    }
    const sup = clean(pick(row, 'supervisor'), 60);
    if (sup) supervisors.push({ username, sup, line });
  }
  // Supervisores al final: pueden venir en filas posteriores.
  for (const s of supervisors) {
    const [[boss]] = await pool.query('SELECT id FROM clinic_users WHERE username = ? OR full_name = ? LIMIT 1', [s.sup, s.sup]);
    if (boss) await pool.query('UPDATE clinic_users SET supervisor_id = ? WHERE username = ? AND id <> ?', [boss.id, s.username, boss.id]);
    else notes.push(`Fila ${s.line}: el supervisor "${s.sup}" no está en el inventario.`);
  }
  if (newPerfiles.size) notes.unshift(`Perfiles nuevos agregados al catálogo: ${[...newPerfiles].join(', ')}.`);
  return { imported: created + updated, created, updated, errors, notes };
}

module.exports = { STATUS, IMPORT_COLUMNS, list, get, counts, validate, create, update, importRows, parseDateTime };
