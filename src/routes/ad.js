// Directorio activo. Ver src/services/adService.js (lectura),
// adWriteService.js (cambios en el dominio) y adChangeService.js (aprobaciones).
//   - Ver el modulo: permiso "directorio" (apagado por defecto para editor y lector).
//   - Leer el dominio ahora: administradores.
//   - Cambios: superadmin directo; admin/editor piden aprobacion o usan un
//     permiso temporal; lector nada. Ejecutar y aprobar piden re-autenticacion.
//   - Conexion (servidor, cuentas, CA, OU gestionadas): solo superadmin.
const crypto = require('crypto');
const express = require('express');
const pool = require('../db/pool');
const { requireAuth, isAdmin, isSuperAdmin, canWrite } = require('../middleware/auth');
const { moduleRequired } = require('../middleware/modules');
const { verifyCsrfToken } = require('../middleware/csrf');
const adService = require('../services/adService');
const adWriteService = require('../services/adWriteService');
const adChangeService = require('../services/adChangeService');
const adGpoService = require('../services/adGpoService');
const clinicService = require('../services/clinicService');
const settingsService = require('../services/settingsService');
const auditService = require('../services/auditService');

const router = express.Router();
router.use(requireAuth, moduleRequired('directorio'));

const bucket = (d) => clinicService.bucketLabel(clinicService.bucketOf(d));
const VIEW = { bucket, BUCKETS: clinicService.BUCKETS, PRIVILEGED_LABEL: adService.PRIVILEGED_LABEL, IDLE_DAYS: adService.IDLE_DAYS,
  OPS: adWriteService.OPS, GROUPS: adWriteService.GROUPS, STATUS: adChangeService.STATUS, VIA: adChangeService.VIA };

async function base(req) {
  const [run, cfg, wcfg] = await Promise.all([adService.lastRun(), adService.config(), adWriteService.config()]);
  const user = req && req.session.user;
  const canChange = !!user && ['superadmin', 'admin', 'editor'].includes(user.role);
  return {
    run, configured: !!(cfg.url && cfg.bindUser && cfg.password && cfg.caPem), lastResult: cfg.lastResult,
    writes: { ready: !adWriteService.notReady(wcfg), reason: adWriteService.notReady(wcfg), managedOus: wcfg.managedOus },
    canChange, pending: canChange ? await adChangeService.pendingCount(user) : 0,
  };
}

// Codigo de un solo uso por formulario de cambio: recargar la pagina de
// resultado no vuelve a ejecutar el cambio.
function newNonce(req) {
  const n = crypto.randomBytes(16).toString('hex');
  req.session.adNonces = [...(req.session.adNonces || []).slice(-19), n];
  return n;
}
function useNonce(req) {
  const list = req.session.adNonces || [];
  const i = list.indexOf(String(req.body.nonce || ''));
  if (i === -1) return false;
  list.splice(i, 1);
  req.session.adNonces = list;
  return true;
}

// ------------------------------ objetos de la ultima lectura ------------------------------
const SNAP = {
  usuario: { table: 'ad_users', label: (r) => (r.display_name ? `${r.sam} (${r.display_name})` : r.sam), dn: (r) => r.dn },
  grupo: { table: 'ad_groups', label: (r) => r.name, dn: (r) => r.dn },
  equipo: { table: 'ad_computers', label: (r) => r.name, dn: (r) => r.dn },
  ou: { table: 'ad_ous', label: (r) => r.dn, dn: (r) => r.dn },
  eliminado: { table: 'ad_deleted', label: (r) => `${r.name}${r.sam ? ` (${r.sam})` : ''}`, dn: (r) => r.last_known_parent },
};
async function snapshot(kind, ids) {
  const s = SNAP[kind];
  const list = [].concat(ids || []).map(Number).filter((n) => n > 0);
  if (!s || !list.length) return [];
  const [rows] = await pool.query(`SELECT * FROM ${s.table} WHERE id IN (?) ${kind === 'eliminado' ? '' : 'AND removed_at IS NULL'}`, [list]);
  return rows;
}
const targetOf = (kind, row) => ({ kind, guid: row.object_guid, dn: SNAP[kind].dn(row), label: SNAP[kind].label(row), id: row.id });

// Aviso previo con la ultima lectura (la comprobacion real es en vivo al ejecutar).
function precheck(kind, row, managedOus) {
  const r = [];
  const dn = kind === 'eliminado' ? row.last_known_parent : row.dn;
  if (!adWriteService.inManaged(managedOus, dn || '')) r.push('Está fuera de las unidades organizativas gestionadas.');
  if (kind === 'usuario' && row.privileged_groups) r.push('Es una cuenta privilegiada (solo lectura).');
  else if (kind === 'usuario' && row.admin_count) r.push('Tiene adminCount=1: es o fue una cuenta privilegiada.');
  if (kind === 'grupo' && row.privileged) r.push('Es un grupo privilegiado (solo lectura).');
  if (kind === 'equipo' && row.is_dc) r.push('Es un controlador de dominio.');
  return r;
}

