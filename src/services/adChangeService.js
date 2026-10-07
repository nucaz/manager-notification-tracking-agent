// Directorio activo, fase 2: quien puede cambiar que, y como.
//   superadmin            -> ejecuta directo (con re-autenticacion).
//   con permiso temporal  -> ejecuta directo lo que el superadmin le habilito,
//                            hasta que vence (con re-autenticacion).
//   admin / editor        -> pide el cambio; queda pendiente hasta que un
//                            superadmin lo aprueba (y se ejecuta) o lo rechaza.
//   lector                -> nada.
// Todo queda en ad_change_requests y en la auditoria. Las solicitudes
// pendientes vencen a los 7 dias. Una contrasena generada se muestra una sola
// vez a quien pidio el cambio: se guarda cifrada hasta que la ve (o 24 h).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const adWriteService = require('./adWriteService');
const cryptoService = require('./cryptoService');
const otpService = require('./otpService');
const auditService = require('./auditService');
const mailer = require('./mailer');
const env = require('../config/env');

const { OPS, GROUPS } = adWriteService;
const REQUEST_DAYS = 7;
const SECRET_HOURS = 24;
const MAX_BATCH = 200;
const STATUS = {
  pendiente: 'Pendiente de aprobación', ejecutada: 'Ejecutada', rechazada: 'Rechazada', fallida: 'Falló', cancelada: 'Cancelada', vencida: 'Vencida',
};
const VIA = { directa: 'Superadministrador', aprobacion: 'Con aprobación', permiso_temporal: 'Permiso temporal' };

// ------------------------------ re-autenticacion ------------------------------
// Antes de ejecutar, aprobar, dar permisos o cambiar la cuenta de escritura:
// codigo de la app de autenticacion (si tiene 2FA) o la contrasena. Cinco
// fallos seguidos bloquean estas acciones 15 minutos para ese usuario.
const failures = new Map(); // userId -> { count, until }
async function verifyReauth(req) {
  const id = req.session.user.id;
  const f = failures.get(id);
  if (f && f.until && f.until > Date.now()) throw new Error('Demasiados intentos fallidos de confirmación. Espere 15 minutos.');
  const [[u]] = await pool.query('SELECT id, email, password_hash, otp_enabled, otp_secret FROM users WHERE id = ? AND active = 1', [id]);
  let ok = false;
  if (u && u.otp_enabled && u.otp_secret) ok = await otpService.verifyToken(u.otp_secret, req.body.reauth_code);
  else if (u) ok = await bcrypt.compare(String(req.body.reauth_password || ''), u.password_hash);
  if (!ok) {
    const n = (f && f.until && f.until <= Date.now() ? 0 : (f ? f.count : 0)) + 1;
    failures.set(id, { count: n, until: n >= 5 ? Date.now() + 15 * 60000 : null });
    await auditService.log(req, { user: req.session.user, action: 'ad_reauth_fallida', target: 'directorio activo', detail: `intento ${n}` });
    throw new Error(u && u.otp_enabled ? 'El código de verificación no es válido.' : 'La contraseña de confirmación no es correcta.');
  }
  failures.delete(id);
  return true;
}
async function reauthKind(userId) {
  const [[u]] = await pool.query('SELECT otp_enabled FROM users WHERE id = ?', [userId]);
  return u && u.otp_enabled ? 'codigo' : 'contrasena';
}

// ------------------------------ permisos ------------------------------
async function activeGrant(userId, group) {
  const [[g]] = await pool.query(
    `SELECT * FROM ad_grants WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW() AND FIND_IN_SET(?, operations)
     ORDER BY expires_at DESC LIMIT 1`, [userId, group]
  );
  return g || null;
}

// Como puede hacer "op" este usuario: { mode: 'directa' | 'permiso_temporal' | 'aprobacion', grant } o null.
async function modeFor(user, op) {
  if (!user || !OPS[op] || !['superadmin', 'admin', 'editor'].includes(user.role)) return null;
  if (user.role === 'superadmin') return { mode: 'directa' };
  const grant = await activeGrant(user.id, OPS[op].group);
  return grant ? { mode: 'permiso_temporal', grant } : { mode: 'aprobacion' };
}

async function myGrants(userId) {
  const [rows] = await pool.query('SELECT * FROM ad_grants WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW() ORDER BY expires_at', [userId]);
  return rows;
}

// ------------------------------ solicitudes ------------------------------
const batchId = () => crypto.randomBytes(6).toString('hex');

