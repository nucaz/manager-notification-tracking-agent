// Directorio activo (fase 1: SOLO LECTURA). Lee el dominio por LDAPS y
// guarda una foto en ad_* (ver sql/migrations/0033_directorio_activo.sql).
//
// Capas de seguridad de la conexion:
//   - Solo ldaps:// (puerto 636). Se rechaza ldap:// en claro.
//   - El certificado del DC se valida SIEMPRE contra la CA configurada
//     (PEM de la CA interna) y el nombre del servidor; no hay opcion de
//     "aceptar cualquier certificado". TLS 1.2 como minimo.
//   - Cuenta de servicio propia, sin privilegios de administrador para esta
//     fase (leer el directorio lo puede cualquier usuario autenticado; la
//     papelera necesita "Listar contenido" delegado en CN=Deleted Objects).
//   - La contrasena se guarda cifrada (settings, ad_bind_password) y solo la
//     configura un superadministrador.
//   - Esta fase no escribe nada en el dominio.
const crypto = require('crypto');
const tls = require('tls');
const { Client, Control } = require('ldapts');
const pool = require('../db/pool');
const settingsService = require('./settingsService');

const SHOW_DELETED = '1.2.840.113556.1.4.417';
const IN_CHAIN = '1.2.840.113556.1.4.1941';
const UAC = { DISABLED: 0x2, LOCKOUT: 0x10, DONT_EXPIRE_PASSWD: 0x10000, SERVER_TRUST: 0x2000 };

// Grupos privilegiados conocidos, por SID (los nombres cambian con el idioma).
const PRIVILEGED = [
  { key: 'domain_admins', rid: 512, label: 'Administradores del dominio' },
  { key: 'enterprise_admins', rid: 519, label: 'Administradores de empresa' },
  { key: 'schema_admins', rid: 518, label: 'Administradores de esquema' },
  { key: 'gpo_creators', rid: 520, label: 'Propietarios del creador de directivas de grupo' },
  { key: 'key_admins', rid: 526, label: 'Administradores de claves' },
  { key: 'enterprise_key_admins', rid: 527, label: 'Administradores de claves de empresa' },
  { key: 'administrators', sid: 'S-1-5-32-544', label: 'Administradores (integrado)' },
  { key: 'account_operators', sid: 'S-1-5-32-548', label: 'Operadores de cuentas' },
  { key: 'server_operators', sid: 'S-1-5-32-549', label: 'Operadores de servidores' },
  { key: 'print_operators', sid: 'S-1-5-32-550', label: 'Operadores de impresión' },
  { key: 'backup_operators', sid: 'S-1-5-32-551', label: 'Operadores de copia de seguridad' },
  { key: 'dns_admins', sam: 'DnsAdmins', label: 'Administradores de DNS' },
];
const PRIVILEGED_LABEL = Object.fromEntries(PRIVILEGED.map((p) => [p.key, p.label]));

// ------------------------------ conversiones ------------------------------
const one = (v) => (Array.isArray(v) ? v[0] : v);
const list = (v) => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]));
const str = (v, max = 500) => { const x = one(v); return x === undefined || x === null || x === '' ? null : String(x).slice(0, max); };
const pad = (n) => String(n).padStart(2, '0');
const sqlDate = (d) => (d ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : null);

// FILETIME (intervalos de 100 ns desde 1601) -> fecha; 0 y el maximo = nunca.
function fileTime(v) {
  const s = str(v, 40);
  if (!s || !/^\d+$/.test(s) || s === '0' || s === '9223372036854775807') return null;
  const ms = Number(BigInt(s) / 10000n - 11644473600000n);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}
