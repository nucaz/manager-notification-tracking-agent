// Solicitudes: quien pide algo para otra persona (un jefe o gerente pide un
// celular, una cuenta de Microsoft 365 o un usuario de Clinic). Una sola
// tabla para todos los modulos (service_requests), asi se rastrea todo lo
// que pidio alguien. El solicitante se guarda como foto (nombre, cargo y
// area al momento de pedir) y, si esta en el directorio, vinculado al
// empleado.
//
// Celulares y Clinic registran la solicitud ya cumplida (se asigna o se
// crea en el momento). Microsoft 365 tiene flujo: pendiente -> aprobada ->
// en proceso -> completada (o rechazada/cancelada), con pasos que se
// marcan con su evidencia (ver m365Service.TASKS).
const pool = require('../db/pool');

const MODULES = { celular: 'Celulares', m365: 'Microsoft 365', clinic: 'Clinic' };
const STATUS = {
  pendiente: { label: 'Pendiente', badge: 'text-bg-warning' },
  aprobada: { label: 'Aprobada', badge: 'text-bg-info' },
  en_proceso: { label: 'En proceso', badge: 'text-bg-primary' },
  completada: { label: 'Completada', badge: 'text-bg-success' },
  rechazada: { label: 'Rechazada', badge: 'text-bg-danger' },
  cancelada: { label: 'Cancelada', badge: 'text-bg-secondary' },
};
const OPEN = ['pendiente', 'aprobada', 'en_proceso'];

const clean = (v, max = 255) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

// Empleados para el selector de solicitante: "Apellidos Nombres · DNI".
async function pickerOptions() {
  const [rows] = await pool.query(
    'SELECT id, dni, first_name, last_name, cargo, area FROM employees ORDER BY last_name, first_name LIMIT 5000'
  );
  return rows.map((e) => ({ ...e, label: `${e.last_name} ${e.first_name} · DNI ${e.dni}` }));
}

// Lee el solicitante del formulario (campos <prefix>name, cargo, area,
// date, ref). Si el nombre trae un DNI del directorio, se vincula y se
// completan cargo y area que falten. Devuelve null si no se indico nadie.
async function parseRequester(body, prefix = 'req_') {
  const raw = clean(body[`${prefix}name`], 200);
  if (!raw) return null;
  const out = {
    employee_id: null,
    name: raw.replace(/\s*·\s*DNI\s*\d{8}\s*$/, '').slice(0, 150),
    cargo: clean(body[`${prefix}cargo`], 150) || null,
    area: clean(body[`${prefix}area`], 100) || null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(clean(body[`${prefix}date`])) ? clean(body[`${prefix}date`]) : new Date().toISOString().slice(0, 10),
    ref: clean(body[`${prefix}ref`], 80) || null,
  };
  const dni = (raw.match(/DNI\s*(\d{8})\s*$/) || [])[1];
  if (dni) {
    const [[e]] = await pool.query('SELECT id, first_name, last_name, cargo, area FROM employees WHERE dni = ?', [dni]);
    if (e) {
      out.employee_id = e.id;
      out.name = `${e.first_name} ${e.last_name}`;
      out.cargo = out.cargo || e.cargo || null;
      out.area = out.area || e.area || null;
    }
  }
  return out;
}

function describe(r) {
  if (!r) return '';
  return `${r.name}${r.cargo ? ` (${r.cargo}${r.area ? `, ${r.area}` : ''})` : ''}${r.ref ? `, ref. ${r.ref}` : ''}, el ${r.date}`;
}

