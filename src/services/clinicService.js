// Inventario de usuarios de la aplicacion Clinic: quien tiene usuario, con
// que perfil, en que sede y area, quien lo pidio, su historial y su baja.
// Perfiles y sedes son tablas propias (clinic_profiles, clinic_sedes, con el
// Id que tienen en Clinic) y el area es un id del catalogo general: todo por
// clave foranea. Si el usuario no tiene area propia, vale la de su perfil.
// La importacion del listado de Clinic esta en clinicImportService.
const pool = require('../db/pool');

const STATUS = {
  activo: { label: 'Activo', badge: 'text-bg-success' },
  inactivo: { label: 'Inactivo', badge: 'text-bg-secondary' },
  baja: { label: 'De baja', badge: 'text-bg-danger' },
};
// "Aprobado" de Clinic (codigos de Clinic).
const APPROVAL = {
  0: { label: 'No aprobado', badge: 'text-bg-light border' },
  1: { label: 'Aprobado', badge: 'text-bg-info' },
  3: { label: 'Pendiente de aprobación', badge: 'text-bg-warning' },
};
const EVENTS = {
  alta: 'Alta', edicion: 'Edición', baja: 'Baja', reactivacion: 'Reactivación', importacion: 'Importación',
};
// Un activo sin entrar a Clinic en este tiempo es candidato a desactivarse;
// desde PURGE_DAYS (o si nunca entro y se creo hace mas de un mes),
// candidato a depurar.
const IDLE_DAYS = 90;
const PURGE_DAYS = 180;
// Antiguedad de la ultima conexion, de la mas reciente a nunca.
const BUCKETS = [
  { key: 'd30', label: 'Hasta 30 días', tone: 'ok' },
  { key: 'd90', label: '31 a 90 días', tone: 'ok' },
  { key: 'd180', label: '91 a 180 días', tone: 'warn' },
  { key: 'd365', label: '181 días a 1 año', tone: 'bad' },
  { key: 'mas365', label: 'Más de 1 año', tone: 'bad' },
  { key: 'nunca', label: 'Nunca entró', tone: 'bad' },
];
const BUCKET_SQL = `CASE WHEN o.last_login_at IS NULL THEN 'nunca'
  WHEN o.last_login_at >= NOW() - INTERVAL 30 DAY THEN 'd30'
  WHEN o.last_login_at >= NOW() - INTERVAL 90 DAY THEN 'd90'
  WHEN o.last_login_at >= NOW() - INTERVAL 180 DAY THEN 'd180'
  WHEN o.last_login_at >= NOW() - INTERVAL 365 DAY THEN 'd365'
  ELSE 'mas365' END`;
const PURGE_SQL = `(c.status = 'activo' AND (o.last_login_at < NOW() - INTERVAL ${PURGE_DAYS} DAY
  OR (o.last_login_at IS NULL AND COALESCE(o.registered_at, c.created_at) < NOW() - INTERVAL 30 DAY)))`;
// "Empleado de planilla": vinculado a un empleado del directorio que no se
// creo desde Clinic (employees.source NULL).
const NO_PAYROLL_SQL = "(c.employee_id IS NULL OR c.employee_id IN (SELECT x.id FROM employees x WHERE x.source = 'clinic'))";
const ALERTS = {
  depurar: `Candidatos a depurar (+${PURGE_DAYS} días o nunca)`,
  sin_conexion: `Activos sin entrar en ${IDLE_DAYS} días`,
  nunca: 'Nunca entraron',
  sin_empleado: 'Activos sin empleado en planilla',
  sin_area: 'Activos sin área',
  sin_aprobar: 'Activos no aprobados',
  pendiente: 'Activos pendientes de aprobación',
  dni_repetido: 'DNI repetido',
  usuario_repetido: 'Usuario repetido',
  sin_dni: 'Activos sin DNI',
};
const SORTS = {
  nombre: 'c.full_name, c.username',
  usuario: 'c.username',
  conexion: 'o.last_login_at IS NULL, o.last_login_at DESC',
  registro: 'o.registered_at DESC',
  sede: 's.name, c.full_name',
};
const PER_PAGE = 50;

