// Cuentas de Microsoft 365: inventario (m365_accounts), constancia de cada
// cambio (m365_account_events) y solicitudes con pasos (requestService).
//
// La aplicacion NO escribe en el tenant: los cambios se hacen en el centro
// de administracion de Microsoft 365 / Exchange / Purview y aqui se marca
// cada paso con su evidencia. Microsoft Graph se usa solo para LEER
// (usuarios, si estan habilitados y sus licencias; licencias compradas y
// usadas) y mostrar diferencias con lo registrado. Permisos de aplicacion
// necesarios: User.Read.All y Organization.Read.All (solo lectura).
const axios = require('axios');
const pool = require('../db/pool');
const settingsService = require('./settingsService');
const requestService = require('./requestService');

const LOGIN_BASE = process.env.MS_LOGIN_BASE_URL || 'https://login.microsoftonline.com';
const GRAPH_BASE = process.env.GRAPH_BASE_URL || 'https://graph.microsoft.com';

const STATUS = {
  activa: { label: 'Activa', badge: 'text-bg-success' },
  bloqueada: { label: 'Bloqueada', badge: 'text-bg-warning' },
  desactivada: { label: 'Desactivada (retiro)', badge: 'text-bg-secondary' },
  eliminada: { label: 'Eliminada', badge: 'text-bg-dark' },
};
const ACCOUNT_TYPES = { usuario: 'Usuario', compartido: 'Buzón compartido', recurso: 'Recurso (sala, equipo)', servicio: 'Cuenta de servicio' };
const EVENT_LABELS = {
  alta: 'Alta', licencia: 'Licencias', bloqueo: 'Bloqueo', desbloqueo: 'Desbloqueo', renombre: 'Renombre del correo',
  reasignacion: 'Reasignación del buzón', buzon_compartido: 'Convertido a buzón compartido', pst: 'Respaldo PST',
  baja: 'Baja (retiro)', eliminacion: 'Eliminación', edicion: 'Edición', importada: 'Detectada en el tenant',
};
// Cargos de jefatura: al retirarse se respalda el buzon (PST) y se
// convierte en compartido para no perder la informacion.
const MANAGER_RE = /\b(gerente|gerencia|jefe|jefa|jefatura|director|directora|subgerente|coordinador general)\b/i;

const REQUEST_TYPES = {
  alta: 'Alta de cuenta',
  licencia: 'Cambio de licencias',
  bloqueo: 'Bloqueo temporal',
  desbloqueo: 'Desbloqueo',
  renombre: 'Renombrar correo',
  baja: 'Baja por retiro',
  eliminacion: 'Eliminar cuenta',
};

// Pasos por tipo. evidence_label: lo que se escribe al marcarlo hecho
// (queda como constancia). manager: solo para cargos de jefatura;
// required: false = opcional.
function tasksFor(type, isManager) {
  const T = (key, label, evidence_label = null, required = true) => ({ key, label, evidence_label, required });
  switch (type) {
    case 'alta':
      return [
        T('crear_usuario', 'Crear el usuario en el centro de administración de Microsoft 365', 'Correo creado'),
        T('asignar_licencias', 'Asignar las licencias solicitadas', 'Licencias asignadas'),
        T('grupos', 'Agregar a los grupos y listas de su área', null, false),
        T('mfa', 'Entregar credenciales y activar la verificación en dos pasos (MFA)'),
      ];
    case 'licencia':
      return [T('cambiar_licencias', 'Asignar o quitar las licencias en el centro de administración', 'Licencias que quedan (o "ninguna")')];
    case 'bloqueo':
      return [T('bloquear', 'Bloquear el inicio de sesión y cerrar las sesiones activas')];
    case 'desbloqueo':
      return [T('desbloquear', 'Permitir el inicio de sesión'), T('clave', 'Restablecer la contraseña y entregarla', null, false)];
    case 'renombre':
      return [
        T('renombrar', 'Cambiar el nombre de usuario / correo principal', 'Correo nuevo'),
        T('alias', 'Mantener el correo anterior como alias (para no perder correos)', null, false),
      ];
    case 'baja': {
      const tasks = [
        T('bloquear', 'Bloquear el inicio de sesión y cerrar las sesiones activas'),
        T('clave', 'Restablecer la contraseña'),
      ];
      if (isManager) {
        tasks.push(T('pst', 'Respaldar el buzón en PST (Purview > eDiscovery > Exportar)', 'Ubicación del archivo PST'));
        tasks.push(T('compartido', 'Convertir en buzón compartido (Exchange > Buzones > Convertir)'));
      }
      tasks.push(T('reasignar', 'Dar acceso al buzón o reenviar el correo a quien lo recibe', 'Persona que recibe el buzón', isManager));
      tasks.push(T('renombrar', 'Renombrar el correo (ej. baja.nombre@dominio)', 'Correo nuevo'));
      tasks.push(T('quitar_licencias', 'Quitar las licencias (un buzón compartido de hasta 50 GB no la necesita)', 'Licencias que quedan (o "ninguna")', false));
      tasks.push(T('onedrive', 'Dar acceso a su OneDrive al jefe (se borra 30 días después de eliminar la cuenta)', 'Persona con acceso', false));
      return tasks;
    }
    case 'eliminacion': {
      const tasks = [];
      if (isManager) tasks.push(T('confirmar_pst', 'Confirmar que el PST y el buzón compartido existen antes de eliminar', 'Ubicación del PST'));
      tasks.push(T('eliminar', 'Eliminar el usuario en el centro de administración (se puede recuperar durante 30 días)'));
      return tasks;
    }
    default:
      return [];
  }
}