// OU gestionadas (y las que estan dentro) para elegir destino.
async function managedOuOptions(managedOus) {
  const rows = await adService.ous();
  return rows.filter((o) => adWriteService.inManaged(managedOus, o.dn));
}

async function memberOf(groupId, hash) {
  const [[m]] = await pool.query('SELECT member_dn, member_kind FROM ad_group_members WHERE group_id = ? AND member_hash = ?', [groupId, hash]);
  if (!m) return null;
  const table = m.member_kind === 'equipo' ? 'ad_computers' : 'ad_users';
  const [[row]] = await pool.query(`SELECT * FROM ${table} WHERE LOWER(dn) = LOWER(?) AND removed_at IS NULL`, [m.member_dn]);
  return row ? { guid: row.object_guid, label: row.sam || row.name, dn: row.dn } : null;
}

// ------------------------------ filtros por enlace y busqueda ------------------------------
// Los numeros del resumen y del Panel enlazan a la lista ya filtrada
// (?f=clave, ?tramo=, ?so=); ?q= busca texto en las columnas principales.
const ageDays = (d) => {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(String(d).replace(' ', 'T').slice(0, 19));
  return (Date.now() - t.getTime()) / 86400000;
};
const IDLE = adService.IDLE_DAYS;
const SPECIAL_DNS = (r) => r.name === '@' || String(r.name).startsWith('_') || ['DomainDnsZones', 'ForestDnsZones'].includes(r.name);
const FILTERS = {
  usuarios: {
    habilitados: ['Habilitados', (u) => u.enabled],
    deshabilitados: ['Deshabilitados', (u) => !u.enabled],
    bloqueados: ['Bloqueados', (u) => u.locked],
    privilegiados: ['Habilitados con privilegios de administración', (u) => u.enabled && u.privileged_groups],
    inactivos: [`Habilitados sin conectarse en ${IDLE} días`, (u) => u.enabled && u.last_seen && ageDays(u.last_seen) > IDLE],
    nunca: ['Habilitados que nunca entraron (creados hace más de 30 días)', (u) => u.enabled && !u.last_seen && (!u.when_created || ageDays(u.when_created) > 30)],
    no_vence: ['Habilitados con contraseña que no vence', (u) => u.enabled && u.pwd_never_expires],
  },
  equipos: {
    habilitados: ['Habilitados', (c) => c.enabled],
    inactivos: [`Habilitados sin conectarse en ${IDLE} días (o nunca)`, (c) => c.enabled && !c.is_dc && (!c.last_seen || ageDays(c.last_seen) > IDLE)],
    sin_dns: ['Habilitados sin registro DNS', (c) => c.enabled && !c.is_dc && !c.ips],
    dc: ['Controladores de dominio', (c) => c.is_dc],
  },
  grupos: { privilegiados: ['Grupos privilegiados', (g) => g.privileged] },
  gpo: {
    sin_vincular: ['Sin vincular (no se aplican en ningún sitio)', (g) => !g.links.length],
    vacias: ['Vacías (nunca se les configuró nada)', (g) => !g.computer_version && !g.user_version],
    deshabilitadas: ['Deshabilitadas por completo', (g) => g.status === 'Deshabilitada'],
    scripts: ['Con scripts o tareas programadas', (g) => g.kinds.includes('script')],
    software: ['Con despliegue de software', (g) => g.kinds.includes('software') || g.software.length > 0],
    restricciones: ['Con restricciones', (g) => g.kinds.includes('restriccion')],
    seguridad: ['Con configuración de seguridad', (g) => g.kinds.includes('seguridad')],
    por_revisar: ['Con algo por revisar', (g) => g.notes.length > 0],
  },
  dns: { huerfanos: ['Registros de host sin equipo en AD', (r) => !r.computer_id && ['A', 'AAAA'].includes(r.rtype) && !SPECIAL_DNS(r)] },
};
const SEARCH = {
  usuarios: (u) => [u.sam, u.display_name, u.upn, u.mail, u.title, u.department, u.description, u.dn, u.employee_dni],
  grupos: (g) => [g.name, g.sam, g.description, g.dn],
  equipos: (c) => [c.name, c.dns_host, c.os, c.ips, c.description, c.dn],
  dns: (r) => [r.zone, r.name, r.data, r.computer_name],
  gpo: (g) => [g.name, g.gpo_guid, g.wmi_filter, g.status, ...g.links.map((l) => l.target_name), ...g.links.map((l) => l.target_dn),
    ...g.computer.map((e) => e.label), ...g.user.map((e) => e.label), ...g.software.map((s) => `${s.name} ${s.path}`)],
  papelera: (d) => [d.name, d.sam, d.last_known_parent, d.object_class],
};
function listFilter(kind, req, items) {
  const labels = [];
  const keep = {};
  let out = items;
  const f = FILTERS[kind] && FILTERS[kind][req.query.f];
  if (f) { out = out.filter(f[1]); labels.push(f[0]); keep.f = req.query.f; }
  if (kind === 'usuarios' && req.query.tramo) {
    const b = clinicService.BUCKETS.find((x) => x.key === req.query.tramo);
    if (b) { out = out.filter((u) => u.enabled && clinicService.bucketOf(u.last_seen) === b.key); labels.push(`Habilitados · última conexión: ${b.label}`); keep.tramo = b.key; }
  }
  if (kind === 'equipos' && req.query.so) {
    const so = String(req.query.so);
    out = out.filter((c) => c.enabled && (c.os || 'Sin dato') === so);
    labels.push(`Habilitados con ${so}`);
    keep.so = so;
  }
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q && SEARCH[kind]) {
    const n = q.toLowerCase();
    out = out.filter((x) => SEARCH[kind](x).some((v) => v && String(v).toLowerCase().includes(n)));
  }
  return { items: out, filtro: labels.join(' · '), q, keep, total: items.length };
}