const clean = (v, max = 255) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);
const fold = (v) => clean(v).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ');
// Clinic tiene usuarios con espacio de no separacion y espacios al final.
const normUsername = (v) => String(v === undefined || v === null ? '' : v).replace(/[\s   ]+/g, ' ').trim().slice(0, 60);
const USERNAME = /^[\p{L}\p{N}._@-](?:[\p{L}\p{N}._@ -]{0,58}[\p{L}\p{N}._@-])?$/u;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const intOrNull = (v) => (/^\d+$/.test(String(v || '').trim()) ? Number(v) : null);

// --------------------------------- catalogos ---------------------------------
async function areas() {
  const [rows] = await pool.query("SELECT id, value, active FROM catalog_items WHERE catalog_type = 'area' ORDER BY value");
  return rows;
}

async function generalSedes() {
  const [rows] = await pool.query("SELECT id, value, active FROM catalog_items WHERE catalog_type = 'sede' ORDER BY value");
  return rows;
}

async function profiles({ withCounts = false } = {}) {
  const [rows] = await pool.query(
    `SELECT p.*, a.value AS area_name${withCounts ? `,
            (SELECT COUNT(*) FROM clinic_users c WHERE c.profile_id = p.id AND c.status = 'activo') AS users_active,
            (SELECT COUNT(*) FROM clinic_users c WHERE c.profile_id = p.id) AS users_total` : ''}
     FROM clinic_profiles p LEFT JOIN catalog_items a ON a.id = p.area_item_id
     ORDER BY p.active DESC, p.name`
  );
  return rows;
}

async function sedes({ withCounts = false } = {}) {
  const [rows] = await pool.query(
    `SELECT s.*, g.value AS general_name${withCounts ? `,
            (SELECT COUNT(*) FROM clinic_users c WHERE c.sede_id = s.id AND c.status = 'activo') AS users_active,
            (SELECT COUNT(*) FROM clinic_users c WHERE c.sede_id = s.id) AS users_total` : ''}
     FROM clinic_sedes s LEFT JOIN catalog_items g ON g.id = s.sede_item_id
     ORDER BY s.active DESC, s.name`
  );
  return rows;
}

function catalogData(body, kind) {
  const errors = [];
  const data = {
    name: clean(body.name, 100).toUpperCase(),
    clinic_id: intOrNull(body.clinic_id),
    active: body.active === '0' ? 0 : 1,
  };
  if (!data.name) errors.push('El nombre es obligatorio.');
  if (clean(body.clinic_id) && data.clinic_id === null) errors.push('El Id de Clinic debe ser un número.');
  if (kind === 'perfil') {
    data.area_item_id = intOrNull(body.area_item_id);
    data.description = clean(body.description, 255) || null;
  } else {
    data.sede_item_id = intOrNull(body.sede_item_id);
    data.address = clean(body.address, 255) || null;
    data.opens_at = /^\d{2}:\d{2}$/.test(clean(body.opens_at)) ? `${clean(body.opens_at)}:00` : null;
    data.closes_at = /^\d{2}:\d{2}$/.test(clean(body.closes_at)) ? `${clean(body.closes_at)}:00` : null;
  }
  return { data, errors };
}

// Crea o actualiza un perfil o una sede de Clinic. Devuelve el id.
async function saveCatalog(kind, id, body) {
  const { data, errors } = catalogData(body, kind);
  if (errors.length) throw new Error(errors.join(' '));
  const table = kind === 'perfil' ? 'clinic_profiles' : 'clinic_sedes';
  try {
    if (id) {
      const [r] = await pool.query('UPDATE ?? SET ? WHERE id = ?', [table, data, id]);
      if (!r.affectedRows) throw new Error('No existe.');
      return Number(id);
    }
    const [r] = await pool.query('INSERT INTO ?? SET ?', [table, data]);
    return r.insertId;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new Error(`Ya existe ${kind === 'perfil' ? 'un perfil' : 'una sede'} con ese nombre o ese Id de Clinic.`);
    if (err.code === 'ER_NO_REFERENCED_ROW_2') throw new Error('El área o la sede elegida ya no existe en el catálogo.');
    throw err;
  }
}