// GeneralizedTime "20261007120000.0Z" -> fecha.
function genTime(v) {
  const m = String(one(v) || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}
function guidOf(buf) {
  const b = Buffer.isBuffer(one(buf)) ? one(buf) : null;
  if (!b || b.length !== 16) return null;
  const h = b.toString('hex');
  const le = (s) => s.match(/../g).reverse().join('');
  return `${le(h.slice(0, 8))}-${le(h.slice(8, 12))}-${le(h.slice(12, 16))}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function sidOf(buf) {
  const b = Buffer.isBuffer(one(buf)) ? one(buf) : null;
  if (!b || b.length < 8) return null;
  const count = b[1];
  const auth = b.readUIntBE(2, 6);
  const subs = [];
  for (let i = 0; i < count; i += 1) subs.push(b.readUInt32LE(8 + i * 4));
  return `S-${b[0]}-${auth}${subs.map((x) => `-${x}`).join('')}`;
}
const parentDn = (dn) => { const i = String(dn).search(/(?<!\\),/); return i > -1 ? String(dn).slice(i + 1) : null; };
const rdnValue = (dn) => String(dn).split(/(?<!\\),/)[0].replace(/^[^=]+=/, '').replace(/\\(.)/g, '$1');

// Registro DNS de AD (atributo dnsRecord, estructura DNS_RPC_RECORD).
function dnsName(b, off) {
  // DNS_COUNT_NAME: longitud total, cantidad de etiquetas y cada etiqueta (largo + texto).
  const labels = b[off + 1];
  let p = off + 2;
  const parts = [];
  for (let i = 0; i < labels && p < b.length; i += 1) {
    const len = b[p];
    parts.push(b.slice(p + 1, p + 1 + len).toString('utf8'));
    p += 1 + len;
  }
  return parts.join('.');
}
function parseDnsRecord(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  const dataLength = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const ttl = buf.readUInt32BE(12);
  const stamp = buf.readUInt32LE(20); // horas desde 1601; 0 = estatico
  const d = buf.slice(24, 24 + dataLength);
  const types = { 1: 'A', 28: 'AAAA', 5: 'CNAME', 12: 'PTR', 2: 'NS', 15: 'MX', 33: 'SRV', 16: 'TXT', 6: 'SOA' };
  const rtype = types[type] || `TIPO${type}`;
  let data = null;
  try {
    if (type === 1 && d.length >= 4) data = [...d.slice(0, 4)].join('.');
    else if (type === 28 && d.length >= 16) data = d.toString('hex').match(/.{4}/g).map((x) => x.replace(/^0+(?=.)/, '')).join(':');
    else if (type === 5 || type === 12 || type === 2) data = dnsName(d, 0);
    else if (type === 15) data = `${d.readUInt16BE(0)} ${dnsName(d, 2)}`;
    else if (type === 33) data = `${d.readUInt16BE(0)} ${d.readUInt16BE(2)} ${d.readUInt16BE(4)} ${dnsName(d, 6)}`;
  } catch (_) { data = null; }
  const recordTs = stamp ? new Date(Date.UTC(1601, 0, 1) + stamp * 3600000) : null;
  return { rtype, data, ttl, recordTs };
}

// ------------------------------ configuracion ------------------------------
async function config() {
  const s = await settingsService.getAll();
  const clean = (v) => String(v || '').trim();
  return {
    url: clean(s.ad_url), baseDn: clean(s.ad_base_dn), bindUser: clean(s.ad_bind_user), password: s.ad_bind_password || '',
    caPem: clean(s.ad_ca_pem), allDcs: s.ad_all_dcs !== '0', lastSync: s.ad_last_sync || null, lastResult: s.ad_last_result || '',
  };
}

function validateConfig(cfg) {
  if (!/^ldaps:\/\/[A-Za-z0-9.-]+(:\d+)?$/i.test(cfg.url)) {
    throw new Error('La dirección debe ser ldaps://servidor[:636]. No se permite LDAP sin cifrar.');
  }
  if (!/-----BEGIN CERTIFICATE-----/.test(cfg.caPem)) throw new Error('Falta el certificado de la CA (PEM) para validar al controlador de dominio.');
  if (!cfg.bindUser || !cfg.password) throw new Error('Falta la cuenta de servicio o su contraseña.');
}

function hostOf(url) { return String(url).replace(/^ldaps:\/\//i, '').replace(/:\d+$/, ''); }

function tlsOptions(cfg, host) {
  return { ca: [cfg.caPem], servername: host, minVersion: 'TLSv1.2', rejectUnauthorized: true };
}

async function connect(cfg, url = cfg.url) {
  const host = hostOf(url);
  const client = new Client({ url, timeout: 30000, connectTimeout: 10000, tlsOptions: tlsOptions(cfg, host), strictDN: false });
  try {
    await client.bind(cfg.bindUser, cfg.password);
  } catch (err) {
    await client.unbind().catch(() => {});
    throw new Error(explain(err, host));
  }
  return client;
}

function explain(err, host) {
  const m = String(err && (err.code || err.message) || err);
  if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|timeout/i.test(m)) return `No se pudo conectar a ${host}:636 (red, firewall o nombre del servidor): ${err.message}`;
  if (/CERT|self.signed|UNABLE_TO|Hostname|altnames|unable to verify/i.test(m)) {
    return `El certificado de ${host} no se pudo validar con la CA configurada (o el nombre no coincide con el certificado): ${err.message}`;
  }
  if (/InvalidCredentials|49|data 52e|data 775|data 532|data 533/i.test(m)) {
    if (/data 775/.test(m)) return 'La cuenta de servicio está bloqueada en el dominio.';
    if (/data 532|data 773/.test(m)) return 'La contraseña de la cuenta de servicio venció: cámbiela en el dominio y aquí.';
    if (/data 533/.test(m)) return 'La cuenta de servicio está deshabilitada en el dominio.';
    return 'El dominio rechazó la cuenta de servicio o su contraseña.';
  }
  return `Error LDAP: ${err.message || m}`;
}

// Certificado que presenta el DC (para avisar antes de que venza).
function peerCertificate(cfg, url = cfg.url) {
  const host = hostOf(url);
  const port = Number((String(url).match(/:(\d+)$/) || [])[1] || 636);
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port, ...tlsOptions(cfg, host), timeout: 8000 }, () => {
      const c = sock.getPeerCertificate();
      resolve({ subject: c.subject && c.subject.CN, issuer: c.issuer && c.issuer.CN, validTo: c.valid_to ? new Date(c.valid_to) : null, ok: sock.authorized });
      sock.end();
    });
    sock.on('error', (e) => resolve({ error: e.message }));
    sock.on('timeout', () => { sock.destroy(); resolve({ error: 'tiempo de espera' }); });
  });
}

async function search(client, base, opts = {}, controls) {
  const { searchEntries } = await client.search(base, { scope: 'sub', paged: { pageSize: 500 }, ...opts }, controls);
  return searchEntries;
}

// Prueba la conexion: TLS + cuenta + lectura de la raiz. Devuelve un resumen.
async function test(cfgIn) {
  const cfg = cfgIn || await config();
  validateConfig(cfg);
  const client = await connect(cfg);
  try {
    const [root] = await search(client, '', { scope: 'base', paged: false, attributes: ['defaultNamingContext', 'dnsHostName', 'domainControllerFunctionality'] });
    const cert = await peerCertificate(cfg);
    return { baseDn: str(root.defaultNamingContext), dc: str(root.dnsHostName), cert };
  } finally {
    await client.unbind().catch(() => {});
  }
}

// ------------------------------ lectura completa ------------------------------
async function sync(user = null) {
  const cfg = await config();
  validateConfig(cfg);
  const [run] = await pool.query('INSERT INTO ad_sync_runs (dc, created_by) VALUES (?, ?)', [hostOf(cfg.url), user ? user.id : null]);
  const notes = [];
  let client;
  try {
    client = await connect(cfg);
    const [root] = await search(client, '', { scope: 'base', paged: false,
      attributes: ['defaultNamingContext', 'configurationNamingContext', 'dnsHostName', 'domainControllerFunctionality', 'domainFunctionality', 'forestFunctionality'] });
    const base = cfg.baseDn || str(root.defaultNamingContext, 700);
    const configNc = str(root.configurationNamingContext, 700);
    const domainDns = base.split(',').map((p) => p.replace(/^DC=/i, '')).join('.').toLowerCase();

    // Dominio: SID, politica de contrasenas y bloqueo.
    const [dom] = await search(client, base, { scope: 'base', paged: false, explicitBufferAttributes: ['objectSid'],
      attributes: ['objectSid', 'maxPwdAge', 'minPwdLength', 'pwdHistoryLength', 'lockoutThreshold', 'lockoutDuration', 'msDS-Behavior-Version'] });
    const domainSid = sidOf(dom.objectSid);
    const negDays = (v) => { const s = str(v, 40); return s && /^-?\d+$/.test(s) && s !== '0' ? Math.round(Math.abs(Number(BigInt(s) / 10000000n)) / 86400) : null; };
    const negMin = (v) => { const s = str(v, 40); return s && /^-?\d+$/.test(s) ? Math.round(Math.abs(Number(BigInt(s) / 10000000n)) / 60) : null; };
    const policy = { maxPwdAgeDays: negDays(dom.maxPwdAge), minPwdLength: Number(str(dom.minPwdLength) || 0), pwdHistory: Number(str(dom.pwdHistoryLength) || 0),
      lockoutThreshold: Number(str(dom.lockoutThreshold) || 0), lockoutMinutes: negMin(dom.lockoutDuration) };
    const levels = { 0: '2000', 1: '2003 provisional', 2: '2003', 3: '2008', 4: '2008 R2', 5: '2012', 6: '2012 R2', 7: '2016', 10: '2025' };
    const domainLevel = levels[str(root.domainFunctionality)] || str(root.domainFunctionality);

    // Papelera habilitada?
    let recycleBin = false;
    try {
      const [parts] = await search(client, `CN=Partitions,${configNc}`, { scope: 'base', paged: false, attributes: ['msDS-EnabledFeature'] });
      recycleBin = list(parts['msDS-EnabledFeature']).some((f) => /Recycle Bin Feature/i.test(f));
    } catch (_) { notes.push('No se pudo leer si la Papelera de reciclaje de AD está habilitada.'); }

    // ---- usuarios
    const now = new Date();
    const lockoutMs = (policy.lockoutMinutes || 30) * 60000;
    const users = await search(client, base, { filter: '(&(objectCategory=person)(objectClass=user))', explicitBufferAttributes: ['objectGUID'],
      attributes: ['objectGUID', 'sAMAccountName', 'userPrincipalName', 'displayName', 'mail', 'title', 'department', 'description', 'distinguishedName',
        'userAccountControl', 'lockoutTime', 'pwdLastSet', 'lastLogonTimestamp', 'lastLogon', 'whenCreated', 'adminCount', 'employeeID'] });
    // ---- grupos
    const groups = await search(client, base, { filter: '(objectClass=group)', explicitBufferAttributes: ['objectGUID', 'objectSid'],
      attributes: ['objectGUID', 'objectSid', 'cn', 'sAMAccountName', 'distinguishedName', 'groupType', 'description', 'member'] });
    // ---- OUs y contenedores de primer nivel
    const ous = await search(client, base, { filter: '(|(objectClass=organizationalUnit)(&(objectClass=container)(|(cn=Users)(cn=Computers))))',
      explicitBufferAttributes: ['objectGUID'], attributes: ['objectGUID', 'ou', 'cn', 'distinguishedName', 'description', 'objectClass'] });
    // ---- equipos
    const computers = await search(client, base, { filter: '(objectClass=computer)', explicitBufferAttributes: ['objectGUID'],
      attributes: ['objectGUID', 'cn', 'dNSHostName', 'operatingSystem', 'operatingSystemVersion', 'description', 'distinguishedName', 'userAccountControl',
        'lastLogonTimestamp', 'lastLogon', 'pwdLastSet', 'whenCreated'] });

    // lastLogon no se replica: el mas reciente entre todos los DC.
    const dcs = computers.filter((c) => (Number(str(c.userAccountControl)) & UAC.SERVER_TRUST) && str(c.dNSHostName)).map((c) => str(c.dNSHostName).toLowerCase());
    const lastLogon = new Map(); // dn en minusculas -> fecha
    const takeLogon = (entries) => entries.forEach((e) => {
      const t = fileTime(e.lastLogon);
      const k = String(e.dn).toLowerCase();
      if (t && (!lastLogon.has(k) || lastLogon.get(k) < t)) lastLogon.set(k, t);
    });
    takeLogon(users);
    takeLogon(computers);
    const dcResults = [{ dc: hostOf(cfg.url), ok: true }];
    if (cfg.allDcs) {
      for (const dc of dcs.filter((h) => h !== hostOf(cfg.url).toLowerCase())) {
        let other;
        try {
          other = await connect(cfg, `ldaps://${dc}:636`);
          takeLogon(await search(other, base, { filter: '(|(&(objectCategory=person)(objectClass=user))(objectClass=computer))', attributes: ['lastLogon'] }));
          dcResults.push({ dc, ok: true });
        } catch (err) {
          dcResults.push({ dc, ok: false, error: err.message });
          notes.push(`No se pudo consultar la última conexión en ${dc}: ${err.message}`);
        } finally {
          if (other) await other.unbind().catch(() => {});
        }
      }
    }

    // Privilegiados: por SID; los miembros efectivos (incluidos los anidados)
    // con la regla de cadena de AD; si el servidor no la admite, los directos.
    const groupBySid = new Map(groups.map((g) => [sidOf(g.objectSid), g]));
    const privGroups = [];
    for (const p of PRIVILEGED) {
      const sid = p.sid || (p.rid && domainSid ? `${domainSid}-${p.rid}` : null);
      const g = sid ? groupBySid.get(sid) : groups.find((x) => String(str(x.sAMAccountName)).toLowerCase() === String(p.sam).toLowerCase());
      if (g) privGroups.push({ ...p, dn: g.dn, guid: guidOf(g.objectGUID) });
    }
    const privOf = new Map(); // dn de usuario (minusculas) -> [claves]
    for (const pg of privGroups) {
      let members = [];
      try {
        members = await search(client, base, { filter: `(&(objectCategory=person)(memberOf:${IN_CHAIN}:=${escapeDn(pg.dn)}))`, attributes: ['distinguishedName'] });
      } catch (_) {
        const g = groups.find((x) => x.dn === pg.dn);
        members = list(g && g.member).map((dn) => ({ dn }));
        notes.push(`El servidor no resolvió los miembros anidados de "${pg.label}": se usan los directos.`);
      }
      members.forEach((m) => {
        const k = String(m.dn).toLowerCase();
        privOf.set(k, [...new Set([...(privOf.get(k) || []), pg.key])]);
      });
    }

    // Papelera (CN=Deleted Objects): requiere "Listar contenido" en ese contenedor.
    let deleted = [];
    let deletedOk = true;
    try {
      deleted = await search(client, `CN=Deleted Objects,${base}`, { scope: 'one', filter: '(isDeleted=TRUE)', explicitBufferAttributes: ['objectGUID'],
        attributes: ['objectGUID', 'name', 'msDS-LastKnownRDN', 'objectClass', 'sAMAccountName', 'lastKnownParent', 'whenChanged'] },
      [new Control(SHOW_DELETED, { critical: true })]);
    } catch (err) {
      deletedOk = false;
      notes.push(`No se pudo listar la papelera (la cuenta de servicio necesita "Listar contenido" y "Leer" en CN=Deleted Objects): ${err.message}`);
    }

    // DNS integrado en AD (zonas del dominio).
    let dnsNodes = [];
    let dnsOk = true;
    try {
      dnsNodes = await search(client, `DC=DomainDnsZones,${base}`, { filter: '(&(objectClass=dnsNode)(!(dNSTombstoned=TRUE)))', explicitBufferAttributes: ['dnsRecord'],
        attributes: ['name', 'dnsRecord', 'distinguishedName'] });
    } catch (err) {
      dnsOk = false;
      notes.push(`No se pudieron leer las zonas DNS integradas en AD: ${err.message}`);
    }
    const cert = await peerCertificate(cfg);
    await client.unbind().catch(() => {});
    client = null;

    // ---------------- guardar la foto ----------------
    const conn = await pool.getConnection();
    let summary;
    try {
      await conn.beginTransaction();
      const [[{ stamp }]] = await conn.query("SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS stamp");
      const [emps] = await conn.query('SELECT id, dni FROM employees');
      const empByDni = new Map(emps.map((e) => [String(e.dni), e.id]));

      // OUs y conteos
      const count = (entries, dn) => entries.filter((e) => String(parentDn(e.dn)).toLowerCase() === String(dn).toLowerCase()).length;
      for (const o of ous) {
        const kind = list(o.objectClass).map((x) => String(x).toLowerCase()).includes('organizationalunit') ? 'ou' : 'contenedor';
        await conn.query(
          `INSERT INTO ad_ous (object_guid, name, dn, parent_dn, kind, description, users_count, computers_count, groups_count, seen_at, removed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON DUPLICATE KEY UPDATE name = VALUES(name), dn = VALUES(dn), parent_dn = VALUES(parent_dn), kind = VALUES(kind), description = VALUES(description),
             users_count = VALUES(users_count), computers_count = VALUES(computers_count), groups_count = VALUES(groups_count), seen_at = VALUES(seen_at), removed_at = NULL`,
          [guidOf(o.objectGUID), str(o.ou) || str(o.cn) || rdnValue(o.dn), o.dn, parentDn(o.dn), kind, str(o.description),
            count(users, o.dn), count(computers, o.dn), count(groups, o.dn), stamp]
        );
      }

      // Usuarios
      for (const u of users) {
        const uac = Number(str(u.userAccountControl) || 0);
        const lockout = fileTime(u.lockoutTime);
        const k = String(u.dn).toLowerCase();
        const dni = str(u.employeeID, 20);
        await conn.query(
          `INSERT INTO ad_users (object_guid, sam, upn, display_name, mail, title, department, description, dn, ou_dn, enabled, locked, pwd_never_expires,
             pwd_last_set, last_logon_ts, last_logon, when_created, admin_count, privileged_groups, employee_id, seen_at, removed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON DUPLICATE KEY UPDATE sam = VALUES(sam), upn = VALUES(upn), display_name = VALUES(display_name), mail = VALUES(mail), title = VALUES(title),
             department = VALUES(department), description = VALUES(description), dn = VALUES(dn), ou_dn = VALUES(ou_dn), enabled = VALUES(enabled),
             locked = VALUES(locked), pwd_never_expires = VALUES(pwd_never_expires), pwd_last_set = VALUES(pwd_last_set), last_logon_ts = VALUES(last_logon_ts),
             last_logon = VALUES(last_logon), when_created = VALUES(when_created), admin_count = VALUES(admin_count), privileged_groups = VALUES(privileged_groups),
             employee_id = VALUES(employee_id), seen_at = VALUES(seen_at), removed_at = NULL`,
          [guidOf(u.objectGUID), str(u.sAMAccountName, 64), str(u.userPrincipalName, 255), str(u.displayName, 255), str(u.mail, 255), str(u.title, 150),
            str(u.department, 150), str(u.description), u.dn, parentDn(u.dn), uac & UAC.DISABLED ? 0 : 1,
            lockout && now - lockout < lockoutMs ? 1 : 0, uac & UAC.DONT_EXPIRE_PASSWD ? 1 : 0, sqlDate(fileTime(u.pwdLastSet)),
            sqlDate(fileTime(u.lastLogonTimestamp)), sqlDate(lastLogon.get(k) || null), sqlDate(genTime(u.whenCreated)), str(u.adminCount) === '1' ? 1 : 0,
            (privOf.get(k) || []).join(',') || null, dni && empByDni.has(dni) ? empByDni.get(dni) : null, stamp]
        );
      }
      await conn.query('UPDATE ad_users SET removed_at = ? WHERE removed_at IS NULL AND (seen_at IS NULL OR seen_at < ?)', [stamp, stamp]);

      // Equipos
      for (const c of computers) {
        const uac = Number(str(c.userAccountControl) || 0);
        await conn.query(
          `INSERT INTO ad_computers (object_guid, name, dns_host, os, os_version, description, dn, ou_dn, enabled, is_dc, last_logon_ts, last_logon,
             pwd_last_set, when_created, ips, seen_at, removed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
           ON DUPLICATE KEY UPDATE name = VALUES(name), dns_host = VALUES(dns_host), os = VALUES(os), os_version = VALUES(os_version), description = VALUES(description),
             dn = VALUES(dn), ou_dn = VALUES(ou_dn), enabled = VALUES(enabled), is_dc = VALUES(is_dc), last_logon_ts = VALUES(last_logon_ts),
             last_logon = VALUES(last_logon), pwd_last_set = VALUES(pwd_last_set), when_created = VALUES(when_created), ips = NULL, seen_at = VALUES(seen_at),
             removed_at = NULL`,
          [guidOf(c.objectGUID), str(c.cn, 255), str(c.dNSHostName, 255), str(c.operatingSystem, 255), str(c.operatingSystemVersion, 100), str(c.description),
            c.dn, parentDn(c.dn), uac & UAC.DISABLED ? 0 : 1, uac & UAC.SERVER_TRUST ? 1 : 0, sqlDate(fileTime(c.lastLogonTimestamp)),
            sqlDate(lastLogon.get(String(c.dn).toLowerCase()) || null), sqlDate(fileTime(c.pwdLastSet)), sqlDate(genTime(c.whenCreated)), stamp]
        );
      }
      await conn.query('UPDATE ad_computers SET removed_at = ? WHERE removed_at IS NULL AND (seen_at IS NULL OR seen_at < ?)', [stamp, stamp]);

      // Grupos y miembros directos
      const privByDn = new Map(privGroups.map((p) => [String(p.dn).toLowerCase(), p.key]));
      const [userRows] = await conn.query('SELECT id, dn FROM ad_users WHERE removed_at IS NULL');
      const userIdByDn = new Map(userRows.map((r) => [String(r.dn).toLowerCase(), r.id]));
      const groupDns = new Set(groups.map((g) => String(g.dn).toLowerCase()));
      const computerDns = new Set(computers.map((c) => String(c.dn).toLowerCase()));
      for (const g of groups) {
        const gt = Number(str(g.groupType) || 0);
        const scope = gt & 0x2 ? 'global' : (gt & 0x4 ? 'local' : (gt & 0x8 ? 'universal' : null));
        const members = Object.keys(g).filter((k) => /^member(;range=.*)?$/i.test(k)).flatMap((k) => list(g[k]));
        await conn.query(
          `INSERT INTO ad_groups (object_guid, name, sam, sid, dn, ou_dn, scope, kind, description, member_count, privileged, seen_at, removed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON DUPLICATE KEY UPDATE name = VALUES(name), sam = VALUES(sam), sid = VALUES(sid), dn = VALUES(dn), ou_dn = VALUES(ou_dn), scope = VALUES(scope),
             kind = VALUES(kind), description = VALUES(description), member_count = VALUES(member_count), privileged = VALUES(privileged),
             seen_at = VALUES(seen_at), removed_at = NULL`,
          [guidOf(g.objectGUID), str(g.cn, 255) || rdnValue(g.dn), str(g.sAMAccountName, 255), sidOf(g.objectSid), g.dn, parentDn(g.dn), scope,
            gt & 0x80000000 ? 'seguridad' : 'distribucion', str(g.description), members.length, privByDn.get(String(g.dn).toLowerCase()) || null, stamp]
        );
        const [[row]] = await conn.query('SELECT id FROM ad_groups WHERE object_guid = ?', [guidOf(g.objectGUID)]);
        await conn.query('DELETE FROM ad_group_members WHERE group_id = ?', [row.id]);
        const vals = members.map((dn) => {
          const k = String(dn).toLowerCase();
          const kind = userIdByDn.has(k) ? 'usuario' : (groupDns.has(k) ? 'grupo' : (computerDns.has(k) ? 'equipo' : 'otro'));
          return [row.id, crypto.createHash('sha1').update(k).digest('hex'), String(dn).slice(0, 700), kind, userIdByDn.get(k) || null];
        });
        for (let i = 0; i < vals.length; i += 500) {
          await conn.query('INSERT IGNORE INTO ad_group_members (group_id, member_hash, member_dn, member_kind, user_id) VALUES ?', [vals.slice(i, i + 500)]);
        }
      }
      await conn.query('UPDATE ad_groups SET removed_at = ? WHERE removed_at IS NULL AND (seen_at IS NULL OR seen_at < ?)', [stamp, stamp]);
      await conn.query('UPDATE ad_ous SET removed_at = ? WHERE removed_at IS NULL AND (seen_at IS NULL OR seen_at < ?)', [stamp, stamp]);

      // DNS: se reemplaza; cada A/AAAA se une al equipo con el mismo nombre.
      if (dnsOk) {
        await conn.query('DELETE FROM ad_dns_records');
        const [comps] = await conn.query('SELECT id, LOWER(name) AS name, LOWER(dns_host) AS host FROM ad_computers WHERE removed_at IS NULL');
        const compByName = new Map();
        comps.forEach((c) => { compByName.set(c.name, c.id); if (c.host) compByName.set(c.host.split('.')[0], c.id); });
        const ipsByComputer = new Map();
        const rows = [];
        for (const n of dnsNodes) {
          const zoneDn = String(parentDn(n.dn) || '');
          const zone = rdnValue(zoneDn);
          const name = str(n.name, 255) || rdnValue(n.dn);
          if (/^(RootDNSServers|\.\.TrustAnchors)$/i.test(zone)) continue;
          for (const raw of list(n.dnsRecord)) {
            const r = parseDnsRecord(raw);
            if (!r || ['SOA', 'NS'].includes(r.rtype)) continue;
            const isHost = (r.rtype === 'A' || r.rtype === 'AAAA') && !name.startsWith('_') && name !== '@';
            const compId = isHost && zone.toLowerCase() === domainDns ? compByName.get(name.toLowerCase()) || null : null;
            if (compId && r.data) ipsByComputer.set(compId, [...new Set([...(ipsByComputer.get(compId) || []), r.data])]);
            rows.push([zone.slice(0, 255), name.slice(0, 255), r.rtype, r.data ? String(r.data).slice(0, 500) : null, r.ttl, sqlDate(r.recordTs), compId]);
          }
        }
        for (let i = 0; i < rows.length; i += 500) {
          await conn.query('INSERT INTO ad_dns_records (zone, name, rtype, data, ttl, record_ts, computer_id) VALUES ?', [rows.slice(i, i + 500)]);
        }
        for (const [id, ips] of ipsByComputer) await conn.query('UPDATE ad_computers SET ips = ? WHERE id = ?', [ips.join(', ').slice(0, 255), id]);
      }

      // Papelera
      if (deletedOk) {
        await conn.query('DELETE FROM ad_deleted');
        const rows = deleted.map((d) => {
          const cls = list(d.objectClass).map(String);
          return [guidOf(d.objectGUID), (str(d['msDS-LastKnownRDN'], 255) || String(str(d.name, 255) || '').split('\n')[0]).slice(0, 255),
            cls.includes('computer') ? 'equipo' : (cls.includes('user') ? 'usuario' : (cls.includes('group') ? 'grupo' : (cls.includes('organizationalUnit') ? 'ou' : cls[cls.length - 1] || null))),
            str(d.sAMAccountName, 255), str(d.lastKnownParent, 700), sqlDate(genTime(d.whenChanged))];
        }).filter((r) => r[0]);
        for (let i = 0; i < rows.length; i += 500) {
          await conn.query('INSERT IGNORE INTO ad_deleted (object_guid, name, object_class, sam, last_known_parent, deleted_at) VALUES ?', [rows.slice(i, i + 500)]);
        }
      }

      summary = {
        domain: domainDns, baseDn: base, dc: str(root.dnsHostName), domainLevel, recycleBin, policy, dcs: dcResults, cert,
        deletedEmpty: deletedOk && deleted.length === 0,
        counts: { users: users.length, groups: groups.length, ous: ous.length, computers: computers.length, deleted: deletedOk ? deleted.length : null,
          dns: dnsOk ? dnsNodes.length : null },
        privileged: privGroups.map((p) => ({ key: p.key, label: p.label })), notes,
      };
      await conn.query("UPDATE ad_sync_runs SET finished_at = NOW(), status = ?, summary_json = ? WHERE id = ?",
        [notes.length ? 'con_avisos' : 'ok', JSON.stringify(summary), run.insertId]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    const result = `${users.length} usuario(s), ${groups.length} grupo(s), ${computers.length} equipo(s), ${ous.length} unidad(es) organizativa(s)`
      + `${deletedOk ? `, ${deleted.length} en la papelera` : ''}${notes.length ? ` · ${notes.length} aviso(s)` : ''}.`;
    await settingsService.setMany({ ad_last_sync: new Date().toISOString(), ad_last_result: result });
    return { ...summary, result };
  } catch (err) {
    if (client) await client.unbind().catch(() => {});
    await pool.query("UPDATE ad_sync_runs SET finished_at = NOW(), status = 'error', error = ? WHERE id = ?", [String(err.message).slice(0, 1000), run.insertId]);
    await settingsService.setMany({ ad_last_result: `Error: ${err.message}` });
    throw err;
  }
}