router.get('/', async (req, res, next) => {
  try {
    const [b, ov, gpoOv] = await Promise.all([base(req), adService.overview(), adGpoService.overview()]);
    // Antiguedad de la ultima conexion de los usuarios habilitados.
    const tramos = Object.fromEntries(clinicService.BUCKETS.map((x) => [x.key, 0]));
    ov.lastSeen.forEach((u) => { tramos[clinicService.bucketOf(u.last_seen)] += 1; });
    res.render('ad/index', { title: 'Directorio activo', tab: 'resumen', ...b, ov, gpoOv, tramos, ...VIEW });
  } catch (err) {
    next(err);
  }
});

router.get('/usuarios', async (req, res, next) => {
  try {
    res.render('ad/users', { title: 'Directorio activo: usuarios', tab: 'usuarios', ...(await base(req)), ...listFilter('usuarios', req, await adService.users()), ...VIEW });
  } catch (err) {
    next(err);
  }
});

router.get('/usuarios/:id(\\d+)', async (req, res, next) => {
  try {
    const item = await adService.user(req.params.id);
    if (!item) {
      req.flash('error', 'Usuario no encontrado en la última lectura del dominio.');
      return res.redirect('/ad/usuarios');
    }
    const b = await base(req);
    const groupOptions = (await adService.groups()).filter((g) => !g.privileged && adWriteService.inManaged(b.writes.managedOus, g.dn)
      && !item.memberOf.some((m) => m.id === g.id));
    res.render('ad/user', { title: `Directorio activo: ${item.sam}`, tab: 'usuarios', ...b, item, ...VIEW, groupOptions,
      memberHash: crypto.createHash('sha1').update(String(item.dn).toLowerCase()).digest('hex'),
      protectedReasons: precheck('usuario', item, b.writes.managedOus) });
  } catch (err) {
    next(err);
  }
});

router.get('/grupos', async (req, res, next) => {
  try {
    res.render('ad/groups', { title: 'Directorio activo: grupos', tab: 'grupos', ...(await base(req)), ...listFilter('grupos', req, await adService.groups()), ...VIEW });
  } catch (err) {
    next(err);
  }
});

router.get('/grupos/:id(\\d+)', async (req, res, next) => {
  try {
    const item = await adService.group(req.params.id);
    if (!item) {
      req.flash('error', 'Grupo no encontrado en la última lectura del dominio.');
      return res.redirect('/ad/grupos');
    }
    const b = await base(req);
    res.render('ad/group', { title: `Directorio activo: ${item.name}`, tab: 'grupos', ...b, item, ...VIEW, protectedReasons: precheck('grupo', item, b.writes.managedOus) });
  } catch (err) {
    next(err);
  }
});

router.get('/unidades', async (req, res, next) => {
  try {
    res.render('ad/ous', { title: 'Directorio activo: unidades organizativas', tab: 'unidades', ...(await base(req)), items: await adService.ous(), ...VIEW,
      computers: await adService.computers(),
      q: String(req.query.q || '').trim().slice(0, 100) });
  } catch (err) {
    next(err);
  }
});

router.get('/equipos', async (req, res, next) => {
  try {
    res.render('ad/computers', { title: 'Directorio activo: equipos', tab: 'equipos', ...(await base(req)), ...listFilter('equipos', req, await adService.computers()), ...VIEW });
  } catch (err) {
    next(err);
  }
});

router.get('/dns', async (req, res, next) => {
  try {
    res.render('ad/dns', { title: 'Directorio activo: DNS', tab: 'dns', ...(await base(req)), ...listFilter('dns', req, await adService.dns()), ...VIEW });
  } catch (err) {
    next(err);
  }
});