// --------------------------------- usuarios ---------------------------------
const SELECT = `
  SELECT c.*, p.name AS profile_name, p.clinic_id AS profile_clinic_id, s.name AS sede_name, s.address AS sede_address,
         s.opens_at AS sede_opens_at, s.closes_at AS sede_closes_at, g.value AS sede_general,
         COALESCE(a.value, pa.value) AS area_name, (c.area_item_id IS NULL AND pa.id IS NOT NULL) AS area_from_profile,
         sup.full_name AS supervisor_name, sup.username AS supervisor_username, sup.id AS supervisor_ref,
         o.last_login_at, o.registered_by, o.registered_at, o.edited_by, o.edited_at, o.imported_at,
         sr.requested_by_name, sr.requested_by_cargo, sr.request_ref,
         b.event_date AS baja_date, b.reason AS baja_reason,
         e.first_name AS employee_first_name, e.last_name AS employee_last_name
  FROM clinic_users c
  LEFT JOIN clinic_profiles p ON p.id = c.profile_id
  LEFT JOIN catalog_items pa ON pa.id = p.area_item_id
  LEFT JOIN clinic_sedes s ON s.id = c.sede_id
  LEFT JOIN catalog_items g ON g.id = s.sede_item_id
  LEFT JOIN catalog_items a ON a.id = c.area_item_id
  LEFT JOIN clinic_users sup ON sup.id = c.supervisor_id
  LEFT JOIN clinic_user_origin o ON o.clinic_user_id = c.id
  LEFT JOIN service_requests sr ON sr.id = c.request_id
  LEFT JOIN employees e ON e.id = c.employee_id
  LEFT JOIN clinic_user_events b ON b.id = (SELECT MAX(x.id) FROM clinic_user_events x WHERE x.clinic_user_id = c.id AND x.event_type = 'baja')`;

function filtersOf(query) {
  return {
    q: clean(query.q, 100),
    status: STATUS[query.estado] ? query.estado : '',
    profile: intOrNull(query.perfil),
    sede: intOrNull(query.sede),
    area: intOrNull(query.area),
    supervisor: intOrNull(query.supervisor),
    alert: ALERTS[query.alerta] ? query.alerta : '',
    bucket: BUCKETS.some((b) => b.key === query.conexion) ? query.conexion : '',
    sort: SORTS[query.orden] ? query.orden : 'nombre',
  };
}

function where(f) {
  const w = [];
  const params = [];
  if (f.status) { w.push('c.status = ?'); params.push(f.status); }
  if (f.profile) { w.push('c.profile_id = ?'); params.push(f.profile); }
  if (f.sede) { w.push('c.sede_id = ?'); params.push(f.sede); }
  if (f.area) { w.push('(c.area_item_id = ? OR (c.area_item_id IS NULL AND p.area_item_id = ?))'); params.push(f.area, f.area); }
  if (f.supervisor) { w.push('c.supervisor_id = ?'); params.push(f.supervisor); }
  if (f.bucket) { w.push(`(${BUCKET_SQL}) = ?`); params.push(f.bucket); }
  if (f.q) {
    const like = `%${f.q}%`;
    w.push('(c.full_name LIKE ? OR c.username LIKE ? OR c.dni LIKE ? OR c.email LIKE ? OR o.registered_by LIKE ?)');
    params.push(like, like, like, like, like);
  }
  switch (f.alert) {
    case 'sin_conexion':
      w.push(`c.status = 'activo' AND (o.last_login_at IS NULL OR o.last_login_at < NOW() - INTERVAL ${IDLE_DAYS} DAY)`); break;
    case 'nunca': w.push('o.last_login_at IS NULL'); break;
    case 'depurar': w.push(PURGE_SQL); break;
    case 'sin_empleado': w.push(`c.status = 'activo' AND ${NO_PAYROLL_SQL}`); break;
    case 'sin_area': w.push("c.status = 'activo' AND c.area_item_id IS NULL AND p.area_item_id IS NULL"); break;
    case 'sin_aprobar': w.push("c.status = 'activo' AND c.approved = 0"); break;
    case 'pendiente': w.push("c.status = 'activo' AND c.approved = 3"); break;
    case 'sin_dni': w.push("c.status = 'activo' AND (c.dni IS NULL OR c.dni = '')"); break;
    case 'dni_repetido':
      w.push('c.dni IN (SELECT d.dni FROM clinic_users d WHERE d.dni IS NOT NULL AND d.dni <> \'\' GROUP BY d.dni HAVING COUNT(*) > 1)'); break;
    case 'usuario_repetido':
      w.push('c.username IN (SELECT d.username FROM clinic_users d GROUP BY d.username HAVING COUNT(*) > 1)'); break;
    default: break;
  }
  return { sql: w.length ? ` WHERE ${w.join(' AND ')}` : '', params };
}