// ------------------------------ consultas para las pantallas ------------------------------
// Ultima conexion efectiva: la mas reciente entre lastLogon (por DC) y lastLogonTimestamp.
// (fechas tipadas: con texto, MariaDB compara como texto y "nunca" no daba NULL).
const NEVER = "TIMESTAMP('1000-01-01 00:00:00')";
const LAST_SQL = (t) => `NULLIF(GREATEST(COALESCE(${t}.last_logon, ${NEVER}), COALESCE(${t}.last_logon_ts, ${NEVER})), ${NEVER})`;
const IDLE_DAYS = 90;

async function lastRun() {
  const [[ok]] = await pool.query("SELECT * FROM ad_sync_runs WHERE status IN ('ok', 'con_avisos') ORDER BY id DESC LIMIT 1");
  const [[last]] = await pool.query('SELECT * FROM ad_sync_runs ORDER BY id DESC LIMIT 1');
  let summary = null;
  try { summary = ok && ok.summary_json ? JSON.parse(ok.summary_json) : null; } catch (_) { summary = null; }
  return { ok: ok || null, last: last || null, summary };
}

async function users() {
  const [rows] = await pool.query(
    `SELECT u.*, ${LAST_SQL('u')} AS last_seen, e.first_name, e.last_name, e.dni AS employee_dni,
            (SELECT GROUP_CONCAT(g.name ORDER BY g.name SEPARATOR ', ') FROM ad_group_members m JOIN ad_groups g ON g.id = m.group_id
             WHERE m.user_id = u.id AND g.removed_at IS NULL) AS groups_list
     FROM ad_users u LEFT JOIN employees e ON e.id = u.employee_id WHERE u.removed_at IS NULL ORDER BY u.sam`
  );
  return rows;
}