// ------------------------------ directivas de grupo (solo lectura) ------------------------------
router.get('/gpo', async (req, res, next) => {
  try {
    res.render('ad/gpos', { title: 'Directorio activo: directivas (GPO)', tab: 'gpo', ...(await base(req)), ...listFilter('gpo', req, await adGpoService.list()),
      gpoOv: await adGpoService.overview(), orphans: await adGpoService.orphanLinks(), KINDS: adGpoService.KINDS, FILTROS: FILTERS.gpo, ...VIEW });
  } catch (err) {
    next(err);
  }
});

// Donde aplica cada directiva: dominio y cada unidad, con lo vinculado y lo heredado.
router.get('/gpo/aplicacion', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    res.render('ad/gpo_apply', { title: 'Directorio activo: dónde aplican las GPO', tab: 'gpo', ...(await base(req)), app: await adGpoService.application(), q,
      KINDS: adGpoService.KINDS, ...VIEW });
  } catch (err) {
    next(err);
  }
});

router.get('/gpo/:guid([0-9a-fA-F-]{36})', async (req, res, next) => {
  try {
    const item = await adGpoService.get(req.params.guid);
    if (!item) {
      req.flash('error', 'Esa directiva ya no está en la última lectura del dominio.');
      return res.redirect('/ad/gpo');
    }
    return res.render('ad/gpo', { title: `Directorio activo: ${item.name}`, tab: 'gpo', ...(await base(req)), item, KINDS: adGpoService.KINDS, ...VIEW });
  } catch (err) {
    return next(err);
  }
});

router.get('/papelera', async (req, res, next) => {
  try {
    res.render('ad/deleted', { title: 'Directorio activo: papelera', tab: 'papelera', ...(await base(req)), ...listFilter('papelera', req, await adService.deleted()), ...VIEW });
  } catch (err) {
    next(err);
  }
});

// Leer el dominio ahora (solo lectura): administradores.
router.post('/sincronizar', isAdmin, verifyCsrfToken, async (req, res) => {
  try {
    const r = await adService.sync(req.session.user);
    await auditService.log(req, { user: req.session.user, action: 'ad_lectura', target: r.domain, detail: r.result });
    req.flash('success', `Dominio leído: ${r.result}`);
  } catch (err) {
    await auditService.log(req, { user: req.session.user, action: 'ad_lectura_error', target: 'directorio activo', detail: err.message });
    req.flash('error', `No se pudo leer el dominio: ${err.message}`);
  }
  res.redirect(req.get('referer') && /\/ad(\/|$)/.test(req.get('referer')) ? req.get('referer') : '/ad');
});

// ------------------------------ cambios en el dominio ------------------------------
const back = (req, fallback) => (req.get('referer') && /\/ad(\/|$)/.test(req.get('referer')) ? req.get('referer') : fallback);
const ids = (v) => [].concat(v || []).map(Number).filter((n) => n > 0);

// Lee el formulario de una operacion y arma { target, params } (validado).
async function buildChange(req, op) {
  const def = adWriteService.OPS[op];
  const b = req.body;
  const wcfg = await adWriteService.config();
  const kind = def.target;
  const [row] = await snapshot(kind, kind === 'ou' ? b.ou_id : b.id);
  if (!row) throw new Error(kind === 'ou' ? 'Elija la unidad organizativa.' : 'El objeto ya no está en la última lectura del dominio.');
  const pre = precheck(kind, row, wcfg.managedOus);
  if (pre.length) throw new Error(`No se puede: ${pre.join(' ')}`);
  let params = {};
  switch (op) {
    case 'user_create':
      params = { givenName: b.givenName, sn: b.sn, sam: b.sam, displayName: b.displayName, mail: b.mail, title: b.title, department: b.department,
        description: b.description, employeeID: b.employeeID, mustChange: b.mustChange === '1' };
      break;
    case 'user_update': {
      const live = await adWriteService.readLive(row.object_guid, Object.keys(adWriteService.USER_FIELDS));
      if (!live) throw new Error('El usuario ya no existe en el dominio.');
      const changes = {};
      Object.keys(adWriteService.USER_FIELDS).forEach((k) => {
        const v = b[`f_${k}`];
        if (v !== undefined && String(v).trim() !== String(live[k] || '').trim()) changes[k] = { from: live[k] || '', to: v };
      });
      params = { changes };
      break;
    }
    case 'user_reset_password':
      params = { mustChange: b.mustChange === '1', unlock: b.unlock === '1' };
      break;
    case 'user_move':
    case 'computer_move': {
      const [ou] = await snapshot('ou', b.to_ou_id);
      if (!ou || !adWriteService.inManaged(wcfg.managedOus, ou.dn)) throw new Error('Elija una unidad organizativa de destino gestionada.');
      params = { toOuGuid: ou.object_guid, toOuDn: ou.dn };
      break;
    }
    case 'group_create':
      params = { name: b.name, scope: b.scope, kind: b.kind, description: b.description };
      break;
    case 'computer_create':
    case 'ou_create':
      params = { name: b.name, description: b.description };
      break;
    case 'group_add_member': {
      const q = String(b.member || '').trim().replace(/\$$/, '');
      const [[u]] = await pool.query('SELECT object_guid, sam FROM ad_users WHERE removed_at IS NULL AND LOWER(sam) = LOWER(?)', [q]);
      const [[c]] = u ? [[null]] : await pool.query('SELECT object_guid, name FROM ad_computers WHERE removed_at IS NULL AND LOWER(name) = LOWER(?)', [q]);
      if (!u && !c) throw new Error(`No se encontró el usuario o equipo "${q}" en la última lectura.`);
      params = { memberGuid: (u || c).object_guid, memberLabel: u ? u.sam : c.name };
      break;
    }
    case 'group_remove_member': {
      const m = await memberOf(row.id, String(b.member_hash || ''));
      if (!m) throw new Error('Ese miembro ya no figura en el grupo (vuelva a leer el dominio).');
      params = { memberGuid: m.guid, memberLabel: m.label };
      break;
    }
    default:
      break;
  }
  params = adWriteService.validateParams(op, params);
  const target = targetOf(kind, row);
  if (kind === 'ou') {
    const what = { user_create: params.sam, group_create: params.name, computer_create: params.name, ou_create: params.name }[op];
    target.label = `${what} (nuevo) en ${row.name}`;
  } else if (op === 'group_add_member' || op === 'group_remove_member') {
    target.label = `${row.name} ${op === 'group_add_member' ? '+' : '−'} ${params.memberLabel}`;
  }
  return { target, params };
}