const clean = (v, max = 255) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);
const UPN = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
// "ninguna" (o vacio) = sin licencias.
const noLicenses = (v) => (/^\s*(ninguna|ninguno|sin licencias?|-)?\s*$/i.test(String(v || '')) ? null : clean(v, 500));
const licenseSet = (v) => new Set(clean(v, 2000).split(',').map((x) => x.trim()).filter(Boolean));

async function event(accountId, type, { from = null, to = null, relatedEmployeeId = null, relatedName = null, requestId = null, user = null, notes = null } = {}, conn = pool) {
  await conn.query(
    `INSERT INTO m365_account_events (account_id, event_type, from_value, to_value, related_employee_id, related_name, request_id, user_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [accountId, type, from ? clean(from) : null, to ? clean(to) : null, relatedEmployeeId, relatedName ? clean(relatedName, 150) : null,
      requestId, user ? user.id : null, notes ? clean(notes, 500) : null]
  );
}

async function list({ q, status, area, diff } = {}) {
  let sql = 'SELECT a.* FROM m365_accounts a WHERE 1=1';
  const params = [];
  if (status && STATUS[status]) { sql += ' AND a.status = ?'; params.push(status); }
  if (area) { sql += ' AND a.area = ?'; params.push(area); }
  if (q) { sql += ' AND (a.upn LIKE ? OR a.display_name LIKE ? OR a.cargo LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += " ORDER BY a.status = 'eliminada', a.display_name";
  const [rows] = await pool.query(sql, params);
  const lastSync = await settingsService.get('m365_last_sync');
  const out = rows.map((a) => ({ ...a, diffs: differences(a, lastSync) }));
  return diff ? out.filter((a) => a.diffs.length) : out;
}

// Diferencias entre lo registrado y lo que dijo el tenant en la ultima lectura.
function differences(a, lastSync) {
  if (!lastSync) return [];
  const seen = a.tenant_seen_at && String(a.tenant_seen_at) >= String(lastSync);
  if (!seen) return a.status === 'eliminada' ? [] : ['No aparece en el tenant'];
  const d = [];
  if (a.status === 'eliminada') d.push('Registrada como eliminada pero sigue en el tenant');
  if (a.status === 'activa' && a.tenant_enabled === 0) d.push('Activa aquí, bloqueada en el tenant');
  if (['bloqueada', 'desactivada'].includes(a.status) && a.tenant_enabled === 1) d.push(`${STATUS[a.status].label} aquí, puede iniciar sesión en el tenant`);
  const mine = [...licenseSet(a.licenses)].sort().join(', ');
  const theirs = [...licenseSet(a.tenant_licenses)].sort().join(', ');
  if (mine !== theirs) d.push(`Licencias: aquí "${mine || 'ninguna'}", en el tenant "${theirs || 'ninguna'}"`);
  return d;
}

async function get(id) {
  const [[a]] = await pool.query(
    'SELECT a.*, e.dni AS employee_dni FROM m365_accounts a LEFT JOIN employees e ON e.id = a.employee_id WHERE a.id = ?', [id]
  );
  if (!a) return null;
  const [events] = await pool.query(
    `SELECT ev.*, u.full_name AS user_name FROM m365_account_events ev LEFT JOIN users u ON u.id = ev.user_id
     WHERE ev.account_id = ? ORDER BY ev.created_at DESC, ev.id DESC`, [id]
  );
  a.events = events;
  a.diffs = differences(a, await settingsService.get('m365_last_sync'));
  return a;
}

// ------------------------------ solicitudes ------------------------------
// Crea una solicitud de M365 (pendiente de aprobar) con sus pasos.
async function createRequest(body, user) {
  const type = clean(body.request_type, 30);
  if (!REQUEST_TYPES[type]) throw new Error('Tipo de solicitud no válido.');
  const requester = await requestService.parseRequester(body);
  if (!requester) throw new Error('Indique quién solicita (jefe o gerente).');
  const details = {};
  let account = null;
  if (type === 'alta') {
    details.nombre = clean(body.target_name, 150);
    details.dni = clean(body.target_dni, 8);
    details.cargo = clean(body.target_cargo, 150);
    details.area = clean(body.target_area, 100);
    details.sede = clean(body.target_sede, 100);
    details.correo = clean(body.target_upn, 255).toLowerCase();
    details.licencias = [].concat(body.target_licenses || []).map((x) => clean(x, 100)).filter(Boolean).join(', ');
    if (!details.nombre || !details.cargo || !details.area) throw new Error('Para un alta indique nombre, cargo y área.');
    if (details.dni && !/^\d{8}$/.test(details.dni)) throw new Error('El DNI debe tener 8 dígitos.');
    if (details.correo && !UPN.test(details.correo)) throw new Error('El correo propuesto no es válido.');
    if (details.correo) {
      const [[dup]] = await pool.query('SELECT id FROM m365_accounts WHERE upn = ?', [details.correo]);
      if (dup) throw new Error(`Ya existe la cuenta ${details.correo}.`);
    }
  } else {
    account = await get(Number(body.account_id));
    if (!account) throw new Error('Elija la cuenta a la que se refiere la solicitud.');
    if (account.status === 'eliminada') throw new Error('La cuenta ya está eliminada.');
    const [[open]] = await pool.query(
      "SELECT id FROM service_requests WHERE module = 'm365' AND entity_id = ? AND status IN ('pendiente', 'aprobada', 'en_proceso')", [account.id]
    );
    if (open) throw new Error(`La cuenta ya tiene una solicitud abierta (#${open.id}): ciérrela primero.`);
    if (type === 'licencia') details.licencias = [].concat(body.target_licenses || []).map((x) => clean(x, 100)).filter(Boolean).join(', ');
    if (type === 'renombre') {
      details.correo_nuevo = clean(body.target_upn, 255).toLowerCase();
      if (details.correo_nuevo && !UPN.test(details.correo_nuevo)) throw new Error('El correo nuevo no es válido.');
    }
    if (type === 'baja') {
      details.fecha_retiro = /^\d{4}-\d{2}-\d{2}$/.test(body.retiro_date || '') ? body.retiro_date : null;
      details.recibe = clean(body.receiver_name, 150);
    }
    details.correo = account.upn;
  }
  const isManager = type === 'alta' ? MANAGER_RE.test(details.cargo) || !!body.is_manager
    : !!account.is_manager || MANAGER_RE.test(account.cargo || '') || !!body.is_manager;
  details.jefatura = isManager;
  const id = await requestService.create({
    module: 'm365', type, entityId: account ? account.id : null, requester,
    beneficiary: type === 'alta' ? details.nombre : account.display_name, details, notes: clean(body.notes, 2000) || null,
    tasks: tasksFor(type, isManager),
  }, user);
  return { id, isManager, type, account, requester };
}

// Aplica una solicitud completada a la cuenta, con constancia de cada
// cambio (usa la evidencia de cada paso: correo creado, correo nuevo, a
// quien se reasigno el buzon, ubicacion del PST, licencias).
async function applyCompleted(requestId, user) {
  const r = await requestService.get(requestId);
  if (!r || r.module !== 'm365') throw new Error('Solicitud no encontrada.');
  if (!['aprobada', 'en_proceso'].includes(r.status)) throw new Error('La solicitud no está en curso.');
  const missing = requestService.pendingRequired(r);
  if (missing.length) throw new Error(`Faltan pasos obligatorios: ${missing.map((t) => t.label).join('; ')}.`);
  const ev = Object.fromEntries(r.tasks.filter((t) => t.done_at).map((t) => [t.task_key, t.evidence || '']));
  const done = new Set(r.tasks.filter((t) => t.done_at).map((t) => t.task_key));
  const d = r.details;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let accountId = r.entity_id;
    const opts = { requestId: r.id, user };
    if (r.request_type === 'alta') {
      const upn = clean(ev.crear_usuario || d.correo, 255).toLowerCase();
      if (!UPN.test(upn)) throw new Error('El paso "Crear el usuario" debe tener el correo creado.');
      const [[dup]] = await conn.query('SELECT id FROM m365_accounts WHERE upn = ?', [upn]);
      if (dup) throw new Error(`Ya existe la cuenta ${upn} en el inventario.`);
      let employeeId = null;
      if (d.dni) {
        const [[e]] = await conn.query('SELECT id FROM employees WHERE dni = ?', [d.dni]);
        employeeId = e ? e.id : null;
      }
      const [ins] = await conn.query(
        `INSERT INTO m365_accounts (upn, display_name, employee_id, cargo, area, sede, status, licenses, is_manager, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'activa', ?, ?, ?)`,
        [upn, d.nombre, employeeId, d.cargo || null, d.area || null, d.sede || null, clean(ev.asignar_licencias || d.licencias, 500) || null,
          d.jefatura ? 1 : 0, user.id]
      );
      accountId = ins.insertId;
      await event(accountId, 'alta', { ...opts, to: upn, relatedName: r.requested_by_name, notes: `Solicitado por ${r.requested_by_name}` }, conn);
      if (ev.asignar_licencias) await event(accountId, 'licencia', { ...opts, to: ev.asignar_licencias }, conn);
    } else {
      const [[a]] = await conn.query('SELECT * FROM m365_accounts WHERE id = ? FOR UPDATE', [accountId]);
      if (!a) throw new Error('La cuenta ya no existe.');
      const set = {};
      if (r.request_type === 'licencia') {
        set.licenses = noLicenses(ev.cambiar_licencias);
        await event(a.id, 'licencia', { ...opts, from: a.licenses || 'ninguna', to: set.licenses || 'ninguna' }, conn);
      } else if (r.request_type === 'bloqueo') {
        set.status = 'bloqueada';
        await event(a.id, 'bloqueo', { ...opts, from: STATUS[a.status].label, to: 'Bloqueada' }, conn);
      } else if (r.request_type === 'desbloqueo') {
        set.status = 'activa';
        await event(a.id, 'desbloqueo', { ...opts, from: STATUS[a.status].label, to: 'Activa' }, conn);
      } else if (r.request_type === 'renombre') {
        set.upn = clean(ev.renombrar, 255).toLowerCase();
        if (!UPN.test(set.upn)) throw new Error('El paso "Cambiar el nombre de usuario" debe tener el correo nuevo.');
        await event(a.id, 'renombre', { ...opts, from: a.upn, to: set.upn, notes: done.has('alias') ? 'Se mantuvo el correo anterior como alias' : null }, conn);
      } else if (r.request_type === 'baja') {
        set.status = 'desactivada';
        await event(a.id, 'bloqueo', { ...opts, from: STATUS[a.status].label, to: 'Bloqueada (retiro)' }, conn);
        if (done.has('pst')) await event(a.id, 'pst', { ...opts, to: ev.pst }, conn);
        if (done.has('compartido')) {
          set.account_type = 'compartido';
          await event(a.id, 'buzon_compartido', { ...opts, from: ACCOUNT_TYPES[a.account_type], to: 'Buzón compartido' }, conn);
        }
        if (done.has('reasignar') && ev.reasignar) {
          const related = await requestService.parseRequester({ x_name: ev.reasignar }, 'x_');
          await event(a.id, 'reasignacion', { ...opts, to: related.name, relatedEmployeeId: related.employee_id, relatedName: related.name,
            notes: 'Acceso al buzón / reenvío del correo' }, conn);
        }
        if (done.has('onedrive') && ev.onedrive) await event(a.id, 'reasignacion', { ...opts, to: ev.onedrive, relatedName: ev.onedrive, notes: 'Acceso a OneDrive' }, conn);
        if (done.has('renombrar')) {
          const upn = clean(ev.renombrar, 255).toLowerCase();
          if (!UPN.test(upn)) throw new Error('El paso "Renombrar el correo" debe tener el correo nuevo.');
          set.upn = upn;
          await event(a.id, 'renombre', { ...opts, from: a.upn, to: upn, notes: 'Renombrado por retiro' }, conn);
        }
        if (done.has('quitar_licencias')) {
          set.licenses = noLicenses(ev.quitar_licencias);
          await event(a.id, 'licencia', { ...opts, from: a.licenses || 'ninguna', to: set.licenses || 'ninguna' }, conn);
        }
        await event(a.id, 'baja', { ...opts, to: d.fecha_retiro || null, notes: `Solicitado por ${r.requested_by_name}` }, conn);
      } else if (r.request_type === 'eliminacion') {
        set.status = 'eliminada';
        await event(a.id, 'eliminacion', { ...opts, from: a.upn, notes: ev.confirmar_pst ? `PST: ${ev.confirmar_pst}` : null }, conn);
      }
      if (set.upn && set.upn !== a.upn) {
        const [[dup]] = await conn.query('SELECT id FROM m365_accounts WHERE upn = ? AND id <> ?', [set.upn, a.id]);
        if (dup) throw new Error(`Ya existe otra cuenta con el correo ${set.upn}.`);
      }
      if (Object.keys(set).length) await conn.query('UPDATE m365_accounts SET ? WHERE id = ?', [set, a.id]);
    }
    await requestService.markCompleted(r.id, accountId, conn);
    await conn.commit();
    return { accountId, request: r };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ------------------------- Microsoft Graph (lectura) -------------------------
// Nombres comerciales de las licencias mas comunes (el resto muestra el codigo).
const SKU_NAMES = {
  O365_BUSINESS_ESSENTIALS: 'Microsoft 365 Business Basic', O365_BUSINESS_PREMIUM: 'Microsoft 365 Business Standard',
  SPB: 'Microsoft 365 Business Premium', O365_BUSINESS: 'Microsoft 365 Apps for business', EXCHANGESTANDARD: 'Exchange Online (Plan 1)',
  EXCHANGEENTERPRISE: 'Exchange Online (Plan 2)', EXCHANGEDESKLESS: 'Exchange Online Kiosk', STANDARDPACK: 'Office 365 E1',
  ENTERPRISEPACK: 'Office 365 E3', SPE_E3: 'Microsoft 365 E3', SPE_E5: 'Microsoft 365 E5', SPE_F1: 'Microsoft 365 F3',
  DESKLESSPACK: 'Office 365 F3', FLOW_FREE: 'Power Automate Free', POWER_BI_STANDARD: 'Power BI (gratis)', POWER_BI_PRO: 'Power BI Pro',
  TEAMS_EXPLORATORY: 'Teams Exploratory', PROJECTPROFESSIONAL: 'Project Plan 3', VISIOCLIENT: 'Visio Plan 2',
};

async function config() {
  const s = await settingsService.getAll();
  return { tenant: clean(s.m365_tenant_id), clientId: clean(s.m365_client_id), secret: s.m365_client_secret || '', lastSync: s.m365_last_sync || null,
    lastResult: s.m365_last_sync_result || null };
}

async function token(cfg) {
  if (!cfg.tenant || !cfg.clientId || !cfg.secret) throw new Error('Falta configurar el tenant, el ID de aplicación y el secreto.');
  if (!/^[A-Za-z0-9.-]+$/.test(cfg.tenant)) throw new Error('Tenant no válido (dominio o GUID).');
  try {
    const r = await axios.post(`${LOGIN_BASE}/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`, new URLSearchParams({
      grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.secret, scope: 'https://graph.microsoft.com/.default',
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 });
    return r.data.access_token;
  } catch (err) {
    const desc = err.response && err.response.data && (err.response.data.error_description || '').split('\n')[0];
    throw new Error(`Microsoft rechazó la aplicación: ${desc || err.message}`);
  }
}

async function graphGetAll(tok, path) {
  const out = [];
  let url = `${GRAPH_BASE}${path}`;
  for (let page = 0; url && page < 100; page += 1) {
    let r;
    try {
      r = await axios.get(url, { headers: { Authorization: `Bearer ${tok}` }, timeout: 30000 });
    } catch (err) {
      const st = err.response && err.response.status;
      if (st === 403) throw new Error('Microsoft Graph negó el acceso: la aplicación necesita User.Read.All y Organization.Read.All (de aplicación) con consentimiento del administrador.');
      throw new Error(`Microsoft Graph respondió ${st || err.message}.`);
    }
    out.push(...(r.data.value || []));
    url = r.data['@odata.nextLink'] || null;
  }
  return out;
}

// Lee el tenant y actualiza lo que se ve aqui (tenant_*), sin tocar lo
// registrado. Las cuentas del tenant que no estaban se agregan marcadas
// como "detectadas" para completarlas (cargo, area, quien la pidio).
async function sync(user = null) {
  const cfg = await config();
  const tok = await token(cfg);
  const skus = await graphGetAll(tok, '/v1.0/subscribedSkus');
  const skuName = {};
  for (const s of skus) {
    const name = SKU_NAMES[s.skuPartNumber] || s.skuPartNumber;
    skuName[s.skuId] = name;
    await pool.query(
      `INSERT INTO m365_skus (sku_id, part_number, friendly_name, prepaid, consumed, synced_at) VALUES (?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE part_number = VALUES(part_number), friendly_name = VALUES(friendly_name), prepaid = VALUES(prepaid),
         consumed = VALUES(consumed), synced_at = NOW()`,
      [s.skuId, s.skuPartNumber, SKU_NAMES[s.skuPartNumber] || null, (s.prepaidUnits && s.prepaidUnits.enabled) || 0, s.consumedUnits || 0]
    );
  }
  const users = await graphGetAll(tok, '/v1.0/users?$select=id,displayName,userPrincipalName,accountEnabled,assignedLicenses,jobTitle,department,officeLocation,userType&$top=999');
  // Hora de la base (tenant_seen_at usa NOW()): lo no visto desde aqui no esta en el tenant.
  const [[{ started }]] = await pool.query("SELECT DATE_FORMAT(NOW() - INTERVAL 1 SECOND, '%Y-%m-%d %H:%i:%s') AS started");
  let matched = 0;
  let added = 0;
  for (const u of users) {
    if (u.userType && u.userType !== 'Member') continue; // invitados (#EXT#)
    const upn = clean(u.userPrincipalName, 255).toLowerCase();
    const lic = (u.assignedLicenses || []).map((l) => skuName[l.skuId] || l.skuId).sort().join(', ') || null;
    const [[a]] = await pool.query('SELECT id FROM m365_accounts WHERE entra_id = ? OR upn = ? ORDER BY entra_id = ? DESC LIMIT 1', [u.id, upn, u.id]);
    if (a) {
      await pool.query('UPDATE m365_accounts SET entra_id = ?, tenant_enabled = ?, tenant_licenses = ?, tenant_seen_at = NOW() WHERE id = ?',
        [u.id, u.accountEnabled ? 1 : 0, lic, a.id]);
      matched += 1;
    } else {
      const [ins] = await pool.query(
        `INSERT INTO m365_accounts (upn, display_name, cargo, area, sede, status, licenses, is_manager, entra_id, tenant_enabled, tenant_licenses, tenant_seen_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
        [upn, clean(u.displayName, 150) || upn, clean(u.jobTitle, 150) || null, clean(u.department, 100) || null, clean(u.officeLocation, 100) || null,
          u.accountEnabled ? 'activa' : 'bloqueada', lic, MANAGER_RE.test(u.jobTitle || '') ? 1 : 0, u.id, u.accountEnabled ? 1 : 0, lic,
          'Detectada en el tenant: complete quién la solicitó, área y sede.']
      );
      await event(ins.insertId, 'importada', { to: upn, user, notes: 'Cuenta que existía en el tenant y no estaba registrada' });
      added += 1;
    }
  }
  const result = `${users.length} usuario(s) leídos, ${matched} ya registrados, ${added} nuevos detectados; ${skus.length} tipo(s) de licencia.`;
  await settingsService.setMany({ m365_last_sync: started, m365_last_sync_result: result });
  return { users: users.length, matched, added, skus: skus.length, result };
}

async function skuList() {
  const [rows] = await pool.query('SELECT * FROM m365_skus ORDER BY COALESCE(friendly_name, part_number)');
  return rows;
}

// Nombres de licencia para elegir: las del tenant y las del catalogo.
async function licenseOptions() {
  const [rows] = await pool.query(
    `SELECT COALESCE(friendly_name, part_number) AS name FROM m365_skus
     UNION SELECT value FROM catalog_items WHERE catalog_type = 'licencia_m365' AND active = 1 ORDER BY 1`
  );
  return rows.map((r) => r.name);
}

module.exports = {
  STATUS, ACCOUNT_TYPES, EVENT_LABELS, REQUEST_TYPES, MANAGER_RE, tasksFor, list, get, differences, event, createRequest, applyCompleted,
  config, sync, skuList, licenseOptions, UPN,
};