async function computers() {
  const [rows] = await pool.query(`SELECT c.*, ${LAST_SQL('c')} AS last_seen FROM ad_computers c WHERE c.removed_at IS NULL ORDER BY c.name`);
  return rows;
}

async function groups() {
  const [rows] = await pool.query(
    `SELECT g.*, (SELECT COUNT(*) FROM ad_users u WHERE u.removed_at IS NULL AND FIND_IN_SET(g.privileged, u.privileged_groups)) AS effective_users
     FROM ad_groups g WHERE g.removed_at IS NULL ORDER BY g.privileged IS NULL, g.name`
  );
  return rows;
}

async function group(id) {
  const [[g]] = await pool.query('SELECT * FROM ad_groups WHERE id = ? AND removed_at IS NULL', [id]);
  if (!g) return null;
  const [members] = await pool.query(
    `SELECT m.member_dn, m.member_kind, u.id AS user_id, u.sam, u.display_name, u.enabled, ${LAST_SQL('u')} AS last_seen
     FROM ad_group_members m LEFT JOIN ad_users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.member_kind, u.sam, m.member_dn`, [id]
  );
  let effective = [];
  if (g.privileged) {
    [effective] = await pool.query(
      `SELECT id, sam, display_name, enabled, ${LAST_SQL('ad_users')} AS last_seen FROM ad_users
       WHERE removed_at IS NULL AND FIND_IN_SET(?, privileged_groups) ORDER BY sam`, [g.privileged]
    );
  }
  return { ...g, members, effective };
}