function renderResult(res, req, results, title) {
  res.render('ad/result', { title, tab: 'cambios', results, ...res.locals.adBase, ...VIEW });
}

router.get('/cambios/nuevo', canWrite, async (req, res, next) => {
  try {
    const op = String(req.query.op || '');
    const def = adWriteService.OPS[op];
    if (!def) return res.redirect('/ad/cambios');
    const b = await base(req);
    const kind = def.target;
    let row = null;
    if (req.query.id) [row] = await snapshot(kind, req.query.id);
    if (!row && kind !== 'ou') {
      req.flash('error', 'El objeto ya no está en la última lectura del dominio.');
      return res.redirect('/ad');
    }
    const pre = row ? precheck(kind, row, b.writes.managedOus) : [];
    const mode = await adChangeService.modeFor(req.session.user, op);
    const extra = {};
    if (kind === 'ou' || op === 'user_move' || op === 'computer_move') extra.ouOptions = await managedOuOptions(b.writes.managedOus);
    if (op === 'user_update' && row && !pre.length && b.writes.ready) {
      try { extra.live = await adWriteService.readLive(row.object_guid, Object.keys(adWriteService.USER_FIELDS)); } catch (err) { extra.liveError = err.message; }
    }
    if (op === 'computer_delete' && row) {
      [extra.dns] = await pool.query(
        `SELECT zone, name, rtype, data FROM ad_dns_records WHERE computer_id = ?
           OR (rtype = 'PTR' AND LOWER(TRIM(TRAILING '.' FROM data)) = LOWER(?)) ORDER BY zone, name`, [row.id, row.dns_host || `${row.name}.`]
      );
    }
    if (op === 'group_remove_member' && row) {
      extra.memberHash = String(req.query.miembro || '');
      extra.member = await memberOf(row.id, extra.memberHash);
    }
    if (op === 'group_add_member') {
      [extra.candidates] = await pool.query("SELECT sam, display_name FROM ad_users WHERE removed_at IS NULL AND privileged_groups IS NULL AND admin_count = 0 ORDER BY sam LIMIT 5000");
    }
    const form = req.session.adFormData && req.session.adFormData.op === op ? req.session.adFormData : (req.query.member ? { member: String(req.query.member) } : {});
    delete req.session.adFormData;
    res.render('ad/change_form', { title: `Directorio activo: ${def.label.toLowerCase()}`, tab: 'cambios', ...b, ...VIEW, op, def, kind, row, pre, mode,
      reauth: await adChangeService.reauthKind(req.session.user.id), nonce: newNonce(req), form, USER_FIELDS: adWriteService.USER_FIELDS, ...extra });
  } catch (err) {
    next(err);
  }
});

router.post('/cambios', canWrite, verifyCsrfToken, async (req, res, next) => {
  const op = String(req.body.op || '');
  const def = adWriteService.OPS[op];
  if (!def) return res.redirect('/ad/cambios');
  const formUrl = `/ad/cambios/nuevo?op=${encodeURIComponent(op)}${req.body.id ? `&id=${encodeURIComponent(req.body.id)}` : (req.body.ou_id ? `&id=${encodeURIComponent(req.body.ou_id)}` : '')}`
    + `${req.body.member_hash ? `&miembro=${encodeURIComponent(req.body.member_hash)}` : ''}`;
  try {
    if (!useNonce(req)) throw new Error('Este formulario ya se envió (o venció). Ábralo de nuevo.');
    const { target, params } = await buildChange(req, op);
    const r = await adChangeService.submit(req, { op, targets: [target], params, reason: req.body.reason });
    if (r.mode === 'aprobacion') {
      req.flash('success', `Solicitud #${r.ids[0]} enviada. Un superadministrador debe aprobarla; mientras tanto no se cambia nada en el dominio.`);
      return res.redirect(`/ad/cambios/${r.ids[0]}`);
    }
    res.locals.adBase = await base(req);
    return renderResult(res, req, r.results, 'Directorio activo: resultado');
  } catch (err) {
    if (err.sqlMessage) return next(err);
    const keep = { ...req.body };
    ['_csrf', 'nonce', 'reauth_code', 'reauth_password'].forEach((k) => delete keep[k]);
    req.session.adFormData = keep;
    req.flash('error', err.message);
    return res.redirect(formUrl);
  }
});