async function insert(conn, { op, target, params, reason, via, user, grantId, batch }) {
  const [r] = await conn.query(
    `INSERT INTO ad_change_requests (operation, target_kind, target_guid, target_dn, target_label, params_json, reason, status, via, batch_id,
       requested_by, grant_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?, NOW() + INTERVAL ${REQUEST_DAYS} DAY)`,
    [op, target.kind, target.guid || null, target.dn ? String(target.dn).slice(0, 700) : null, String(target.label).slice(0, 255),
      JSON.stringify(params || {}), reason ? String(reason).slice(0, 500) : null, via, batch || null, user.id, grantId || null]
  );
  return r.insertId;
}

// Guarda la contrasena generada para que la vea quien pidio el cambio, cifrada.
// Si no hay clave de cifrado configurada, NO se guarda: se le muestra a quien ejecuto.
function canStoreSecret() {
  return cryptoService.isEncrypted(cryptoService.encrypt('x'));
}

// Ejecuta solicitudes ya creadas. actor: quien ejecuta (el solicitante si
// es directa o permiso temporal; el superadmin que aprueba si no).
// Devuelve [{ id, ok, message, secret? }]: secret solo cuando le toca verla al actor.
async function executeRequests(req, rows, actor, { decided = false, note = null } = {}) {
  const items = rows.map((r) => ({ op: r.operation, targetGuid: r.target_guid, params: JSON.parse(r.params_json || '{}') }));
  let results;
  try {
    results = await adWriteService.executeMany(items);
  } catch (err) {
    results = rows.map(() => ({ ok: false, message: err.message }));
  }
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const res = results[i];
    let secretForActor = null;
    let secretEnc = null;
    if (res.ok && res.secret) {
      if (r.requested_by === actor.id || !canStoreSecret()) secretForActor = res.secret;
      else secretEnc = cryptoService.encrypt(res.secret);
    }
    await pool.query(
      `UPDATE ad_change_requests SET status = ?, executed_at = NOW(), result = ?, secret_enc = ?, secret_until = ${secretEnc ? `NOW() + INTERVAL ${SECRET_HOURS} HOUR` : 'NULL'}
         ${decided ? ', decided_by = ?, decided_at = NOW(), decision_note = ?' : ''}
       WHERE id = ?`,
      [res.ok ? 'ejecutada' : 'fallida', String(res.message).slice(0, 1000), secretEnc, ...(decided ? [actor.id, note] : []), r.id]
    );
    if (res.ok && r.grant_id) await pool.query('UPDATE ad_grants SET uses_count = uses_count + 1 WHERE id = ?', [r.grant_id]);
    await auditService.log(req, { user: actor, action: res.ok ? 'ad_cambio' : 'ad_cambio_error', target: `${OPS[r.operation].label}: ${r.target_label}`,
      detail: `solicitud #${r.id} (${VIA[r.via]}${decided ? `, aprobada por ${actor.email}` : ''}): ${res.message}` });
    out.push({ id: r.id, ok: res.ok, message: res.message, secret: secretForActor, label: r.target_label, operation: r.operation, warning: !!res.warning });
  }
  return out;
}

// Pide o ejecuta uno o varios cambios (la misma operacion sobre varios objetos).
// targets: [{ kind, guid, dn, label }]. Devuelve { mode, ids, results? }.
async function submit(req, { op, targets, params, reason }) {
  const user = req.session.user;
  const m = await modeFor(user, op);
  if (!m) throw new Error('Su rol no permite cambios en el directorio activo.');
  if (!targets.length) throw new Error('No hay objetos para cambiar.');
  if (targets.length > MAX_BATCH) throw new Error(`Como máximo ${MAX_BATCH} objetos por vez.`);
  if (targets.length > 1 && !OPS[op].bulk) throw new Error('Esta operación no se puede hacer en lote.');
  const why = adWriteService.notReady(await adWriteService.config());
  if (why) throw new Error(why);
  if (m.mode === 'aprobacion' && !String(reason || '').trim()) throw new Error('Indique el motivo: el superadministrador lo verá al aprobar.');
  if (m.mode !== 'aprobacion') await verifyReauth(req);
  const batch = targets.length > 1 ? batchId() : null;
  const ids = [];
  for (const t of targets) ids.push(await insert(pool, { op, target: t, params, reason, via: m.mode, user, grantId: m.grant && m.grant.id, batch }));
  if (m.mode === 'aprobacion') {
    await auditService.log(req, { user, action: 'ad_solicitud', target: `${OPS[op].label}: ${targets.map((t) => t.label).join(', ').slice(0, 200)}`,
      detail: `solicitud${ids.length > 1 ? 'es' : ''} #${ids.join(', #')}${reason ? ` · motivo: ${reason}` : ''}` });
    notifySuperadmins(user, op, targets, ids, reason).catch(() => {});
    return { mode: m.mode, ids };
  }
  const [rows] = await pool.query('SELECT * FROM ad_change_requests WHERE id IN (?) ORDER BY id', [ids]);
  return { mode: m.mode, ids, results: await executeRequests(req, rows, user) };
}

