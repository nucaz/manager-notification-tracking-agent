// Importa el listado que exporta Clinic (Usuarios_roles_sedes_permisos.xls):
// hojas USUARIOS, SEDES, PERFILES (y ESTADO, que no hace falta). Tambien
// acepta una sola hoja con encabezados de texto (NOMBRE, USUARIO, PERFIL,
// SEDE...). Primero alimenta perfiles y sedes de Clinic (por su Id) y el
// catalogo general de sedes; despues crea o actualiza los usuarios por su
// IdUsuario y deja en el historial lo que cambio. Todo en una transaccion:
// si algo falla no queda nada a medias.
//
// Lo que dice Clinic manda (nombre, estado, perfil, sede, contacto), salvo
// una baja registrada aqui: si Clinic lo sigue mostrando ACTIVO se avisa.
//
// Revision previa: dryRun corre la importacion completa dentro de la
// transaccion y al final la deshace (ROLLBACK). Lo que se muestra antes de
// confirmar es exactamente lo que va a pasar.
//
// Empleados (opcion employees):
// - 'ninguno': no toca el vinculo con el directorio de empleados.
// - 'vincular': enlaza por DNI con los empleados que ya existen.
// - 'crear': ademas crea en Empleados a los usuarios ACTIVOS con DNI valido
//   que no esten, marcados source = 'clinic' (no se confunden con planilla).
const XLSX = require('xlsx');
const pool = require('../db/pool');
const clinic = require('./clinicService');

const { clean, fold, normUsername, USERNAME, EMAIL } = clinic;
const key = (h) => fold(h).replace(/[^a-z0-9]/g, '');

// Encabezado del archivo -> campo. Primero los nombres de Clinic.
const USER_FIELDS = {
  clinic_id: ['idusuario', 'id'],
  full_name: ['nombre', 'nombres', 'nombrecompleto'],
  username: ['usuario', 'user', 'login'],
  status: ['idestado', 'estado'],
  profile: ['idperfil', 'perfil'],
  sede: ['idsede', 'sede'],
  area: ['area'],
  last_login: ['ultimaconexion', 'ultimoacceso'],
  registered_by: ['usuarioregistra', 'registradopor'],
  registered_at: ['fecharegistra', 'fecharegistro', 'fechaderegistro'],
  edited_by: ['usuarioedita', 'editadopor'],
  edited_at: ['fechaedita', 'fechaedicion'],
  email: ['correoelectronico', 'correo', 'email'],
  phone: ['numerocelular', 'celular', 'telefono'],
  dni: ['dni', 'documento'],
  supervisor: ['idsupervisor', 'supervisor', 'supervisorusuario'],
  approved: ['aprobado', 'aprobacion', 'usuarioaprobado', 'aprobadosino'],
};
const SEDE_FIELDS = { clinic_id: ['id', 'idsede'], name: ['nombre', 'sede'], status: ['estado'], address: ['direccion'], opens: ['horainicio'], closes: ['horafin'] };
const PROFILE_FIELDS = { clinic_id: ['id', 'idperfil'], name: ['perfil', 'nombre'] };

const IMPORT_COLUMNS = [
  { header: 'IdUsuario', required: false }, { header: 'Nombre', required: false }, { header: 'Usuario', required: true },
  { header: 'IdEstado o ESTADO (ACTIVO/INACTIVO)', required: false }, { header: 'IdPerfil o PERFIL', required: true },
  { header: 'IdSede o SEDE', required: true }, { header: 'UltimaConexion', required: false }, { header: 'UsuarioRegistra / FechaRegistra', required: false },
  { header: 'UsuarioEdita / FechaEdita', required: false }, { header: 'CorreoElectronico, NumeroCelular, DNI', required: false },
  { header: 'IdSupervisor (o usuario del supervisor)', required: false }, { header: 'Aprobado (0, 1, 3 o Sí/No)', required: false },
];