// Lote: revisar (pantalla de confirmacion) y ejecutar/pedir.
router.post('/cambios/lote/revisar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const op = String(req.body.op || '');
    const def = adWriteService.OPS[op];
    if (!def || !def.bulk) throw new Error('Operación no disponible en lote.');
    const list = ids(req.body.ids);
    if (!list.length) throw new Error('Marque al menos un elemento de la tabla.');
    if (list.length > adChangeService.MAX_BATCH) throw new Error(`Como máximo ${adChangeService.MAX_BATCH} elementos por vez.`);
    const b = await base(req);
    const rows = await snapshot(def.target, list);
    const items = rows.map((row) => ({ row, target: targetOf(def.target, row), pre: precheck(def.target, row, b.writes.managedOus) }));
    res.render('ad/batch', { title: `Directorio activo: ${def.label.toLowerCase()} en lote`, tab: 'cambios', ...b, ...VIEW, op, def, items,
      mode: await adChangeService.modeFor(req.session.user, op), reauth: await adChangeService.reauthKind(req.session.user.id), nonce: newNonce(req) });
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', err.message);
    return res.redirect(back(req, '/ad'));
  }
});

router.post('/cambios/lote', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    if (!useNonce(req)) throw new Error('Este formulario ya se envió (o venció). Vuelva a marcar los elementos.');
    const op = String(req.body.op || '');
    const def = adWriteService.OPS[op];
    if (!def || !def.bulk) throw new Error('Operación no disponible en lote.');
    const b = await base(req);
    const rows = await snapshot(def.target, ids(req.body.ids));
    const targets = rows.filter((row) => !precheck(def.target, row, b.writes.managedOus).length).map((row) => targetOf(def.target, row));
    const r = await adChangeService.submit(req, { op, targets, params: {}, reason: req.body.reason });
    if (r.mode === 'aprobacion') {
      req.flash('success', `${r.ids.length} solicitud(es) enviada(s) para aprobación (#${r.ids[0]}${r.ids.length > 1 ? ` a #${r.ids[r.ids.length - 1]}` : ''}).`);
      return res.redirect('/ad/cambios');
    }
    res.locals.adBase = b;
    return renderResult(res, req, r.results, 'Directorio activo: resultado del lote');
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', err.message);
    return res.redirect('/ad/cambios');
  }
});

router.get('/cambios', canWrite, async (req, res, next) => {
  try {
    const items = await adChangeService.list(req.session.user, { status: req.query.estado });
    res.render('ad/changes', { title: 'Directorio activo: cambios', tab: 'cambios', ...(await base(req)), ...VIEW, items, estado: req.query.estado || '',
      reauth: await adChangeService.reauthKind(req.session.user.id), grants: await adChangeService.myGrants(req.session.user.id) });
  } catch (err) {
    next(err);
  }
});

router.get('/cambios/:id(\\d+)', canWrite, async (req, res, next) => {
  try {
    const item = await adChangeService.get(req.params.id, req.session.user);
    if (!item) {
      req.flash('error', 'Solicitud no encontrada.');
      return res.redirect('/ad/cambios');
    }
    res.render('ad/change', { title: `Directorio activo: solicitud #${item.id}`, tab: 'cambios', ...(await base(req)), ...VIEW, item,
      reauth: await adChangeService.reauthKind(req.session.user.id), USER_FIELDS: adWriteService.USER_FIELDS });
  } catch (err) {
    next(err);
  }
});