// Aviso por correo a los superadministradores (si hay SMTP); nunca bloquea la solicitud.
async function notifySuperadmins(user, op, targets, ids, reason) {
  const [admins] = await pool.query("SELECT email FROM users WHERE role = 'superadmin' AND active = 1 AND id <> ?", [user.id]);
  if (!admins.length) return;
  const url = `${env.appBaseUrl.replace(/\/$/, '')}/ad/cambios`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  await mailer.sendMail({
    to: admins.map((a) => a.email).join(','),
    subject: `Directorio activo: ${user.full_name || user.email} pide ${OPS[op].label.toLowerCase()} (${targets.length})`,
    html: `<p><strong>${esc(user.full_name || user.email)}</strong> pide <strong>${esc(OPS[op].label)}</strong> sobre:</p>`
      + `<ul>${targets.slice(0, 30).map((t) => `<li>${esc(t.label)}</li>`).join('')}${targets.length > 30 ? `<li>y ${targets.length - 30} más</li>` : ''}</ul>`
      + `${reason ? `<p>Motivo: ${esc(reason)}</p>` : ''}<p>Revíselo y apruébelo o recházelo en <a href="${esc(url)}">${esc(url)}</a> (solicitud #${ids.join(', #')}).</p>`,
  });
}

// Aprueba (y ejecuta) solicitudes pendientes. Solo superadmin; nunca las propias.
async function approve(req, ids, note) {
  const actor = req.session.user;
  if (actor.role !== 'superadmin') throw new Error('Solo un superadministrador aprueba cambios.');
  await verifyReauth(req);
  await expire();
  const [rows] = await pool.query("SELECT * FROM ad_change_requests WHERE id IN (?) AND status = 'pendiente' AND requested_by <> ? ORDER BY id",
    [ids.length ? ids : [0], actor.id]);
  if (!rows.length) throw new Error('No hay solicitudes pendientes para aprobar (puede que ya se hayan decidido o vencido).');
  return executeRequests(req, rows, actor, { decided: true, note: note ? String(note).slice(0, 500) : null });
}

async function reject(req, ids, note) {
  const actor = req.session.user;
  if (actor.role !== 'superadmin') throw new Error('Solo un superadministrador rechaza cambios.');
  if (!String(note || '').trim()) throw new Error('Indique el motivo del rechazo: lo verá quien lo pidió.');
  const [r] = await pool.query(
    "UPDATE ad_change_requests SET status = 'rechazada', decided_by = ?, decided_at = NOW(), decision_note = ? WHERE id IN (?) AND status = 'pendiente'",
    [actor.id, String(note).slice(0, 500), ids.length ? ids : [0]]
  );
  await auditService.log(req, { user: actor, action: 'ad_rechazada', target: 'directorio activo', detail: `solicitud(es) #${ids.join(', #')}: ${note}` });
  return r.affectedRows;
}

async function cancel(req, id) {
  const [r] = await pool.query("UPDATE ad_change_requests SET status = 'cancelada', decided_at = NOW() WHERE id = ? AND status = 'pendiente' AND requested_by = ?",
    [id, req.session.user.id]);
  if (r.affectedRows) await auditService.log(req, { user: req.session.user, action: 'ad_cancelada', target: 'directorio activo', detail: `solicitud #${id}` });
  return r.affectedRows;
}

// La contrasena generada, UNA vez, a quien pidio el cambio (y se borra).
async function revealSecret(req, id) {
  await verifyReauth(req);
  const [[r]] = await pool.query('SELECT * FROM ad_change_requests WHERE id = ? AND requested_by = ? AND secret_enc IS NOT NULL AND secret_until > NOW()',
    [id, req.session.user.id]);
  if (!r) throw new Error('La contraseña ya se mostró o venció (se guarda 24 horas). Pida un nuevo restablecimiento.');
  await pool.query('UPDATE ad_change_requests SET secret_enc = NULL, secret_until = NULL WHERE id = ?', [id]);
  await auditService.log(req, { user: req.session.user, action: 'ad_contrasena_vista', target: r.target_label, detail: `solicitud #${id}` });
  return cryptoService.decrypt(r.secret_enc);
}

// Vencimientos: solicitudes pendientes de mas de 7 dias y contrasenas no vistas de mas de 24 h.
async function expire() {
  const [a] = await pool.query("UPDATE ad_change_requests SET status = 'vencida' WHERE status = 'pendiente' AND expires_at <= NOW()");
  const [b] = await pool.query('UPDATE ad_change_requests SET secret_enc = NULL, secret_until = NULL WHERE secret_enc IS NOT NULL AND secret_until <= NOW()');
  return { requests: a.affectedRows, secrets: b.affectedRows };
}