// --------------------------------- lectura ---------------------------------
function readWorkbook(buffer, fileName) {
  const isCsv = /\.csv$/i.test(fileName || '');
  const wb = isCsv ? XLSX.read(buffer.toString('utf8'), { type: 'string', raw: true }) : XLSX.read(buffer, { type: 'buffer' });
  const sheet = (names) => {
    const n = wb.SheetNames.find((s) => names.includes(key(s)));
    return n ? XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: '', raw: true }) : null;
  };
  const users = sheet(['usuarios', 'usuario']) || XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: true });
  return { users, sedes: sheet(['sedes', 'sede']), profiles: sheet(['perfiles', 'perfil', 'roles']) };
}

function picker(rows, fields) {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const map = {};
  for (const [field, names] of Object.entries(fields)) {
    for (const n of names) {
      const h = headers.find((x) => key(x) === n);
      if (h !== undefined) { map[field] = h; break; }
    }
  }
  return (row, field) => {
    if (!map[field]) return '';
    const v = row[map[field]];
    if (v === null || v === undefined) return '';
    if (typeof v === 'string' && /^(null|n\/a)$/i.test(v.trim())) return '';
    return v;
  };
}

const pad = (n) => String(n).padStart(2, '0');
// Fecha de Excel (numero de serie), Date o texto DD/MM/AAAA [HH:MM[:SS]] o AAAA-MM-DD.
function toDateTime(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d || d.y < 1990 || d.y > 2100) return null;
    return `${d.y}-${pad(d.m)}-${pad(d.d)} ${pad(d.H)}:${pad(d.M)}:${pad(Math.floor(d.S))}`;
  }
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
  const s = clean(v);
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, d, mo, y, h = '0', mi = '0', se = '0'] = m;
    return `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${mi}:${pad(se)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return (s.length === 10 ? `${s} 00:00:00` : s.slice(0, 19).replace('T', ' '));
  return null;
}

// Hora de Excel (fraccion del dia: 0.375 = 09:00) o texto HH:MM.
function toTime(v) {
  if (typeof v === 'number' && v >= 0 && v < 1) {
    const mins = Math.round(v * 24 * 60);
    return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}:00`;
  }
  const m = clean(v).match(/^(\d{1,2}):(\d{2})/);
  return m ? `${pad(m[1])}:${m[2]}:00` : null;
}

const asInt = (v) => (typeof v === 'number' ? Math.trunc(v) : (/^\d+(\.0+)?$/.test(clean(v)) ? Number.parseInt(clean(v), 10) : null));

function toStatus(v) {
  const n = asInt(v);
  if (n === 1) return 'activo';
  if (n === 2) return 'inactivo';
  const f = fold(v);
  if (!f) return 'activo';
  return f.startsWith('inact') || f === 'baja' ? 'inactivo' : 'activo';
}

function toApproved(v) {
  const n = asInt(v);
  if ([0, 1, 3].includes(n)) return n;
  const f = fold(v);
  if (!f) return null;
  return ['si', 'yes', 'true', 'aprobado'].includes(f) ? 1 : 0;
}

// "DANIELA DEL VALLE ROMERO GONZALEZ" -> nombres "DANIELA DEL VALLE",
// apellidos "ROMERO GONZALEZ": los dos ultimos son los apellidos. Se puede
// corregir despues en Empleados.
function splitName(full) {
  const w = clean(full).split(/\s+/).filter(Boolean);
  if (w.length >= 3) return { first_name: w.slice(0, -2).join(' '), last_name: w.slice(-2).join(' ') };
  if (w.length === 2) return { first_name: w[0], last_name: w[1] };
  return { first_name: w[0] || '', last_name: '' };
}

const EMPLOYEE_MODES = {
  vincular: 'Solo vincular por DNI con los empleados que ya existen',
  crear: 'Vincular y crear en Empleados a los activos que falten',
  ninguno: 'No tocar Empleados',
};

function toDni(v) {
  if (typeof v === 'number') return String(Math.trunc(v)).padStart(8, '0');
  const s = clean(v).replace(/\s/g, '');
  return s ? s.slice(0, 12) : null;
}

