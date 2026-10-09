// Directorio activo, fase 2: CAMBIOS en el dominio (escritura LDAP).
// Va aparte de adService.js (que solo lee) a proposito: la lectura no puede
// escribir, y todo lo que escribe pasa por aqui.
//
// Capas de seguridad (ademas de las de la conexion: LDAPS con la CA validada):
//   - Interruptor general (ad_writes_enabled) apagado por defecto.
//   - Cuenta de ESCRITURA propia (ad_write_user), delegada solo sobre las
//     unidades organizativas que se gestionan; nunca administrador del dominio.
//   - Solo se toca lo que esta dentro de las OU gestionadas (ad_managed_ous).
//   - Nunca se toca una cuenta o grupo privilegiado: se comprueba EN VIVO al
//     ejecutar (grupos privilegiados por SID, incluidos los anidados y el grupo
//     primario), ni objetos criticos del sistema, integrados (RID < 1000),
//     con adminCount=1, controladores de dominio ni las cuentas de servicio
//     de esta aplicacion.
//   - Las contrasenas se generan aqui (nadie las escribe) y no se guardan en
//     claro (ver adChangeService: se muestran una sola vez).
// Quien puede ejecutar y quien debe pedir aprobacion: adChangeService.js.
const crypto = require('crypto');
const { Change, Attribute, Control, EqualityFilter, AndFilter } = require('ldapts');
const settingsService = require('./settingsService');
const adService = require('./adService');

const { connect, search, str, list, sidOf, guidOf, parentDn, rdnValue, escapeDn, parseDnsRecord, UAC, IN_CHAIN, SHOW_DELETED } = adService._;
const TREE_DELETE = '1.2.840.113556.1.4.805';
const RODC = 0x04000000;

// Operaciones. "group" agrupa las operaciones para los permisos temporales;
// "target" es lo que se elige en pantalla (para crear: la OU de destino).
const OPS = {
  user_create: { label: 'Crear usuario', target: 'ou', group: 'crear', icon: 'bi-person-plus' },
  user_update: { label: 'Modificar datos del usuario', target: 'usuario', group: 'modificar', icon: 'bi-pencil' },
  user_move: { label: 'Mover usuario a otra unidad organizativa', target: 'usuario', group: 'modificar', icon: 'bi-folder-symlink' },
  user_disable: { label: 'Deshabilitar usuario', target: 'usuario', group: 'bloquear', icon: 'bi-person-slash', bulk: true },
  user_enable: { label: 'Habilitar usuario', target: 'usuario', group: 'bloquear', icon: 'bi-person-check', bulk: true },
  user_unlock: { label: 'Desbloquear usuario', target: 'usuario', group: 'bloquear', icon: 'bi-unlock', bulk: true },
  user_reset_password: { label: 'Restablecer contraseña', target: 'usuario', group: 'contrasenas', icon: 'bi-key' },
  user_delete: { label: 'Eliminar usuario', target: 'usuario', group: 'eliminar', icon: 'bi-trash', bulk: true, danger: true },
  group_create: { label: 'Crear grupo', target: 'ou', group: 'grupos', icon: 'bi-people' },
  group_add_member: { label: 'Agregar miembro a un grupo', target: 'grupo', group: 'grupos', icon: 'bi-person-plus' },
  group_remove_member: { label: 'Quitar miembro de un grupo', target: 'grupo', group: 'grupos', icon: 'bi-person-dash' },
  group_delete: { label: 'Eliminar grupo', target: 'grupo', group: 'eliminar', icon: 'bi-trash', danger: true },
  computer_create: { label: 'Crear equipo', target: 'ou', group: 'equipos', icon: 'bi-pc-display' },
  computer_disable: { label: 'Deshabilitar equipo', target: 'equipo', group: 'equipos', icon: 'bi-slash-circle', bulk: true },
  computer_enable: { label: 'Habilitar equipo', target: 'equipo', group: 'equipos', icon: 'bi-check-circle', bulk: true },
  computer_delete: { label: 'Eliminar equipo y sus registros DNS', target: 'equipo', group: 'eliminar', icon: 'bi-trash', bulk: true, danger: true },
  ou_create: { label: 'Crear unidad organizativa', target: 'ou', group: 'crear', icon: 'bi-folder-plus' },
  object_restore: { label: 'Restaurar de la papelera', target: 'eliminado', group: 'restaurar', icon: 'bi-arrow-counterclockwise' },
};
const GROUPS = {
  crear: 'Crear usuarios y unidades organizativas',
  modificar: 'Modificar datos y mover usuarios',
  bloquear: 'Deshabilitar, habilitar y desbloquear usuarios',
  contrasenas: 'Restablecer contraseñas',
  grupos: 'Crear grupos y cambiar sus miembros',
  equipos: 'Crear, deshabilitar y habilitar equipos',
  eliminar: 'Eliminar usuarios, grupos y equipos',
  restaurar: 'Restaurar de la papelera',
};
// Datos del usuario que se pueden modificar (nada de seguridad: ni UPN, ni
// SID, ni banderas de cuenta, ni miembros).
const USER_FIELDS = {
  givenName: 'Nombres', sn: 'Apellidos', displayName: 'Nombre para mostrar', mail: 'Correo', title: 'Cargo', department: 'Área',
  company: 'Empresa', physicalDeliveryOfficeName: 'Oficina / sede', telephoneNumber: 'Teléfono', description: 'Descripción', employeeID: 'DNI (employeeID)',
};
const GROUP_TYPES = { global: 0x2, local: 0x4, universal: 0x8 };