router.post('/cambios/aprobar', isSuperAdmin, verifyCsrfToken, async (req, res, next) => {
  try {
    const results = await adChangeService.approve(req, ids(req.body.ids), req.body.note);
    if (results.some((r) => r.secret)) {
      res.locals.adBase = await base(req);
      return renderResult(res, req, results, 'Directorio activo: resultado');
    }
    const ok = results.filter((r) => r.ok).length;
    req.flash(ok === results.length ? 'success' : 'error', `${ok} de ${results.length} cambio(s) aprobados y ejecutados.`
      + `${results.filter((r) => !r.ok).map((r) => ` #${r.id}: ${r.message}`).join(' ')}`);
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', err.message);
  }
  return res.redirect(back(req, '/ad/cambios'));
});

router.post('/cambios/rechazar', isSuperAdmin, verifyCsrfToken, async (req, res, next) => {
  try {
    const n = await adChangeService.reject(req, ids(req.body.ids), req.body.note);
    req.flash('success', `${n} solicitud(es) rechazada(s).`);
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', err.message);
  }
  return res.redirect(back(req, '/ad/cambios'));
});

router.post('/cambios/:id(\\d+)/cancelar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const n = await adChangeService.cancel(req, req.params.id);
    req.flash(n ? 'success' : 'error', n ? 'Solicitud cancelada.' : 'Solo se cancela una solicitud propia que siga pendiente.');
  } catch (err) {
    return next(err);
  }
  return res.redirect(`/ad/cambios/${req.params.id}`);
});

// La contrasena generada, una sola vez, a quien pidio el cambio.
router.post('/cambios/:id(\\d+)/contrasena', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const secret = await adChangeService.revealSecret(req, req.params.id);
    const item = await adChangeService.get(req.params.id, req.session.user);
    res.locals.adBase = await base(req);
    return renderResult(res, req, [{ id: item.id, ok: true, message: item.result, secret, label: item.target_label, operation: item.operation }],
      'Directorio activo: contraseña generada');
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', err.message);
    return res.redirect(`/ad/cambios/${req.params.id}`);
  }
});

// ------------------------------ permisos temporales (superadmin) ------------------------------
router.get('/permisos', isSuperAdmin, async (req, res, next) => {
  try {
    res.render('ad/grants', { title: 'Directorio activo: permisos temporales', tab: 'cambios', ...(await base(req)), ...VIEW,
      items: await adChangeService.grants(), users: await adChangeService.grantableUsers(), DURATIONS: adChangeService.DURATIONS,
      reauth: await adChangeService.reauthKind(req.session.user.id) });
  } catch (err) {
    next(err);
  }
});

router.post('/permisos', isSuperAdmin, verifyCsrfToken, async (req, res, next) => {
  try {
    const g = await adChangeService.grant(req, { userId: Number(req.body.user_id), groups: req.body.groups, hours: req.body.hours, note: req.body.note });
    req.flash('success', `Permiso temporal dado a ${g.user.full_name || g.user.email}.`);
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', err.message);
  }
  return res.redirect('/ad/permisos');
});

router.post('/permisos/:id(\\d+)/revocar', isSuperAdmin, verifyCsrfToken, async (req, res, next) => {
  try {
    const n = await adChangeService.revoke(req, req.params.id);
    req.flash(n ? 'success' : 'error', n ? 'Permiso revocado.' : 'Ese permiso ya estaba revocado.');
  } catch (err) {
    return next(err);
  }
  return res.redirect('/ad/permisos');
});

// ------------------------------ conexion (solo superadmin) ------------------------------
router.get('/configuracion', isSuperAdmin, async (req, res, next) => {
  try {
    const cfg = await adService.config();
    const wcfg = await adWriteService.config();
    // Si el ultimo guardado fallo, se vuelve a mostrar lo que se habia elegido (nunca la contrasena).
    const draft = req.session.adWriteDraft || null;
    delete req.session.adWriteDraft;
    res.render('ad/config', { title: 'Directorio activo: conexión', tab: 'configuracion', ...(await base(req)),
      cfg: { ...cfg, password: cfg.password ? 'set' : '' }, test: null,
      wcfg: { enabled: wcfg.enabled, managedOus: wcfg.managedOus, writeUser: wcfg.writeUser, hasWritePassword: wcfg.hasWritePassword, ...(draft || {}) },
      ouList: await adService.ous(), reauth: await adChangeService.reauthKind(req.session.user.id) });
  } catch (err) {
    next(err);
  }
});

// Cambios en el dominio: interruptor, OU gestionadas y cuenta de escritura.
// Se prueba antes de guardar (inicio de sesion y que las OU existan).
// OU elegidas: casillas (ad_managed_ou) + las escritas a mano (ad_managed_ous, una por linea).
// Una OU dentro de otra elegida sobra: la de arriba ya la incluye.
function managedOusFrom(body) {
  const picked = [].concat(body.ad_managed_ou || []).map(String);
  const typed = String(body.ad_managed_ous || '').split(/\r?\n/);
  const seen = new Map();
  [...picked, ...typed].map((x) => x.trim().slice(0, 700)).filter(Boolean).forEach((dn) => { if (!seen.has(dn.toLowerCase())) seen.set(dn.toLowerCase(), dn); });
  const all = [...seen.values()];
  return all.filter((dn) => !all.some((o) => o !== dn && adWriteService.under(dn, o))).slice(0, 50);
}