const REQ_SQL = `SELECT r.*, u.full_name AS requested_name, u.email AS requested_email, d.full_name AS decided_name
  FROM ad_change_requests r LEFT JOIN users u ON u.id = r.requested_by LEFT JOIN users d ON d.id = r.decided_by`;

async function list(user, { status } = {}) {
  await expire();
  const where = [];
  const args = [];
  if (user.role === 'editor') { where.push('r.requested_by = ?'); args.push(user.id); }
  if (status && STATUS[status]) { where.push('r.status = ?'); args.push(status); }
  const [rows] = await pool.query(`${REQ_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.status = 'pendiente' DESC, r.id DESC LIMIT 2000`, args);
  return rows;
}

async function get(id, user) {
  const [[r]] = await pool.query(`${REQ_SQL} WHERE r.id = ?`, [id]);
  if (!r || (user.role === 'editor' && r.requested_by !== user.id)) return null;
  let params = {};
  try { params = JSON.parse(r.params_json || '{}'); } catch (_) { params = {}; }
  return { ...r, params, hasSecret: !!(r.secret_enc && r.secret_until && new Date(r.secret_until) > new Date()), secret_enc: undefined };
}

async function pendingCount(user) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM ad_change_requests WHERE status = 'pendiente' AND expires_at > NOW() ${user.role === 'superadmin' ? '' : 'AND requested_by = ?'}`,
    user.role === 'superadmin' ? [] : [user.id]
  );
  return Number(r.n || 0);
}

// ------------------------------ permisos temporales ------------------------------
const DURATIONS = { 1: '1 hora', 4: '4 horas', 8: '8 horas (una jornada)', 24: '24 horas', 72: '3 días', 168: '7 días' };

async function grant(req, { userId, groups, hours, note }) {
  const actor = req.session.user;
  if (actor.role !== 'superadmin') throw new Error('Solo un superadministrador da permisos temporales.');
  const ops = [...new Set([].concat(groups || []).filter((g) => GROUPS[g]))];
  if (!ops.length) throw new Error('Marque al menos un tipo de cambio.');
  const h = Number(hours);
  if (!DURATIONS[h]) throw new Error('Elija la duración del permiso.');
  const [[u]] = await pool.query("SELECT id, email, full_name, role FROM users WHERE id = ? AND active = 1 AND role IN ('admin', 'editor')", [userId]);
  if (!u) throw new Error('Elija un usuario activo con rol administrador o editor.');
  await verifyReauth(req);
  const [r] = await pool.query(
    `INSERT INTO ad_grants (user_id, operations, note, granted_by, expires_at) VALUES (?, ?, ?, ?, NOW() + INTERVAL ${h} HOUR)`,
    [u.id, ops.join(','), note ? String(note).slice(0, 500) : null, actor.id]
  );
  await auditService.log(req, { user: actor, action: 'ad_permiso_temporal', target: u.email,
    detail: `${ops.map((g) => GROUPS[g]).join('; ')} por ${DURATIONS[h]}${note ? ` · ${note}` : ''}` });
  return { id: r.insertId, user: u };
}

async function revoke(req, id) {
  const actor = req.session.user;
  if (actor.role !== 'superadmin') throw new Error('Solo un superadministrador revoca permisos.');
  const [r] = await pool.query('UPDATE ad_grants SET revoked_at = NOW(), revoked_by = ? WHERE id = ? AND revoked_at IS NULL', [actor.id, id]);
  if (r.affectedRows) await auditService.log(req, { user: actor, action: 'ad_permiso_revocado', target: 'directorio activo', detail: `permiso #${id}` });
  return r.affectedRows;
}

async function grants() {
  const [rows] = await pool.query(
    `SELECT g.*, u.full_name, u.email, u.role, b.full_name AS granted_name, v.full_name AS revoked_name,
            (g.revoked_at IS NULL AND g.expires_at > NOW()) AS active
     FROM ad_grants g JOIN users u ON u.id = g.user_id LEFT JOIN users b ON b.id = g.granted_by LEFT JOIN users v ON v.id = g.revoked_by
     ORDER BY active DESC, g.id DESC LIMIT 200`
  );
  return rows;
}

async function grantableUsers() {
  const [rows] = await pool.query("SELECT id, full_name, email, role FROM users WHERE active = 1 AND role IN ('admin', 'editor') ORDER BY full_name");
  return rows;
}

module.exports = {
  STATUS, VIA, DURATIONS, MAX_BATCH, REQUEST_DAYS, SECRET_HOURS, verifyReauth, reauthKind, modeFor, myGrants, submit, approve, reject, cancel, revealSecret,
  expire, list, get, pendingCount, grant, revoke, grants, grantableUsers, _: { failures },
};