// --------------------------------- importar ---------------------------------
async function importWorkbook(book, fileName, user, { dryRun = false, employees = 'vincular' } = {}) {
  const mode = EMPLOYEE_MODES[employees] ? employees : 'vincular';
  const errors = [];
  const notes = [];
  const stats = { created: 0, updated: 0, unchanged: 0, sedesNew: 0, sedesUpd: 0, profilesNew: 0, profilesUpd: 0,
    employeesLinked: 0, employeesCreated: 0, employeesMissing: 0 };
  // Detalle para la revision previa.
  const plan = { created: [], changed: [], employeesCreated: [], employeesMissing: [] };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [imp] = await conn.query('INSERT INTO clinic_imports (file_name, rows_total, created_by) VALUES (?, ?, ?)',
      [String(fileName || 'archivo').slice(0, 255), book.users.length, user.id]);
    const importId = imp.insertId;

    // ---- catalogo general de sedes (para enlazar la sede de Clinic)
    const [gen] = await conn.query("SELECT id, value FROM catalog_items WHERE catalog_type = 'sede'");
    const generalByName = new Map(gen.map((g) => [fold(g.value), g.id]));
    const generalSede = async (name) => {
      const k = fold(name);
      if (generalByName.has(k)) return generalByName.get(k);
      const [r] = await conn.query("INSERT INTO catalog_items (catalog_type, value, created_by) VALUES ('sede', ?, ?)", [clean(name, 150).toUpperCase(), user.id]);
      generalByName.set(k, r.insertId);
      notes.push(`Sede "${clean(name)}" agregada al catálogo general de sedes.`);
      return r.insertId;
    };

    // ---- perfiles y sedes de Clinic
    const loadCatalog = async (table) => {
      const [rows] = await conn.query(`SELECT * FROM ${table}`);
      return { byClinic: new Map(rows.filter((r) => r.clinic_id !== null).map((r) => [r.clinic_id, r])), byName: new Map(rows.map((r) => [fold(r.name), r])) };
    };
    const profiles = await loadCatalog('clinic_profiles');
    const sedes = await loadCatalog('clinic_sedes');

    const upsertCatalog = async (table, cat, { clinicId, name, extra }, counters) => {
      const existing = (clinicId !== null && cat.byClinic.get(clinicId)) || cat.byName.get(fold(name));
      const data = { name: clean(name, 100).toUpperCase(), ...extra };
      if (clinicId !== null) data.clinic_id = clinicId;
      if (existing) {
        const changed = Object.keys(data).some((k) => String(existing[k] ?? '') !== String(data[k] ?? ''));
        if (changed) {
          await conn.query(`UPDATE ${table} SET ? WHERE id = ?`, [data, existing.id]);
          counters.upd += 1;
          Object.assign(existing, data);
        }
        if (clinicId !== null) cat.byClinic.set(clinicId, existing);
        cat.byName.set(fold(data.name), existing);
        return existing;
      }
      const [r] = await conn.query(`INSERT INTO ${table} SET ?`, [data]);
      const row = { id: r.insertId, ...data };
      if (clinicId !== null) cat.byClinic.set(clinicId, row);
      cat.byName.set(fold(data.name), row);
      counters.new += 1;
      return row;
    };

    if (book.sedes && book.sedes.length) {
      const p = picker(book.sedes, SEDE_FIELDS);
      const c = { new: 0, upd: 0 };
      for (const row of book.sedes) {
        const name = clean(p(row, 'name'), 100);
        if (!name) continue;
        const extra = {
          address: clean(p(row, 'address'), 255) || null,
          opens_at: toTime(p(row, 'opens')),
          closes_at: toTime(p(row, 'closes')),
          active: toStatus(p(row, 'status')) === 'activo' ? 1 : 0,
          sede_item_id: await generalSede(name),
        };
        await upsertCatalog('clinic_sedes', sedes, { clinicId: asInt(p(row, 'clinic_id')), name, extra }, c);
      }
      stats.sedesNew = c.new;
      stats.sedesUpd = c.upd;
    }
    if (book.profiles && book.profiles.length) {
      const p = picker(book.profiles, PROFILE_FIELDS);
      const c = { new: 0, upd: 0 };
      for (const row of book.profiles) {
        const name = clean(p(row, 'name'), 100);
        if (name) await upsertCatalog('clinic_profiles', profiles, { clinicId: asInt(p(row, 'clinic_id')), name, extra: {} }, c);
      }
      stats.profilesNew = c.new;
      stats.profilesUpd = c.upd;
    }

    // Perfil o sede de una fila: por Id de Clinic o por nombre (se crea si falta).
    const resolveCatalog = async (raw, table, cat, label, line, counters) => {
      const id = asInt(raw);
      if (id !== null) {
        if (cat.byClinic.has(id)) return cat.byClinic.get(id).id;
        const row = await upsertCatalog(table, cat, { clinicId: id, name: `${label} ${id} (sin nombre)`, extra: {} }, counters);
        notes.push(`Fila ${line}: el ${label.toLowerCase()} Id ${id} no venía en la hoja de ${label.toLowerCase()}s; se creó "${row.name}" para completarlo.`);
        return row.id;
      }
      const name = clean(raw, 100);
      if (!name) return null;
      if (cat.byName.has(fold(name))) return cat.byName.get(fold(name)).id;
      const extra = table === 'clinic_sedes' ? { sede_item_id: await generalSede(name) } : {};
      const row = await upsertCatalog(table, cat, { clinicId: null, name, extra }, counters);
      notes.push(`${label} nuevo agregado: ${row.name}.`);
      return row.id;
    };
    const dummy = { new: 0, upd: 0 };

    // ---- areas (columna opcional ÁREA)
    const [areaRows] = await conn.query("SELECT id, value FROM catalog_items WHERE catalog_type = 'area'");
    const areaByName = new Map(areaRows.map((a) => [fold(a.value), a.id]));

    // ---- usuarios actuales y empleados
    const [current] = await conn.query(
      `SELECT c.*, o.last_login_at, o.registered_by, o.registered_at, o.edited_by, o.edited_at
       FROM clinic_users c LEFT JOIN clinic_user_origin o ON o.clinic_user_id = c.id`
    );
    const byClinicId = new Map(current.filter((c) => c.clinic_id !== null).map((c) => [c.clinic_id, c]));
    const byUsername = new Map();
    for (const c of current) {
      const k = fold(c.username);
      if (!byUsername.has(k)) byUsername.set(k, []);
      byUsername.get(k).push(c);
    }
    const [emps] = await conn.query('SELECT id, dni FROM employees');
    const employeeByDni = new Map(emps.map((e) => [e.dni, e.id]));

    const nameOf = (cat, id) => { for (const r of cat.byName.values()) if (r.id === id) return r; return null; };
    const rowsDone = [];

    const p = picker(book.users, USER_FIELDS);
    const seenClinicIds = new Set();
    const seenUsernames = new Map();
    const dniCount = new Map();
    const origins = [];
    const supervisorsTodo = [];
    const createdIds = new Set();
    let badEmails = 0;

    for (let i = 0; i < book.users.length; i += 1) {
      const row = book.users[i];
      const line = i + 2;
      const clinicId = asInt(p(row, 'clinic_id'));
      const username = normUsername(p(row, 'username'));
      if (!username && Object.values(row).every((v) => !clean(v) || /^null$/i.test(clean(v)))) continue;
      const where = clinicId !== null ? ` (IdUsuario ${clinicId})` : '';
      if (!username) { errors.push({ row: line, message: `Sin usuario en Clinic${where}: corríjalo en Clinic.` }); continue; }
      if (!USERNAME.test(username)) { errors.push({ row: line, message: `Usuario no válido${where}: "${username}".` }); continue; }
      if (clinicId !== null) {
        if (seenClinicIds.has(clinicId)) { errors.push({ row: line, message: `IdUsuario ${clinicId} repetido en el archivo.` }); continue; }
        seenClinicIds.add(clinicId);
      }
      const uk = fold(username);
      seenUsernames.set(uk, (seenUsernames.get(uk) || []).concat(line));

      const status = toStatus(p(row, 'status'));
      const profileId = await resolveCatalog(p(row, 'profile'), 'clinic_profiles', profiles, 'Perfil', line, dummy);
      const sedeId = await resolveCatalog(p(row, 'sede'), 'clinic_sedes', sedes, 'Sede', line, dummy);
      const areaRaw = clean(p(row, 'area'), 100);
      let areaId;
      if (areaRaw) {
        areaId = areaByName.get(fold(areaRaw));
        if (!areaId) notes.push(`Fila ${line}: el área "${areaRaw}" no está en el catálogo de áreas (no se asignó).`);
      }
      const name = clean(p(row, 'full_name'), 150).toUpperCase();
      const dni = toDni(p(row, 'dni'));
      if (dni) dniCount.set(dni, (dniCount.get(dni) || 0) + 1);
      let email = clean(p(row, 'email'), 150).toLowerCase() || null;
      if (email && !EMAIL.test(email)) { badEmails += 1; email = null; }
      const phone = clean(p(row, 'phone'), 30) || null;
      const approved = toApproved(p(row, 'approved'));

      // Mismo IdUsuario; si no, el registrado aqui (sin Id) con el mismo usuario.
      let existing = clinicId !== null ? byClinicId.get(clinicId) : null;
      if (!existing) {
        const cands = (byUsername.get(uk) || []).filter((c) => (clinicId !== null ? c.clinic_id === null : true));
        existing = cands.find((c) => c.status !== 'baja') || cands[0] || null;
      }

      const next = { username, status, profile_id: profileId, sede_id: sedeId };
      if (clinicId !== null) next.clinic_id = clinicId;
      if (name) next.full_name = name;
      if (areaId) next.area_item_id = areaId;
      if (approved !== null) next.approved = approved;
      if (dni) next.dni = dni;
      if (email) next.email = email;
      if (phone) next.phone = phone;
      const employeeId = mode !== 'ninguno' && dni && /^\d{8}$/.test(dni) ? employeeByDni.get(dni) : undefined;
      if (employeeId) next.employee_id = employeeId;
      if (employeeId && (!existing || String(existing.employee_id ?? '') !== String(employeeId))) stats.employeesLinked += 1;

      let userId;
      if (existing) {
        userId = existing.id;
        if (existing.status === 'baja') {
          if (status === 'activo') notes.push(`Fila ${line}: ${username} está DE BAJA aquí pero Clinic lo muestra ACTIVO: desactívelo en Clinic.`);
          delete next.status;
        }
        const changes = await clinic.describeChanges(conn, existing, next);
        const linkOnly = Object.keys(next).some((k) => ['clinic_id', 'employee_id'].includes(k) && String(existing[k] ?? '') !== String(next[k] ?? ''));
        if (changes.length || linkOnly) {
          await conn.query('UPDATE clinic_users SET ? WHERE id = ?', [next, userId]);
          if (changes.length) {
            await clinic.addEvent(conn, { userId, type: 'importacion', detail: changes.join('; '), importId, by: user.id });
            stats.updated += 1;
            plan.changed.push({ line, id: userId, username, full_name: existing.full_name, changes });
          } else stats.unchanged += 1;
        } else stats.unchanged += 1;
        Object.assign(existing, next);
      } else {
        if (!name) notes.push(`Fila ${line}: ${username} no trae nombre en Clinic (se registró con el usuario como nombre).`);
        const data = { full_name: name || username.toUpperCase(), approved: approved === null ? 1 : approved, created_by: user.id, ...next };
        const [r] = await conn.query('INSERT INTO clinic_users SET ?', [data]);
        userId = r.insertId;
        const by = clean(p(row, 'registered_by'), 150);
        await clinic.addEvent(conn, { userId, type: 'importacion', importId, by: user.id,
          detail: `Registrado desde el listado de Clinic${by ? ` (creado en Clinic por ${by})` : ''}` });
        createdIds.add(userId);
        const created = { id: userId, ...data };
        if (clinicId !== null) byClinicId.set(clinicId, created);
        byUsername.set(uk, (byUsername.get(uk) || []).concat(created));
        stats.created += 1;
        plan.created.push({ line, clinic_id: clinicId, username, full_name: data.full_name, status: data.status,
          profile: (nameOf(profiles, profileId) || {}).name || '', sede: (nameOf(sedes, sedeId) || {}).name || '', dni: dni || '' });
      }
      rowsDone.push({ userId, username, name: name || username.toUpperCase(), dni, profileId, sedeId, areaId,
        status: existing && existing.status === 'baja' ? 'baja' : status });
      origins.push([userId, toDateTime(p(row, 'last_login')), clean(p(row, 'registered_by'), 150) || null, toDateTime(p(row, 'registered_at')),
        clean(p(row, 'edited_by'), 150) || null, toDateTime(p(row, 'edited_at')), importId]);
      const sup = p(row, 'supervisor');
      if (clean(sup)) supervisorsTodo.push({ userId, sup, line, username });
    }

    // Lo que dice Clinic (ultima conexion, quien lo creo/edito), en bloques.
    for (let i = 0; i < origins.length; i += 500) {
      await conn.query(
        `INSERT INTO clinic_user_origin (clinic_user_id, last_login_at, registered_by, registered_at, edited_by, edited_at, import_id) VALUES ?
         ON DUPLICATE KEY UPDATE last_login_at = COALESCE(VALUES(last_login_at), last_login_at),
           registered_by = COALESCE(VALUES(registered_by), registered_by), registered_at = COALESCE(VALUES(registered_at), registered_at),
           edited_by = COALESCE(VALUES(edited_by), edited_by), edited_at = COALESCE(VALUES(edited_at), edited_at),
           import_id = VALUES(import_id), imported_at = NOW()`,
        [origins.slice(i, i + 500)]
      );
    }
    await conn.query('UPDATE clinic_user_origin SET imported_at = NOW() WHERE import_id = ? AND imported_at IS NULL', [importId]);

    // Supervisores al final: pueden venir en filas posteriores.
    for (const s of supervisorsTodo) {
      const sid = asInt(s.sup);
      let boss = null;
      if (sid !== null) boss = byClinicId.get(sid) || null;
      else {
        const cands = byUsername.get(fold(normUsername(s.sup))) || [];
        boss = cands.find((c) => c.status !== 'baja') || cands[0] || null;
      }
      if (!boss) { notes.push(`Fila ${s.line}: el supervisor "${clean(s.sup)}" no está en el inventario.`); continue; }
      if (boss.id === s.userId) continue;
      const [[curr]] = await conn.query('SELECT supervisor_id FROM clinic_users WHERE id = ?', [s.userId]);
      if (curr.supervisor_id !== boss.id) {
        await conn.query('UPDATE clinic_users SET supervisor_id = ? WHERE id = ?', [boss.id, s.userId]);
        // Un usuario recien creado ya tiene su evento de alta: no hace falta otro.
        if (!createdIds.has(s.userId)) {
          const changes = await clinic.describeChanges(conn, curr, { supervisor_id: boss.id });
          await clinic.addEvent(conn, { userId: s.userId, type: 'importacion', detail: changes.join('; '), importId, by: user.id });
        }
      }
    }

    // ---- empleados: activos con DNI valido que no estan en el directorio
    if (mode !== 'ninguno') {
      const missing = new Map();
      for (const r of rowsDone) {
        if (r.status !== 'activo' || !r.dni || !/^\d{8}$/.test(r.dni) || employeeByDni.has(r.dni) || missing.has(r.dni)) continue;
        missing.set(r.dni, r);
      }
      stats.employeesMissing = missing.size;
      if (mode === 'crear' && missing.size) {
        const areaById = new Map(areaRows.map((a) => [a.id, a.value]));
        const [genNow] = await conn.query("SELECT id, value FROM catalog_items WHERE catalog_type = 'sede'");
        const generalById = new Map(genNow.map((g) => [g.id, g.value]));
        for (const r of missing.values()) {
          const prof = nameOf(profiles, r.profileId) || {};
          const sede = nameOf(sedes, r.sedeId) || {};
          const emp = {
            dni: r.dni, ...splitName(r.name), source: 'clinic', created_by: user.id,
            area: areaById.get(r.areaId || prof.area_item_id) || null,
            sede: generalById.get(sede.sede_item_id) || sede.name || null,
            cargo: prof.name || null,
            notes: `Creado desde el listado de Clinic (usuario ${r.username}). Verificar contra planilla.`,
          };
          const [ins] = await conn.query('INSERT INTO employees SET ?', [emp]);
          employeeByDni.set(r.dni, ins.insertId);
          await conn.query('UPDATE clinic_users SET employee_id = ? WHERE dni = ? AND employee_id IS NULL', [ins.insertId, r.dni]);
          plan.employeesCreated.push({ dni: r.dni, first_name: emp.first_name, last_name: emp.last_name, username: r.username, area: emp.area, sede: emp.sede });
        }
        stats.employeesCreated = missing.size;
      } else {
        plan.employeesMissing = [...missing.values()].map((r) => ({ dni: r.dni, name: r.name, username: r.username }));
      }
    }

    // ---- avisos de calidad de datos
    const dupUsers = [...seenUsernames.entries()].filter(([, lines]) => lines.length > 1);
    if (dupUsers.length) {
      notes.push(`Usuario repetido en Clinic (distintos IdUsuario, mismo usuario salvo espacios o mayúsculas): ${dupUsers.slice(0, 10)
        .map(([u, lines]) => `${u.toUpperCase()} (filas ${lines.join(', ')})`).join('; ')}.`);
    }
    const dupDni = [...dniCount.entries()].filter(([, n]) => n > 1);
    if (dupDni.length) notes.push(`${dupDni.length} DNI aparecen en más de un usuario (use el filtro "DNI repetido" para revisarlos).`);
    if (badEmails) notes.push(`${badEmails} correo(s) con formato no válido no se guardaron.`);
    if (seenClinicIds.size > 1) {
      const missing = current.filter((c) => c.clinic_id !== null && c.status !== 'baja' && !seenClinicIds.has(c.clinic_id));
      if (missing.length) {
        notes.push(`${missing.length} usuario(s) del inventario no vienen en este archivo (¿eliminados en Clinic?): `
          + `${missing.slice(0, 15).map((m) => m.username).join(', ')}${missing.length > 15 ? '…' : ''}.`);
      }
    }
    const cat = [];
    if (stats.sedesNew || stats.sedesUpd) cat.push(`sedes: ${stats.sedesNew} nueva(s), ${stats.sedesUpd} actualizada(s)`);
    if (stats.profilesNew || stats.profilesUpd) cat.push(`perfiles: ${stats.profilesNew} nuevo(s), ${stats.profilesUpd} actualizado(s)`);
    if (cat.length) notes.unshift(`Catálogo de Clinic: ${cat.join('; ')}.`);

    await conn.query(
      'UPDATE clinic_imports SET created_count = ?, updated_count = ?, unchanged_count = ?, error_count = ?, summary_json = ? WHERE id = ?',
      [stats.created, stats.updated, stats.unchanged, errors.length, JSON.stringify({ errors, notes, stats, employees: mode }), importId]
    );
    if (dryRun) await conn.rollback();
    else await conn.commit();
    return { importId: dryRun ? null : importId, dryRun, employees: mode, imported: stats.created + stats.updated + stats.unchanged,
      ...stats, errors, notes, plan };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { IMPORT_COLUMNS, EMPLOYEE_MODES, readWorkbook, importWorkbook, splitName, toDateTime, toTime };