// Lee CON la cuenta de escritura en que OU tiene control delegado (no escribe nada).
const detectHits = new Map(); // userId -> [marcas de tiempo]
router.post('/configuracion/escritura/detectar', isSuperAdmin, verifyCsrfToken, async (req, res) => {
  const id = req.session.user.id;
  const recent = (detectHits.get(id) || []).filter((t) => t > Date.now() - 10 * 60000);
  if (recent.length >= 20) return res.status(429).json({ error: 'Demasiadas detecciones seguidas. Espere unos minutos.' });
  detectHits.set(id, [...recent, Date.now()]);
  try {
    const current = await adWriteService.config();
    const writeUser = String(req.body.ad_write_user || '').trim().slice(0, 255);
    const typed = req.body.ad_write_password ? String(req.body.ad_write_password) : '';
    const password = writeUser
      ? (typed || (writeUser.toLowerCase() === String(current.writeUser).toLowerCase() ? (await settingsService.getAll()).ad_write_password : ''))
      : (await adService.config()).password;
    if (!current.url || !current.caPem) throw new Error('Primero conecte el directorio activo (arriba).');
    if (writeUser && !password) throw new Error('Escriba la contraseña de la cuenta de escritura para detectar sus unidades.');
    const r = await adWriteService.detectDelegation({ ...current, bindUser: writeUser || current.readUser, password });
    return res.json({ account: writeUser || current.readUser, ous: r.ous });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/configuracion/escritura', isSuperAdmin, verifyCsrfToken, async (req, res, next) => {
  const managedOus = managedOusFrom(req.body);
  const writeUser = String(req.body.ad_write_user || '').trim().slice(0, 255);
  const enabled = req.body.ad_writes_enabled === '1';
  try {
    await adChangeService.verifyReauth(req);
    const current = await adWriteService.config();
    const newPassword = req.body.ad_write_password ? String(req.body.ad_write_password) : '';
    const pairs = { ad_writes_enabled: enabled ? '1' : '0', ad_managed_ous: managedOus.join('\n'), ad_write_user: writeUser };
    if (newPassword) pairs.ad_write_password = newPassword;
    if (!writeUser) pairs.ad_write_password = '';
    if (enabled) {
      if (!managedOus.length) throw new Error('Indique al menos una unidad organizativa gestionada.');
      const password = writeUser ? (newPassword || (writeUser === current.writeUser ? (await settingsService.getAll()).ad_write_password : ''))
        : (await adService.config()).password;
      if (writeUser && !password) throw new Error('Falta la contraseña de la cuenta de escritura.');
      await adWriteService.testWrite({ ...current, managedOus, writeUser, bindUser: writeUser || current.readUser, password });
    }
    await settingsService.setMany(pairs);
    delete req.session.adWriteDraft; // lo guardado manda: no se muestra un borrador de un intento anterior
    await auditService.log(req, { user: req.session.user, action: 'ad_configuracion_escritura', target: 'directorio activo',
      detail: `${enabled ? 'cambios encendidos' : 'cambios apagados'}; cuenta ${writeUser || '(la de lectura)'}${newPassword ? ', contraseña cambiada' : ''}; OU: ${managedOus.join(' | ')}` });
    req.flash('success', enabled ? 'Cambios en el dominio encendidos: cuenta y unidades organizativas verificadas.' : 'Cambios en el dominio apagados.');
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', err.message);
    req.session.adWriteDraft = { enabled, managedOus, writeUser };
  }
  return res.redirect('/ad/configuracion');
});

router.post('/configuracion', isSuperAdmin, verifyCsrfToken, async (req, res, next) => {
  const clean = (v, max = 5000) => String(v || '').trim().slice(0, max);
  try {
    const current = await adService.config();
    const next = {
      url: clean(req.body.ad_url, 255), baseDn: clean(req.body.ad_base_dn, 700), bindUser: clean(req.body.ad_bind_user, 255),
      password: req.body.ad_bind_password ? String(req.body.ad_bind_password) : current.password,
      caPem: clean(req.body.ad_ca_pem, 20000), allDcs: req.body.ad_all_dcs === '1',
    };
    adService.validateConfig(next);
    // Se prueba ANTES de guardar: una conexion que no valida el certificado no se guarda.
    const test = await adService.test(next);
    const pairs = { ad_url: next.url, ad_base_dn: next.baseDn, ad_bind_user: next.bindUser, ad_ca_pem: next.caPem, ad_all_dcs: next.allDcs ? '1' : '0' };
    if (req.body.ad_bind_password) pairs.ad_bind_password = next.password;
    await settingsService.setMany(pairs);
    await auditService.log(req, { user: req.session.user, action: 'ad_configuracion', target: next.url,
      detail: `cuenta ${next.bindUser}${req.body.ad_bind_password ? ', contraseña cambiada' : ''}; certificado ${test.cert && test.cert.subject} vence ${test.cert && test.cert.validTo ? test.cert.validTo.toISOString().slice(0, 10) : '?'}` });
    req.flash('success', `Conexión verificada y guardada: ${test.dc} (${test.baseDn}).`);
    res.redirect('/ad/configuracion');
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', err.message);
    res.redirect('/ad/configuracion');
  }
});

module.exports = router;