// Listado paginado ({ page }) o completo ({ all: true }, para exportar).
async function list(f, { page = 1, all = false } = {}) {
  const { sql, params } = where(f);
  const order = ` ORDER BY ${SORTS[f.sort] || SORTS.nombre}, c.id`;
  if (all) {
    const [rows] = await pool.query(SELECT + sql + order, params);
    return { items: rows, total: rows.length, page: 1, pages: 1 };
  }
  const [[{ n }]] = await pool.query(
    `SELECT COUNT(*) AS n FROM clinic_users c LEFT JOIN clinic_profiles p ON p.id = c.profile_id
     LEFT JOIN clinic_user_origin o ON o.clinic_user_id = c.id${sql}`, params
  );
  const pages = Math.max(1, Math.ceil(n / PER_PAGE));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const [rows] = await pool.query(`${SELECT}${sql}${order} LIMIT ? OFFSET ?`, [...params, PER_PAGE, (current - 1) * PER_PAGE]);
  return { items: rows, total: Number(n), page: current, pages };
}

async function counts() {
  const [rows] = await pool.query('SELECT status, COUNT(*) AS n FROM clinic_users GROUP BY status');
  const out = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  const [[a]] = await pool.query(
    `SELECT
       SUM(c.status = 'activo' AND (o.last_login_at IS NULL OR o.last_login_at < NOW() - INTERVAL ${IDLE_DAYS} DAY)) AS sin_conexion,
       SUM(c.status = 'activo' AND c.approved = 0) AS sin_aprobar,
       SUM(c.status = 'activo' AND c.approved = 3) AS pendiente,
       SUM(c.status = 'activo' AND (c.dni IS NULL OR c.dni = '')) AS sin_dni,
       SUM(${PURGE_SQL}) AS depurar,
       SUM(c.status = 'activo' AND ${NO_PAYROLL_SQL}) AS sin_empleado,
       SUM(c.status = 'activo' AND c.area_item_id IS NULL AND p.area_item_id IS NULL) AS sin_area
     FROM clinic_users c LEFT JOIN clinic_user_origin o ON o.clinic_user_id = c.id
     LEFT JOIN clinic_profiles p ON p.id = c.profile_id`
  );
  const [[d]] = await pool.query(
    "SELECT COUNT(*) AS n FROM (SELECT dni FROM clinic_users WHERE dni IS NOT NULL AND dni <> '' GROUP BY dni HAVING COUNT(*) > 1) t"
  );
  const [[u]] = await pool.query('SELECT COUNT(*) AS n FROM (SELECT username FROM clinic_users GROUP BY username HAVING COUNT(*) > 1) t');
  out.alerts = {
    sin_conexion: Number(a.sin_conexion || 0), sin_aprobar: Number(a.sin_aprobar || 0), sin_dni: Number(a.sin_dni || 0),
    pendiente: Number(a.pendiente || 0), depurar: Number(a.depurar || 0), sin_empleado: Number(a.sin_empleado || 0),
    sin_area: Number(a.sin_area || 0),
    dni_repetido: Number(d.n), usuario_repetido: Number(u.n),
  };
  return out;
}