async function user(id) {
  const [[u]] = await pool.query(
    `SELECT u.*, ${LAST_SQL('u')} AS last_seen, e.first_name, e.last_name, e.dni AS employee_dni FROM ad_users u
     LEFT JOIN employees e ON e.id = u.employee_id WHERE u.id = ?`, [id]
  );
  if (!u) return null;
  const [memberOf] = await pool.query(
    `SELECT g.id, g.name, g.privileged, g.kind, g.scope FROM ad_group_members m JOIN ad_groups g ON g.id = m.group_id
     WHERE m.user_id = ? AND g.removed_at IS NULL ORDER BY g.name`, [id]
  );
  return { ...u, memberOf };
}

async function ous() {
  const [rows] = await pool.query('SELECT * FROM ad_ous WHERE removed_at IS NULL ORDER BY dn');
  return rows;
}

async function deleted() {
  const [rows] = await pool.query('SELECT * FROM ad_deleted ORDER BY deleted_at DESC');
  return rows;
}

async function dns() {
  const [rows] = await pool.query(
    `SELECT r.*, c.name AS computer_name FROM ad_dns_records r LEFT JOIN ad_computers c ON c.id = r.computer_id
     ORDER BY r.zone, r.name = '@' DESC, r.name, r.rtype`
  );
  return rows;
}