// Crea la solicitud. status 'completada' para celulares/Clinic (se cumple
// en el momento); tasks: [{key, label, required, evidence_label}].
async function create({ module, type, status = 'pendiente', entityId = null, requester, beneficiary = null, details = {}, notes = null, tasks = [] }, user, conn = pool) {
  if (!MODULES[module]) throw new Error('Modulo no valido.');
  if (!requester) throw new Error('Indique quien solicita.');
  const [r] = await conn.query(
    `INSERT INTO service_requests
      (module, request_type, status, entity_id, requested_by_employee_id, requested_by_name, requested_by_cargo, requested_by_area,
       request_date, request_ref, beneficiary_name, details_json, notes, created_by, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [module, type, status, entityId, requester.employee_id, requester.name, requester.cargo, requester.area, requester.date,
      requester.ref, beneficiary ? clean(beneficiary, 150) : null, JSON.stringify(details || {}), notes, user ? user.id : null,
      status === 'completada' ? new Date() : null]
  );
  let seq = 0;
  for (const t of tasks) {
    seq += 1;
    await conn.query(
      'INSERT INTO service_request_tasks (request_id, seq, task_key, label, required, evidence_label) VALUES (?, ?, ?, ?, ?, ?)',
      [r.insertId, seq, t.key, t.label, t.required === false ? 0 : 1, t.evidence_label || null]
    );
  }
  return r.insertId;
}

async function get(id) {
  const [[r]] = await pool.query(
    `SELECT r.*, u.full_name AS created_by_name, d.full_name AS decided_by_name
     FROM service_requests r
     LEFT JOIN users u ON u.id = r.created_by
     LEFT JOIN users d ON d.id = r.decided_by
     WHERE r.id = ?`, [id]
  );
  if (!r) return null;
  const [tasks] = await pool.query(
    `SELECT t.*, u.full_name AS done_by_name FROM service_request_tasks t LEFT JOIN users u ON u.id = t.done_by
     WHERE t.request_id = ? ORDER BY t.seq`, [id]
  );
  r.details = JSON.parse(r.details_json || '{}');
  r.tasks = tasks;
  return r;
}

async function list({ module, status, q, requesterId, limit = 500 } = {}) {
  let sql = `SELECT r.*, (SELECT COUNT(*) FROM service_request_tasks t WHERE t.request_id = r.id) AS tasks_total,
                    (SELECT COUNT(*) FROM service_request_tasks t WHERE t.request_id = r.id AND t.done_at IS NOT NULL) AS tasks_done
             FROM service_requests r WHERE 1=1`;
  const params = [];
  if (module && MODULES[module]) { sql += ' AND r.module = ?'; params.push(module); }
  if (status === 'abiertas') sql += " AND r.status IN ('pendiente', 'aprobada', 'en_proceso')";
  else if (status && STATUS[status]) { sql += ' AND r.status = ?'; params.push(status); }
  if (requesterId) { sql += ' AND r.requested_by_employee_id = ?'; params.push(requesterId); }
  if (q) {
    sql += ' AND (r.requested_by_name LIKE ? OR r.beneficiary_name LIKE ? OR r.request_ref LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY r.request_date DESC, r.id DESC LIMIT ?';
  params.push(limit);
  const [rows] = await pool.query(sql, params);
  return rows;
}

// Solicitudes de una entidad (historial en la ficha del celular, la cuenta o el usuario de Clinic).
async function ofEntity(module, entityId) {
  const [rows] = await pool.query(
    'SELECT * FROM service_requests WHERE module = ? AND entity_id = ? ORDER BY request_date DESC, id DESC', [module, entityId]
  );
  return rows;
}

async function decide(id, approve, user, reason) {
  const r = await get(id);
  if (!r) throw new Error('Solicitud no encontrada.');
  if (r.status !== 'pendiente') throw new Error('Solo una solicitud pendiente se aprueba o rechaza.');
  if (!approve && !clean(reason)) throw new Error('Indique el motivo del rechazo.');
  await pool.query(
    'UPDATE service_requests SET status = ?, decided_by = ?, decided_at = NOW(), notes = CONCAT_WS(?, NULLIF(notes, \'\'), ?) WHERE id = ?',
    [approve ? 'aprobada' : 'rechazada', user.id, '\n', approve ? null : `Rechazada: ${clean(reason, 500)}`, id]
  );
  return r;
}

async function cancel(id, user, reason) {
  const r = await get(id);
  if (!r) throw new Error('Solicitud no encontrada.');
  if (!OPEN.includes(r.status)) throw new Error('La solicitud ya esta cerrada.');
  await pool.query(
    'UPDATE service_requests SET status = \'cancelada\', notes = CONCAT_WS(?, NULLIF(notes, \'\'), ?) WHERE id = ?',
    ['\n', `Cancelada por ${user.full_name || user.email}: ${clean(reason, 400) || 'sin motivo'}`, id]
  );
  return r;
}

// Marca un paso como hecho (con su evidencia si la pide). Una solicitud
// pendiente no avanza: primero se aprueba.
async function completeTask(requestId, taskId, evidence, user) {
  const r = await get(requestId);
  if (!r) throw new Error('Solicitud no encontrada.');
  if (!['aprobada', 'en_proceso'].includes(r.status)) {
    throw new Error(r.status === 'pendiente' ? 'Primero apruebe la solicitud.' : 'La solicitud ya esta cerrada.');
  }
  const t = r.tasks.find((x) => x.id === Number(taskId));
  if (!t) throw new Error('Paso no encontrado.');
  if (t.done_at) throw new Error('Ese paso ya esta hecho.');
  const ev = clean(evidence, 500);
  if (t.evidence_label && !ev) throw new Error(`Indique: ${t.evidence_label}.`);
  await pool.query('UPDATE service_request_tasks SET done_by = ?, done_at = NOW(), evidence = ? WHERE id = ?', [user.id, ev || null, t.id]);
  if (r.status === 'aprobada') await pool.query("UPDATE service_requests SET status = 'en_proceso' WHERE id = ?", [r.id]);
  return { request: r, task: { ...t, evidence: ev } };
}

function pendingRequired(r) {
  return r.tasks.filter((t) => t.required && !t.done_at);
}

async function markCompleted(id, entityId = null, conn = pool) {
  await conn.query(
    "UPDATE service_requests SET status = 'completada', completed_at = NOW(), entity_id = COALESCE(?, entity_id) WHERE id = ?",
    [entityId, id]
  );
}

module.exports = {
  MODULES, STATUS, OPEN, pickerOptions, parseRequester, describe, create, get, list, ofEntity, decide, cancel,
  completeTask, pendingRequired, markCompleted,
};