// Tablero de antiguedad de conexion. status: 'activo' (por defecto), 'inactivo' o '' (todos).
async function connectionDashboard({ status = 'activo', sede = null, profile = null } = {}) {
  const w = ['1 = 1'];
  const params = [];
  if (STATUS[status]) { w.push('c.status = ?'); params.push(status); }
  if (sede) { w.push('c.sede_id = ?'); params.push(sede); }
  if (profile) { w.push('c.profile_id = ?'); params.push(profile); }
  const from = `FROM clinic_users c LEFT JOIN clinic_user_origin o ON o.clinic_user_id = c.id
                LEFT JOIN clinic_sedes s ON s.id = c.sede_id LEFT JOIN clinic_profiles p ON p.id = c.profile_id
                WHERE ${w.join(' AND ')}`;
  const [byBucket] = await pool.query(`SELECT ${BUCKET_SQL} AS b, COUNT(*) AS n, SUM(${NO_PAYROLL_SQL}) AS sin_empleado ${from} GROUP BY b`, params);
  const [bySede] = await pool.query(`SELECT s.id, COALESCE(s.name, '(sin sede)') AS name, ${BUCKET_SQL} AS b, COUNT(*) AS n ${from} GROUP BY s.id, s.name, b`, params);
  const [byProfile] = await pool.query(`SELECT p.id, COALESCE(p.name, '(sin perfil)') AS name, ${BUCKET_SQL} AS b, COUNT(*) AS n ${from} GROUP BY p.id, p.name, b`, params);
  const [[k]] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(${PURGE_SQL}) AS depurar, SUM(${NO_PAYROLL_SQL}) AS sin_empleado,
            COUNT(DISTINCT CASE WHEN c.dni REGEXP '^[0-9]{8}$' THEN c.dni END) AS personas, MAX(o.last_login_at) AS ultima ${from}`, params
  );
  const [[emp]] = await pool.query("SELECT SUM(source IS NULL) AS directorio, SUM(source = 'clinic') AS desde_clinic FROM employees");
  const [[imp]] = await pool.query('SELECT created_at, file_name FROM clinic_imports ORDER BY id DESC LIMIT 1');
  const pivot = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const e = m.get(r.id) || { id: r.id, name: r.name, total: 0 };
      e[r.b] = Number(r.n);
      e.total += Number(r.n);
      m.set(r.id, e);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  };
  const buckets = BUCKETS.map((b) => {
    const r = byBucket.find((x) => x.b === b.key) || {};
    return { ...b, n: Number(r.n || 0), sinEmpleado: Number(r.sin_empleado || 0) };
  });
  return {
    buckets, bySede: pivot(bySede), byProfile: pivot(byProfile),
    kpi: { total: Number(k.total || 0), depurar: Number(k.depurar || 0), sinEmpleado: Number(k.sin_empleado || 0), personas: Number(k.personas || 0),
      ultima: k.ultima, recientes: (buckets.find((b) => b.key === 'd30') || {}).n || 0 },
    employees: { directorio: Number(emp.directorio || 0), desdeClinic: Number(emp.desde_clinic || 0) },
    lastImport: imp || null,
  };
}

// Activos e inactivos por sede (resumen del listado).
async function bySede() {
  const [rows] = await pool.query(
    `SELECT s.id, COALESCE(s.name, '(sin sede)') AS name, SUM(c.status = 'activo') AS activos, SUM(c.status = 'inactivo') AS inactivos,
            SUM(c.status = 'baja') AS bajas
     FROM clinic_users c LEFT JOIN clinic_sedes s ON s.id = c.sede_id
     GROUP BY s.id, s.name ORDER BY activos DESC`
  );
  return rows.map((r) => ({ ...r, activos: Number(r.activos), inactivos: Number(r.inactivos), bajas: Number(r.bajas) }));
}

async function get(id) {
  const [[row]] = await pool.query(`${SELECT} WHERE c.id = ?`, [id]);
  return row || null;
}

async function events(id) {
  const [rows] = await pool.query(
    `SELECT ev.*, u.full_name AS created_by_name, sr.requested_by_name, sr.request_ref, i.file_name
     FROM clinic_user_events ev
     LEFT JOIN users u ON u.id = ev.created_by
     LEFT JOIN service_requests sr ON sr.id = ev.request_id
     LEFT JOIN clinic_imports i ON i.id = ev.import_id
     WHERE ev.clinic_user_id = ? ORDER BY ev.created_at DESC, ev.id DESC`, [id]
  );
  return rows;
}

async function addEvent(conn, { userId, type, date = null, detail = null, reason = null, requestId = null, importId = null, by = null }) {
  await conn.query(
    `INSERT INTO clinic_user_events (clinic_user_id, event_type, event_date, detail, reason, request_id, import_id, created_by)
     VALUES (?, ?, COALESCE(?, CURDATE()), ?, ?, ?, ?, ?)`,
    [userId, type, date, detail ? String(detail).slice(0, 1000) : null, reason, requestId, importId, by]
  );
}

// Para el selector de supervisor: "USUARIO · Nombre" de los no dados de baja.
async function supervisorOptions(excludeId = 0) {
  const [rows] = await pool.query(
    "SELECT id, username, full_name FROM clinic_users WHERE status <> 'baja' AND id <> ? ORDER BY full_name", [excludeId || 0]
  );
  return rows.map((r) => ({ id: r.id, label: `${r.username} · ${r.full_name}` }));
}

async function resolveSupervisor(raw) {
  const v = clean(raw, 220);
  if (!v) return { id: null };
  const username = normUsername(v.split(' · ')[0]);
  const [found] = await pool.query("SELECT id FROM clinic_users WHERE username = ? AND status <> 'baja' ORDER BY id LIMIT 2", [username]);
  if (found.length === 1) return { id: found[0].id };
  return { error: found.length ? `Hay más de un usuario ${username}: elíjalo de la lista.` : `No hay un usuario "${username}" para supervisor.` };
}

// Valida y normaliza el formulario. Devuelve { data, errors }.
async function validate(body, id = null) {
  const errors = [];
  const approved = Number(body.approved);
  const data = {
    full_name: clean(body.full_name, 150).toUpperCase(),
    username: normUsername(body.username),
    status: STATUS[body.status] && body.status !== 'baja' ? body.status : 'activo',
    profile_id: intOrNull(body.profile_id),
    sede_id: intOrNull(body.sede_id),
    area_item_id: intOrNull(body.area_item_id),
    supervisor_id: null,
    approved: APPROVAL[approved] ? approved : 0,
    dni: clean(body.dni, 12) || null,
    email: clean(body.email, 150).toLowerCase() || null,
    phone: clean(body.phone, 30) || null,
    employee_id: null,
    notes: clean(body.notes, 2000) || null,
  };
  if (!data.full_name) errors.push('El nombre es obligatorio.');
  if (!USERNAME.test(data.username)) errors.push('Usuario: hasta 60 caracteres (letras, incluida la Ñ, números, punto, guion, @ o espacios internos).');
  if (!data.profile_id) errors.push('El perfil es obligatorio.');
  if (!data.sede_id) errors.push('La sede es obligatoria.');
  if (data.email && !EMAIL.test(data.email)) errors.push('El correo no es válido.');
  const [[dup]] = await pool.query("SELECT id FROM clinic_users WHERE username = ? AND status <> 'baja' AND id <> ? LIMIT 1", [data.username, id || 0]);
  if (dup) errors.push(`Ya existe el usuario ${data.username} en el inventario (activo o inactivo).`);
  const sup = await resolveSupervisor(body.supervisor);
  if (sup.error) errors.push(sup.error);
  data.supervisor_id = sup.id || null;
  if (data.supervisor_id && id && data.supervisor_id === Number(id)) errors.push('Un usuario no puede ser su propio supervisor.');
  if (data.dni) {
    if (!/^\d{8}$/.test(data.dni)) errors.push('El DNI debe tener 8 dígitos.');
    else {
      const [[e]] = await pool.query('SELECT id FROM employees WHERE dni = ?', [data.dni]);
      if (e) data.employee_id = e.id;
    }
  }
  const [[refs]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM clinic_profiles WHERE id = ?) AS p, (SELECT COUNT(*) FROM clinic_sedes WHERE id = ?) AS s,
            (SELECT COUNT(*) FROM catalog_items WHERE id = ? AND catalog_type = 'area') AS a`,
    [data.profile_id || 0, data.sede_id || 0, data.area_item_id || 0]
  );
  if (data.profile_id && !refs.p) errors.push('El perfil elegido no existe.');
  if (data.sede_id && !refs.s) errors.push('La sede elegida no existe.');
  if (data.area_item_id && !refs.a) errors.push('El área elegida no existe.');
  return { data, errors };
}