// Cifras del resumen (y del Panel).
async function overview() {
  const n = (v) => Number(v || 0);
  const [[u]] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(enabled = 1) AS enabled, SUM(enabled = 0) AS disabled, SUM(locked = 1) AS locked,
            SUM(enabled = 1 AND privileged_groups IS NOT NULL) AS privileged, SUM(enabled = 1 AND pwd_never_expires = 1) AS never_expires,
            SUM(enabled = 1 AND ${LAST_SQL('ad_users')} IS NULL AND (when_created IS NULL OR when_created < NOW() - INTERVAL 30 DAY)) AS never_logged,
            SUM(enabled = 1 AND ${LAST_SQL('ad_users')} < NOW() - INTERVAL ${IDLE_DAYS} DAY) AS idle
     FROM ad_users WHERE removed_at IS NULL`
  );
  const [[c]] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(enabled = 1) AS enabled, SUM(is_dc = 1) AS dcs, SUM(enabled = 1 AND ips IS NULL AND is_dc = 0) AS no_dns,
            SUM(enabled = 1 AND is_dc = 0 AND (${LAST_SQL('ad_computers')} IS NULL OR ${LAST_SQL('ad_computers')} < NOW() - INTERVAL ${IDLE_DAYS} DAY)) AS idle
     FROM ad_computers WHERE removed_at IS NULL`
  );
  const [[d]] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(computer_id IS NULL AND rtype IN ('A', 'AAAA') AND name NOT LIKE '\\_%' AND name <> '@'
              AND name NOT IN ('DomainDnsZones', 'ForestDnsZones')) AS without_computer FROM ad_dns_records`
  );
  const [[del]] = await pool.query('SELECT COUNT(*) AS total FROM ad_deleted');
  const [os] = await pool.query(
    "SELECT COALESCE(os, 'Sin dato') AS os, COUNT(*) AS n FROM ad_computers WHERE removed_at IS NULL AND enabled = 1 GROUP BY os ORDER BY n DESC"
  );
  const [privileged] = await pool.query(
    `SELECT g.id, g.name, g.privileged, (SELECT COUNT(*) FROM ad_users u WHERE u.removed_at IS NULL AND u.enabled = 1 AND FIND_IN_SET(g.privileged, u.privileged_groups)) AS n
     FROM ad_groups g WHERE g.removed_at IS NULL AND g.privileged IS NOT NULL ORDER BY n DESC, g.name`
  );
  const [lastRows] = await pool.query(`SELECT ${LAST_SQL('ad_users')} AS last_seen, when_created FROM ad_users WHERE removed_at IS NULL AND enabled = 1`);
  return {
    users: { total: n(u.total), enabled: n(u.enabled), disabled: n(u.disabled), locked: n(u.locked), privileged: n(u.privileged),
      neverExpires: n(u.never_expires), neverLogged: n(u.never_logged), idle: n(u.idle) },
    computers: { total: n(c.total), enabled: n(c.enabled), dcs: n(c.dcs), noDns: n(c.no_dns), idle: n(c.idle) },
    dns: { total: n(d.total), withoutComputer: n(d.without_computer) }, deleted: n(del.total), os, privileged, lastSeen: lastRows,
  };
}

// Escapa un DN para usarlo dentro de un filtro LDAP (RFC 4515).
function escapeDn(dn) {
  return String(dn).replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

module.exports = {
  PRIVILEGED, PRIVILEGED_LABEL, IDLE_DAYS, config, validateConfig, test, sync, peerCertificate,
  lastRun, users, user, computers, groups, group, ous, deleted, dns, overview,
  _: { fileTime, genTime, guidOf, sidOf, parseDnsRecord, parentDn, rdnValue, escapeDn, hostOf },
};