// ------------------------------ configuracion ------------------------------
async function config() {
  const base = await adService.config();
  const s = await settingsService.getAll();
  const managedOus = String(s.ad_managed_ous || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const writeUser = String(s.ad_write_user || '').trim();
  return {
    ...base, enabled: s.ad_writes_enabled === '1', managedOus, writeUser, hasWritePassword: !!s.ad_write_password, readUser: base.bindUser,
    // La conexion de escritura usa su propia cuenta; sin ella, la de lectura.
    bindUser: writeUser || base.bindUser, password: writeUser ? (s.ad_write_password || '') : base.password,
  };
}

// Por que no se puede escribir (o null si se puede).
function notReady(cfg) {
  if (!cfg.url || !cfg.caPem || !cfg.readUser) return 'El directorio activo no está conectado.';
  if (!cfg.enabled) return 'Los cambios en el dominio están apagados (Conexión → Cambios en el dominio).';
  if (!cfg.managedOus.length) return 'No hay unidades organizativas gestionadas configuradas.';
  if (!cfg.bindUser || !cfg.password) return 'Falta la cuenta de escritura o su contraseña.';
  return null;
}

const lower = (s) => String(s || '').toLowerCase();
const under = (dn, parent) => lower(dn) === lower(parent) || lower(dn).endsWith(`,${lower(parent)}`);
const inManaged = (managedOus, dn) => managedOus.some((ou) => under(dn, ou));

// Valor de un RDN escapado (RFC 4514).
function escapeRdn(v) {
  return String(v).replace(/[,+"\\<>;=]/g, (c) => `\\${c}`).replace(/^([ #])/, '\\$1').replace(/ $/, '\\ ');
}
const firstRdn = (dn) => { const i = String(dn).search(/(?<!\\),/); return i > -1 ? String(dn).slice(0, i) : String(dn); };

// GUID en texto -> filtro LDAP binario (orden de bytes de AD). Va como
// objeto con un Buffer: en un filtro de texto, ldapts pasa los bytes
// escapados a UTF-8 y los mayores a 0x7F no coinciden nunca.
function guidFilter(guid) {
  const h = String(guid).replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) throw new Error('Identificador de objeto inválido.');
  const le = (s) => s.match(/../g).reverse().join('');
  return new EqualityFilter({ attribute: 'objectGUID', value: Buffer.from(le(h.slice(0, 8)) + le(h.slice(8, 12)) + le(h.slice(12, 16)) + h.slice(16), 'hex') });
}

// Contrasena aleatoria que cumple la complejidad de AD y no contiene el
// nombre de la cuenta ni partes del nombre.
const SETS = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#$%*+-=?@_'];
function generatePassword(length = 16, avoid = []) {
  const all = SETS.join('');
  const words = avoid.flatMap((a) => String(a || '').split(/[\s.,_-]+/)).filter((w) => w.length >= 3).map(lower);
  for (;;) {
    const chars = SETS.map((s) => s[crypto.randomInt(s.length)]);
    while (chars.length < length) chars.push(all[crypto.randomInt(all.length)]);
    for (let i = chars.length - 1; i > 0; i -= 1) {
      const j = crypto.randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    const p = chars.join('');
    if (!words.some((w) => lower(p).includes(w))) return p;
  }
}
const unicodePwd = (p) => Buffer.from(`"${p}"`, 'utf16le');
const replace = (type, values) => new Change({ operation: 'replace', modification: new Attribute({ type, values }) });

function explainWrite(err) {
  const code = err && err.code;
  const m = String((err && err.message) || err);
  if (code === 50 || /InsufficientAccess|insufficient access/i.test(m)) {
    return 'El dominio negó el permiso a la cuenta de escritura: revise la delegación sobre esa unidad organizativa.';
  }
  if (code === 68 || /EntryAlreadyExists|already exists/i.test(m)) return 'Ya existe un objeto con ese nombre en esa ubicación.';
  if (code === 32 || /NoSuchObject/i.test(m)) return 'El objeto ya no existe en el dominio (puede que alguien lo haya cambiado: vuelva a leer el dominio).';
  if (code === 19 || code === 53 || /unicodePwd|password|0000052D/i.test(m)) {
    if (/0000052D|password|unicodePwd/i.test(m)) return 'El dominio no aceptó la contraseña (política de contraseñas: longitud, historial o complejidad).';
    return `El dominio no aceptó el cambio: ${m}`;
  }
  if (code === 66 || /NotAllowedOnNonLeaf/i.test(m)) return 'Tiene objetos dentro: no se puede eliminar así.';
  return `Error LDAP: ${m}`;
}

// ------------------------------ conexion de escritura ------------------------------
async function open(cfg) {
  const client = await connect(cfg);
  try {
    const [root] = await search(client, '', { scope: 'base', paged: false, attributes: ['defaultNamingContext'] });
    const base = cfg.baseDn || str(root.defaultNamingContext, 700);
    const [dom] = await search(client, base, { scope: 'base', paged: false, explicitBufferAttributes: ['objectSid'], attributes: ['objectSid'] });
    const domainSid = sidOf(dom.objectSid);
    const domainDns = base.split(',').map((p) => p.replace(/^DC=/i, '')).join('.').toLowerCase();
    const privSids = new Set(adService.PRIVILEGED.filter((p) => p.sid || p.rid).map((p) => p.sid || `${domainSid}-${p.rid}`));
    return { client, cfg, base, domainSid, domainDns, privSids };
  } catch (err) {
    await client.unbind().catch(() => {});
    throw err;
  }
}

const OBJ_ATTRS = ['objectGUID', 'objectSid', 'objectClass', 'distinguishedName', 'sAMAccountName', 'userPrincipalName', 'cn', 'displayName',
  'userAccountControl', 'adminCount', 'isCriticalSystemObject', 'primaryGroupID', 'dNSHostName', 'groupType', 'givenName', 'sn'];

async function findByGuid(ctx, guid, extra = []) {
  const [e] = await search(ctx.client, ctx.base, { filter: guidFilter(guid), explicitBufferAttributes: ['objectGUID', 'objectSid'], attributes: [...OBJ_ATTRS, ...extra] });
  if (!e) throw new Error('El objeto ya no existe en el dominio (o se movió fuera de su alcance). Vuelva a leer el dominio.');
  return e;
}

const classesOf = (e) => list(e.objectClass).map(lower);
const kindOf = (e) => {
  const c = classesOf(e);
  if (c.includes('computer')) return 'equipo';
  if (c.includes('user')) return 'usuario';
  if (c.includes('group')) return 'grupo';
  if (c.includes('organizationalunit')) return 'ou';
  return c[c.length - 1] || 'objeto';
};

// Motivos por los que un objeto NO se puede tocar (lista vacia = se puede).
// checkOu=false para los miembros que se agregan o quitan de un grupo (se
// cambia el grupo, no la cuenta), pero aun asi nunca una cuenta privilegiada.
async function protection(ctx, e, { checkOu = true } = {}) {
  const reasons = [];
  if (checkOu && !inManaged(ctx.cfg.managedOus, e.dn)) reasons.push('Está fuera de las unidades organizativas gestionadas.');
  if (lower(str(e.isCriticalSystemObject)) === 'true') reasons.push('Es un objeto crítico del sistema.');
  const sid = sidOf(e.objectSid);
  const rid = sid ? Number(sid.split('-').pop()) : null;
  if (rid !== null && rid < 1000) reasons.push('Es una cuenta o grupo integrado del dominio.');
  if (str(e.adminCount) === '1') reasons.push('Tiene adminCount=1: es o fue una cuenta privilegiada (protegida por AdminSDHolder).');
  const uac = Number(str(e.userAccountControl) || 0);
  if (uac & UAC.SERVER_TRUST || uac & RODC) reasons.push('Es un controlador de dominio.');
  const sam = lower(str(e.sAMAccountName));
  const own = [ctx.cfg.readUser, ctx.cfg.writeUser].filter(Boolean).map((u) => lower(u).split('@')[0].split('\\').pop());
  if (sam && own.includes(sam)) reasons.push('Es una cuenta de servicio de esta aplicación.');
  if (sid && ctx.privSids.has(sid)) reasons.push('Es un grupo privilegiado.');
  if (lower(str(e.sAMAccountName)) === 'dnsadmins') reasons.push('Es el grupo de administradores de DNS.');
  const pg = str(e.primaryGroupID);
  if (pg && ctx.privSids.has(`${ctx.domainSid}-${pg}`)) reasons.push('Su grupo primario es privilegiado.');
  // Grupos a los que pertenece, incluidos los anidados.
  const chain = await search(ctx.client, ctx.base, { filter: `(&(objectClass=group)(member:${IN_CHAIN}:=${escapeDn(e.dn)}))`,
    explicitBufferAttributes: ['objectSid'], attributes: ['objectSid', 'cn', 'sAMAccountName'] });
  const priv = chain.filter((g) => ctx.privSids.has(sidOf(g.objectSid)) || lower(str(g.sAMAccountName)) === 'dnsadmins');
  if (priv.length) reasons.push(`Tiene privilegios de administración por: ${priv.map((g) => str(g.cn)).join(', ')}.`);
  return reasons;
}

async function guard(ctx, e, opts) {
  const reasons = await protection(ctx, e, opts);
  if (reasons.length) throw new Error(`Objeto protegido (solo lectura): ${reasons.join(' ')}`);
}

// OU de destino para crear o mover: existe y esta dentro de las gestionadas.
async function destinationOu(ctx, guid) {
  const ou = await findByGuid(ctx, guid);
  if (!['ou', 'container'].includes(kindOf(ou)) && !classesOf(ou).includes('container')) throw new Error('El destino no es una unidad organizativa.');
  if (!inManaged(ctx.cfg.managedOus, ou.dn)) throw new Error('La unidad organizativa de destino no está entre las gestionadas.');
  return ou;
}

async function exists(ctx, filter) {
  const r = await search(ctx.client, ctx.base, { filter, attributes: ['distinguishedName'] });
  return r.length > 0;
}

// ------------------------------ validacion de parametros ------------------------------
const clean = (v, max = 255) => String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const SAM_USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;
const COMPUTER = /^(?!\d+$)[A-Za-z0-9][A-Za-z0-9-]{0,14}$/;
const NAME = /^[^"\/\\[\]:;|=,+*?<>@]{1,64}$/;

// Normaliza y valida lo que llega del formulario segun la operacion.
// Devuelve solo datos no secretos (se guardan en la solicitud).
function validateParams(op, p = {}) {
  const out = {};
  switch (op) {
    case 'user_create': {
      out.givenName = clean(p.givenName, 64);
      out.sn = clean(p.sn, 64);
      out.sam = clean(p.sam, 20).toLowerCase();
      out.displayName = clean(p.displayName, 255) || `${out.givenName} ${out.sn}`.trim();
      if (!out.givenName || !out.sn) throw new Error('Nombres y apellidos son obligatorios.');
      if (!SAM_USER.test(out.sam)) throw new Error('El usuario (sAMAccountName) debe tener hasta 20 caracteres: letras, números, punto, guion o guion bajo.');
      if (!NAME.test(out.displayName)) throw new Error('El nombre para mostrar tiene caracteres no permitidos.');
      ['mail', 'title', 'department', 'description', 'employeeID'].forEach((k) => { const v = clean(p[k], k === 'description' ? 500 : 150); if (v) out[k] = v; });
      if (out.mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.mail)) throw new Error('El correo no es válido.');
      if (out.employeeID && !/^[0-9A-Za-z-]{4,20}$/.test(out.employeeID)) throw new Error('El DNI (employeeID) no es válido.');
      out.mustChange = p.mustChange !== false && p.mustChange !== '0';
      break;
    }
    case 'user_update': {
      const changes = p.changes || {};
      Object.keys(changes).forEach((k) => {
        if (!USER_FIELDS[k]) throw new Error(`No se puede modificar el atributo ${k}.`);
        out[k] = { from: clean(changes[k].from, 500), to: clean(changes[k].to, k === 'description' ? 500 : 255) };
      });
      if (!Object.keys(out).length) throw new Error('No hay cambios: modifique al menos un dato.');
      if (out.mail && out.mail.to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.mail.to)) throw new Error('El correo no es válido.');
      return { changes: out };
    }
    case 'user_reset_password':
      out.mustChange = p.mustChange !== false && p.mustChange !== '0';
      out.unlock = p.unlock !== false && p.unlock !== '0';
      break;
    case 'user_move':
      if (!p.toOuGuid) throw new Error('Elija la unidad organizativa de destino.');
      out.toOuGuid = clean(p.toOuGuid, 36);
      out.toOuDn = clean(p.toOuDn, 700);
      break;
    case 'group_create':
      out.name = clean(p.name, 64);
      if (!NAME.test(out.name)) throw new Error('El nombre del grupo es obligatorio y no puede tener " / \\ [ ] : ; | = , + * ? < > @.');
      out.scope = GROUP_TYPES[p.scope] ? p.scope : 'global';
      out.kind = p.kind === 'distribucion' ? 'distribucion' : 'seguridad';
      out.description = clean(p.description, 500);
      break;
    case 'group_add_member':
    case 'group_remove_member':
      if (!p.memberGuid) throw new Error('Elija el miembro.');
      out.memberGuid = clean(p.memberGuid, 36);
      out.memberLabel = clean(p.memberLabel, 255);
      break;
    case 'computer_create':
      out.name = clean(p.name, 15).toUpperCase();
      if (!COMPUTER.test(out.name)) throw new Error('El nombre del equipo debe tener hasta 15 caracteres: letras, números y guion (no solo números).');
      out.description = clean(p.description, 500);
      break;
    case 'ou_create':
      out.name = clean(p.name, 64);
      if (!NAME.test(out.name)) throw new Error('El nombre de la unidad organizativa tiene caracteres no permitidos.');
      out.description = clean(p.description, 500);
      break;
    default:
      if (!OPS[op]) throw new Error('Operación desconocida.');
  }
  return out;
}

// ------------------------------ ejecucion ------------------------------
async function setUac(ctx, e, bit, on) {
  const uac = Number(str(e.userAccountControl) || 0);
  const next = on ? uac | bit : uac & ~bit;
  if (next !== uac) await ctx.client.modify(e.dn, [replace('userAccountControl', [String(next)])]);
  return next !== uac;
}

async function deleteObject(ctx, dn) {
  try {
    await ctx.client.del(dn);
  } catch (err) {
    // Usuarios o equipos con objetos dentro (dispositivos, BitLocker): borrar el arbol.
    if (err.code === 66 || /NotAllowedOnNonLeaf/i.test(String(err.message))) await ctx.client.del(dn, [new Control(TREE_DELETE, { critical: true })]);
    else throw err;
  }
}

// Registros DNS (integrado en AD) del equipo: el nodo con su nombre en la
// zona del dominio y los PTR de las zonas inversas que apuntan a el.
async function dnsNodesFor(ctx, host) {
  const fqdn = lower(host).replace(/\.$/, '');
  const label = fqdn.split('.')[0];
  const zone = fqdn.slice(label.length + 1);
  const dnsBase = `DC=DomainDnsZones,${ctx.base}`;
  const out = [];
  const nodes = await search(ctx.client, dnsBase, { filter: `(&(objectClass=dnsNode)(name=${label.replace(/[\\*()\0]/g, '')}))`,
    explicitBufferAttributes: ['dnsRecord'], attributes: ['name', 'dnsRecord'] }).catch(() => []);
  nodes.filter((n) => lower(rdnValue(parentDn(n.dn))) === zone).forEach((n) => {
    out.push({ dn: n.dn, zone, name: label, records: list(n.dnsRecord).map(parseDnsRecord).filter(Boolean).map((r) => `${r.rtype} ${r.data || ''}`.trim()), ok: true });
  });
  const zones = await search(ctx.client, dnsBase, { filter: '(&(objectClass=dnsZone)(|(name=*.in-addr.arpa)(name=*.ip6.arpa)))', attributes: ['name'] }).catch(() => []);
  for (const z of zones) {
    const ptrs = await search(ctx.client, z.dn, { scope: 'one', filter: '(objectClass=dnsNode)', explicitBufferAttributes: ['dnsRecord'], attributes: ['name', 'dnsRecord'] }).catch(() => []);
    ptrs.forEach((n) => {
      const recs = list(n.dnsRecord).map(parseDnsRecord).filter(Boolean);
      const mine = recs.filter((r) => r.rtype === 'PTR' && lower(r.data).replace(/\.$/, '') === fqdn);
      if (mine.length) out.push({ dn: n.dn, zone: str(z.name), name: str(n.name), records: recs.map((r) => `${r.rtype} ${r.data || ''}`.trim()), ok: mine.length === recs.length });
    });
  }
  return out;
}

// Ejecuta una operacion. Devuelve { message, secret? }.
async function run(ctx, op, targetGuid, params) {
  const p = params || {};
  switch (op) {
    case 'user_create': {
      const ou = await destinationOu(ctx, targetGuid);
      const upn = `${p.sam}@${ctx.domainDns}`;
      if (await exists(ctx, `(|(sAMAccountName=${p.sam})(userPrincipalName=${upn}))`)) throw new Error(`Ya existe la cuenta ${p.sam} en el dominio.`);
      const dn = `CN=${escapeRdn(p.displayName)},${ou.dn}`;
      const attrs = { objectClass: ['top', 'person', 'organizationalPerson', 'user'], cn: p.displayName, sAMAccountName: p.sam, userPrincipalName: upn,
        givenName: p.givenName, sn: p.sn, displayName: p.displayName, userAccountControl: '514' };
      ['mail', 'title', 'department', 'description', 'employeeID'].forEach((k) => { if (p[k]) attrs[k] = p[k]; });
      // Se crea deshabilitada, luego la contrasena y recien ahi se habilita;
      // si algo falla despues de crearla, se borra (no quedan cuentas a medias).
      await ctx.client.add(dn, attrs);
      const secret = generatePassword(16, [p.sam, p.givenName, p.sn, p.displayName]);
      try {
        await ctx.client.modify(dn, [replace('unicodePwd', [unicodePwd(secret)])]);
        await ctx.client.modify(dn, [replace('userAccountControl', ['512']), ...(p.mustChange ? [replace('pwdLastSet', ['0'])] : [])]);
      } catch (err) {
        await ctx.client.del(dn).catch(() => {});
        throw err;
      }
      return { message: `Usuario ${p.sam} creado en ${ou.dn}${p.mustChange ? '; deberá cambiar la contraseña al entrar' : ''}.`, secret, dn };
    }
    case 'user_update': {
      const e = await findByGuid(ctx, targetGuid);
      if (kindOf(e) !== 'usuario') throw new Error('El objeto no es un usuario.');
      await guard(ctx, e);
      const changes = Object.entries(p.changes || {}).filter(([k]) => USER_FIELDS[k]).map(([k, v]) => replace(k, v.to ? [v.to] : []));
      if (!changes.length) throw new Error('No hay cambios.');
      await ctx.client.modify(e.dn, changes);
      return { message: `Datos de ${str(e.sAMAccountName)} actualizados: ${Object.keys(p.changes).map((k) => USER_FIELDS[k]).join(', ')}.` };
    }
    case 'user_move': {
      const e = await findByGuid(ctx, targetGuid);
      if (kindOf(e) !== 'usuario') throw new Error('El objeto no es un usuario.');
      await guard(ctx, e);
      const ou = await destinationOu(ctx, p.toOuGuid);
      if (lower(parentDn(e.dn)) === lower(ou.dn)) throw new Error('El usuario ya está en esa unidad organizativa.');
      await ctx.client.modifyDN(e.dn, `${firstRdn(e.dn)},${ou.dn}`);
      return { message: `${str(e.sAMAccountName)} movido a ${ou.dn}.` };
    }
    case 'user_disable':
    case 'user_enable':
    case 'computer_disable':
    case 'computer_enable': {
      const e = await findByGuid(ctx, targetGuid);
      const want = op.startsWith('user') ? 'usuario' : 'equipo';
      if (kindOf(e) !== want) throw new Error(`El objeto no es un ${want}.`);
      await guard(ctx, e);
      const disable = op.endsWith('disable');
      const changed = await setUac(ctx, e, UAC.DISABLED, disable);
      return { message: `${str(e.sAMAccountName)} ${changed ? (disable ? 'deshabilitado' : 'habilitado') : (disable ? 'ya estaba deshabilitado' : 'ya estaba habilitado')}.` };
    }
    case 'user_unlock': {
      const e = await findByGuid(ctx, targetGuid);
      if (kindOf(e) !== 'usuario') throw new Error('El objeto no es un usuario.');
      await guard(ctx, e);
      await ctx.client.modify(e.dn, [replace('lockoutTime', ['0'])]);
      return { message: `${str(e.sAMAccountName)} desbloqueado.` };
    }
    case 'user_reset_password': {
      const e = await findByGuid(ctx, targetGuid);
      if (kindOf(e) !== 'usuario') throw new Error('El objeto no es un usuario.');
      await guard(ctx, e);
      const secret = generatePassword(16, [str(e.sAMAccountName), str(e.displayName), str(e.givenName), str(e.sn)]);
      await ctx.client.modify(e.dn, [replace('unicodePwd', [unicodePwd(secret)])]);
      const after = [];
      if (p.mustChange) after.push(replace('pwdLastSet', ['0']));
      if (p.unlock) after.push(replace('lockoutTime', ['0']));
      if (after.length) await ctx.client.modify(e.dn, after);
      return { message: `Contraseña de ${str(e.sAMAccountName)} restablecida${p.mustChange ? '; deberá cambiarla al entrar' : ''}${p.unlock ? '; cuenta desbloqueada' : ''}.`, secret };
    }
    case 'user_delete':
    case 'group_delete': {
      const e = await findByGuid(ctx, targetGuid);
      const want = op === 'user_delete' ? 'usuario' : 'grupo';
      if (kindOf(e) !== want) throw new Error(`El objeto no es un ${want}.`);
      await guard(ctx, e);
      await deleteObject(ctx, e.dn);
      return { message: `${want === 'usuario' ? 'Usuario' : 'Grupo'} ${str(e.sAMAccountName)} eliminado (queda en la papelera de AD si está habilitada).` };
    }
    case 'group_create': {
      const ou = await destinationOu(ctx, targetGuid);
      if (await exists(ctx, `(sAMAccountName=${p.name.replace(/[\\*()\0]/g, '')})`)) throw new Error(`Ya existe una cuenta o grupo llamado ${p.name}.`);
      const gt = GROUP_TYPES[p.scope] | (p.kind === 'seguridad' ? 0x80000000 : 0);
      await ctx.client.add(`CN=${escapeRdn(p.name)},${ou.dn}`, { objectClass: ['top', 'group'], cn: p.name, sAMAccountName: p.name,
        groupType: String(gt | 0), ...(p.description ? { description: p.description } : {}) });
      return { message: `Grupo ${p.name} (${p.kind}, ${p.scope}) creado en ${ou.dn}.` };
    }
    case 'group_add_member':
    case 'group_remove_member': {
      const g = await findByGuid(ctx, targetGuid);
      if (kindOf(g) !== 'grupo') throw new Error('El objeto no es un grupo.');
      await guard(ctx, g);
      const m = await findByGuid(ctx, p.memberGuid);
      if (!['usuario', 'equipo'].includes(kindOf(m))) throw new Error('Solo se agregan o quitan usuarios y equipos (no grupos anidados).');
      await guard(ctx, m, { checkOu: false });
      const add = op === 'group_add_member';
      try {
        await ctx.client.modify(g.dn, [new Change({ operation: add ? 'add' : 'delete', modification: new Attribute({ type: 'member', values: [m.dn] }) })]);
      } catch (err) {
        if (add && (err.code === 20 || /AttributeOrValueExists|already/i.test(String(err.message)))) return { message: `${str(m.sAMAccountName)} ya era miembro de ${str(g.cn)}.` };
        if (!add && (err.code === 16 || /NoSuchAttribute/i.test(String(err.message)))) return { message: `${str(m.sAMAccountName)} no era miembro de ${str(g.cn)}.` };
        throw err;
      }
      return { message: `${str(m.sAMAccountName)} ${add ? 'agregado a' : 'quitado de'} ${str(g.cn)}.` };
    }
    case 'computer_create': {
      const ou = await destinationOu(ctx, targetGuid);
      if (await exists(ctx, `(sAMAccountName=${p.name}$)`)) throw new Error(`Ya existe el equipo ${p.name} en el dominio.`);
      // Cuenta de equipo "pre-creada" (WORKSTATION_TRUST_ACCOUNT | PASSWD_NOTREQD), como la crea la consola.
      await ctx.client.add(`CN=${p.name},${ou.dn}`, { objectClass: ['top', 'person', 'organizationalPerson', 'user', 'computer'], cn: p.name,
        sAMAccountName: `${p.name}$`, userAccountControl: '4128', dNSHostName: `${p.name.toLowerCase()}.${ctx.domainDns}`,
        ...(p.description ? { description: p.description } : {}) });
      return { message: `Equipo ${p.name} creado en ${ou.dn}. Ya puede unirse al dominio con ese nombre.` };
    }
    case 'computer_delete': {
      const e = await findByGuid(ctx, targetGuid);
      if (kindOf(e) !== 'equipo') throw new Error('El objeto no es un equipo.');
      await guard(ctx, e);
      const host = str(e.dNSHostName) || `${str(e.cn)}.${ctx.domainDns}`;
      const nodes = await dnsNodesFor(ctx, host);
      await deleteObject(ctx, e.dn);
      const done = [];
      const failed = [];
      for (const n of nodes) {
        if (!n.ok) { failed.push(`${n.name}.${n.zone} (tiene otros registros: revíselo a mano)`); continue; }
        try {
          await ctx.client.del(n.dn);
          done.push(`${n.name}.${n.zone} [${n.records.join(', ')}]`);
        } catch (err) {
          failed.push(`${n.name}.${n.zone}: ${explainWrite(err)}`);
        }
      }
      return { message: `Equipo ${str(e.cn)} eliminado de ${parentDn(e.dn)}. DNS: ${done.length ? `borrado ${done.join('; ')}` : 'sin registros'}`
        + `${failed.length ? `. AVISO, quedó en el DNS: ${failed.join('; ')}` : ''}.`, warning: failed.length > 0 };
    }
    case 'ou_create': {
      const parent = await destinationOu(ctx, targetGuid);
      await ctx.client.add(`OU=${escapeRdn(p.name)},${parent.dn}`, { objectClass: ['top', 'organizationalUnit'], ou: p.name,
        ...(p.description ? { description: p.description } : {}) });
      return { message: `Unidad organizativa ${p.name} creada en ${parent.dn}.` };
    }
    case 'object_restore': {
      const sd = [new Control(SHOW_DELETED, { critical: true })];
      const [d] = await search(ctx.client, `CN=Deleted Objects,${ctx.base}`, { scope: 'one', filter: new AndFilter({ filters: [new EqualityFilter({ attribute: 'isDeleted', value: 'TRUE' }), guidFilter(targetGuid)] }),
        explicitBufferAttributes: ['objectGUID', 'objectSid'], attributes: [...OBJ_ATTRS, 'lastKnownParent', 'msDS-LastKnownRDN'] }, sd);
      if (!d) throw new Error('El objeto ya no está en la papelera (o la cuenta de escritura no puede verla).');
      const parent = str(d.lastKnownParent, 700);
      if (!parent || !inManaged(ctx.cfg.managedOus, parent)) throw new Error('Estaba fuera de las unidades organizativas gestionadas: no se restaura desde aquí.');
      const sid = sidOf(d.objectSid);
      if (str(d.adminCount) === '1' || (sid && Number(sid.split('-').pop()) < 1000)) throw new Error('Objeto protegido (era una cuenta privilegiada o integrada).');
      // El nombre original: msDS-LastKnownRDN o, si el servidor no lo da, lo que esta antes de "\0ADEL:" en el DN.
      const rdnVal = str(d['msDS-LastKnownRDN'], 255) ? escapeRdn(str(d['msDS-LastKnownRDN'], 255)) : firstRdn(d.dn).replace(/^[^=]+=/, '').split('\\0A')[0];
      const rdnType = firstRdn(d.dn).split('=')[0];
      const newDn = `${rdnType}=${rdnVal},${parent}`;
      await ctx.client.modify(d.dn, [new Change({ operation: 'delete', modification: new Attribute({ type: 'isDeleted', values: [] }) }),
        replace('distinguishedName', [newDn])], sd);
      return { message: `${str(d.sAMAccountName) || rdnVal} restaurado en ${parent}. Revise si quedó habilitado y en sus grupos.` };
    }
    default:
      throw new Error('Operación desconocida.');
  }
}

// Ejecuta varias operaciones con una sola conexion. items: [{ op, targetGuid, params }].
// Devuelve [{ ok, message, secret?, warning? }] en el mismo orden.
async function executeMany(items) {
  const cfg = await config();
  const why = notReady(cfg);
  if (why) throw new Error(why);
  const ctx = await open(cfg);
  const results = [];
  try {
    for (const it of items) {
      try {
        if (!OPS[it.op]) throw new Error('Operación desconocida.');
        results.push({ ok: true, ...(await run(ctx, it.op, it.targetGuid, it.params)) });
      } catch (err) {
        const m = err.code !== undefined ? explainWrite(err) : err.message;
        results.push({ ok: false, message: m });
      }
    }
  } finally {
    await ctx.client.unbind().catch(() => {});
  }
  scheduleResync();
  return results;
}

// Prueba la cuenta de escritura (solo inicia sesion y lee la raiz) y que las OU gestionadas existan.
// Que puede crear la cuenta en cada OU, segun el propio DC: el atributo
// calculado allowedChildClassesEffective, leido CON la cuenta de escritura.
// No escribe nada. Devuelve [{ dn, classes }] solo de las OU con algo delegado.
const DELEGATION_CLASSES = ['user', 'group', 'computer', 'organizationalunit'];
async function delegatedOus(ctx) {
  const rows = await search(ctx.client, ctx.base, { filter: '(objectClass=organizationalUnit)', attributes: ['distinguishedName', 'allowedChildClassesEffective'] });
  return rows.map((e) => ({ dn: str(e.distinguishedName || e.dn, 700), classes: list(e.allowedChildClassesEffective).map(lower).filter((c) => DELEGATION_CLASSES.includes(c)) }))
    .filter((o) => o.classes.length);
}

async function detectDelegation(cfgIn) {
  const ctx = await open(cfgIn);
  try {
    return { baseDn: ctx.base, ous: await delegatedOus(ctx) };
  } finally {
    await ctx.client.unbind().catch(() => {});
  }
}

async function testWrite(cfgIn) {
  const ctx = await open(cfgIn);
  try {
    const missing = [];
    for (const dn of cfgIn.managedOus) {
      if (!under(dn, ctx.base)) { missing.push(`${dn} (no es de este dominio)`); continue; }
      const r = await search(ctx.client, dn, { scope: 'base', paged: false, attributes: ['objectClass'] }).catch(() => []);
      if (!r.length) missing.push(dn);
    }
    if (missing.length) throw new Error(`Estas unidades organizativas no existen o la cuenta no las ve: ${missing.join('; ')}`);
    // Si el DC informa la delegacion, toda OU elegida debe tenerla (si no, cada cambio fallaria ahi).
    const delegated = await delegatedOus(ctx).catch(() => null);
    if (delegated && delegated.length) {
      const set = new Set(delegated.map((o) => lower(o.dn)));
      const without = cfgIn.managedOus.filter((dn) => !set.has(lower(dn)));
      if (without.length) throw new Error(`La cuenta de escritura no tiene control delegado en: ${without.join('; ')}. Quítelas o delegue en ellas (scripts/windows/ad-cuenta-servicio.ps1).`);
    }
    return { baseDn: ctx.base };
  } finally {
    await ctx.client.unbind().catch(() => {});
  }
}

// Datos actuales de un objeto (para el formulario de modificar): lectura con la cuenta de lectura.
async function readLive(guid, attributes) {
  const cfg = await adService.config();
  const client = await connect(cfg);
  try {
    const [root] = await search(client, '', { scope: 'base', paged: false, attributes: ['defaultNamingContext'] });
    const base = cfg.baseDn || str(root.defaultNamingContext, 700);
    const [e] = await search(client, base, { filter: guidFilter(guid), attributes });
    return e ? Object.fromEntries(attributes.map((a) => [a, str(e[a], 1000) || ''])) : null;
  } finally {
    await client.unbind().catch(() => {});
  }
}

// Despues de cambiar algo, se vuelve a leer el dominio (en segundo plano, una vez).
const options = { autoResync: true };
let resyncTimer = null;
let resyncing = null;
function scheduleResync() {
  if (!options.autoResync) return;
  clearTimeout(resyncTimer);
  resyncTimer = setTimeout(() => {
    if (resyncing) { scheduleResync(); return; }
    resyncing = adService.sync().catch((err) => console.error('[ad] Error al releer el dominio tras un cambio:', err.message)).finally(() => { resyncing = null; });
  }, 2000);
  if (resyncTimer.unref) resyncTimer.unref();
}

module.exports = {
  OPS, GROUPS, USER_FIELDS, GROUP_TYPES, options, config, notReady, inManaged, under, validateParams, executeMany, testWrite, detectDelegation, readLive, generatePassword,
  _: { guidFilter, escapeRdn, firstRdn, explainWrite },
};