async function create(data, user, requestId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query('INSERT INTO clinic_users SET ?', [{ ...data, request_id: requestId || null, created_by: user.id }]);
    await addEvent(conn, { userId: r.insertId, type: 'alta', detail: 'Registrado en el inventario', requestId, by: user.id });
    await conn.commit();
    return r.insertId;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

const FIELD_LABELS = {
  full_name: 'Nombre', username: 'Usuario', status: 'Estado', profile_id: 'Perfil', sede_id: 'Sede', area_item_id: 'Área',
  supervisor_id: 'Supervisor', approved: 'Aprobado', dni: 'DNI', email: 'Correo', phone: 'Celular',
};

// Texto legible de un valor (nombres en vez de ids) para el historial.
async function labelsFor(conn, field, values) {
  const ids = values.filter(Boolean);
  if (!ids.length) return {};
  const q = {
    profile_id: 'SELECT id, name AS v FROM clinic_profiles WHERE id IN (?)',
    sede_id: 'SELECT id, name AS v FROM clinic_sedes WHERE id IN (?)',
    area_item_id: 'SELECT id, value AS v FROM catalog_items WHERE id IN (?)',
    supervisor_id: 'SELECT id, username AS v FROM clinic_users WHERE id IN (?)',
  }[field];
  if (!q) return {};
  const [rows] = await conn.query(q, [ids]);
  return Object.fromEntries(rows.map((r) => [r.id, r.v]));
}

async function describeChanges(conn, before, after) {
  const out = [];
  for (const k of Object.keys(FIELD_LABELS)) {
    if (!(k in after)) continue;
    const a = before[k] === undefined ? null : before[k];
    const b = after[k];
    if (String(a ?? '') === String(b ?? '')) continue;
    const names = await labelsFor(conn, k, [a, b]);
    const show = (v) => {
      if (v === null || v === '') return '—';
      if (k === 'status') return (STATUS[v] || {}).label || v;
      if (k === 'approved') return (APPROVAL[v] || {}).label || v;
      return names[v] || v;
    };
    out.push(`${FIELD_LABELS[k]}: ${show(a)} → ${show(b)}`);
  }
  return out;
}

async function update(id, data, before, user) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const fields = { ...data };
    if (before.status === 'baja') delete fields.status;
    const changes = await describeChanges(conn, before, fields);
    await conn.query('UPDATE clinic_users SET ? WHERE id = ?', [fields, id]);
    if (changes.length) await addEvent(conn, { userId: id, type: 'edicion', detail: changes.join('; '), by: user.id });
    await conn.commit();
    return changes;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function setBaja(id, { date, reason, requestId }, user) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE clinic_users SET status = 'baja' WHERE id = ?", [id]);
    await addEvent(conn, { userId: id, type: 'baja', date, reason, detail: 'Baja registrada', requestId, by: user.id });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function reactivate(id, { requestId }, user) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE clinic_users SET status = 'activo' WHERE id = ?", [id]);
    await addEvent(conn, { userId: id, type: 'reactivacion', detail: 'Reactivado', requestId, by: user.id });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function imports(limit = 50) {
  const [rows] = await pool.query(
    `SELECT i.id, i.file_name, i.rows_total, i.created_count, i.updated_count, i.unchanged_count, i.error_count, i.created_at,
            u.full_name AS created_by_name
     FROM clinic_imports i LEFT JOIN users u ON u.id = i.created_by ORDER BY i.id DESC LIMIT ?`, [limit]
  );
  return rows;
}

async function getImport(id) {
  const [[row]] = await pool.query(
    'SELECT i.*, u.full_name AS created_by_name FROM clinic_imports i LEFT JOIN users u ON u.id = i.created_by WHERE i.id = ?', [id]
  );
  if (!row) return null;
  let summary = {};
  try { summary = JSON.parse(row.summary_json || '{}'); } catch (_) { summary = {}; }
  return { ...row, summary };
}

module.exports = {
  STATUS, APPROVAL, EVENTS, ALERTS, SORTS, IDLE_DAYS, PURGE_DAYS, BUCKETS, PER_PAGE, USERNAME, EMAIL,
  clean, fold, normUsername, intOrNull,
  areas, generalSedes, profiles, sedes, saveCatalog,
  filtersOf, list, counts, bySede, connectionDashboard, get, events, addEvent, supervisorOptions, validate, create, update, setBaja, reactivate,
  describeChanges, imports, getImport,
};
