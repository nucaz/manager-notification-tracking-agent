// Red > Switches y AP: monitoreo de actividad. Cada 5 minutos (job
// syncNetMonitor) comprueba si cada switch o punto de acceso "en uso" responde
// y guarda el resultado (network_device_monitor) para el indicador verde/rojo.
//
// Como se comprueba (method):
//   auto - 1) si el equipo esta en un controlador Omada leido hace poco, vale
//             lo que diga Omada (sirve para sedes a las que el servidor no llega);
//          2) ping; 3) puertos de gestion habituales (un puerto que rechaza la
//             conexion tambien prueba que el equipo esta encendido).
//   tcp  - un puerto TCP concreto debe aceptar la conexion.
//   snmp - consulta SNMP v2c de sysUpTime (UDP 161 por defecto) con la comunidad
//          guardada (cifrada). Cualquier respuesta SNMP valida = activo.
//   no   - no se monitorea.
//
// Solo se comprueban direcciones de la red interna. "Inactivo" significa "no
// responde desde el servidor de esta aplicacion": un equipo de una sede sin
// ruta hacia el servidor sale inactivo aunque funcione (salvo que lo vea Omada).
const net = require('net');
const dgram = require('dgram');
const { execFile } = require('child_process');
const pool = require('../db/pool');
const cryptoService = require('./cryptoService');

const METHODS = { auto: 'Automático (Omada, ping y puertos habituales)', tcp: 'Puerto TCP', snmp: 'SNMP v2c', no: 'No monitorear' };
const AUTO_PORTS = [443, 80, 22, 23, 8080];
const OMADA_FRESH_MIN = 15;     // una lectura de Omada mas vieja que esto no se usa
const CONCURRENCY = 12;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const isPrivate = (ip) => { const p = String(ip).split('.').map(Number); return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168); };
const _ = { allowLoopback: false }; // las pruebas comprueban contra 127.0.0.1

// ---------------- comprobaciones ----------------
function ping(ip, waitSec = 2) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile('ping', ['-c', '1', '-W', String(waitSec), ip], { timeout: (waitSec + 2) * 1000 }, (err) => resolve(err ? null : Date.now() - t0));
  });
}
// 'open' | 'refused' (el equipo contesta, el puerto esta cerrado) | 'none'
function tcp(ip, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host: ip, port, timeout: timeoutMs });
    const done = (state) => { s.destroy(); resolve({ state, ms: Date.now() - t0 }); };
    s.on('connect', () => done('open'));
    s.on('timeout', () => done('none'));
    s.on('error', (e) => done(e.code === 'ECONNREFUSED' ? 'refused' : 'none'));
  });
}

// --- SNMP v2c: un GET de sysUpTime.0 (1.3.6.1.2.1.1.3.0), codificado a mano (BER) ---
const berLen = (n) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), berLen(body.length), body]);
const berInt = (n) => { const b = []; let v = n; do { b.unshift(v & 0xff); v = Math.floor(v / 256); } while (v > 0); if (b[0] & 0x80) b.unshift(0); return tlv(0x02, Buffer.from(b)); };
const SYS_UPTIME = Buffer.from([0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x03, 0x00]);
function snmpRequest(community, requestId) {
  const varbinds = tlv(0x30, tlv(0x30, Buffer.concat([tlv(0x06, SYS_UPTIME), tlv(0x05, Buffer.alloc(0))])));
  const pdu = tlv(0xa0, Buffer.concat([berInt(requestId), berInt(0), berInt(0), varbinds]));
  return tlv(0x30, Buffer.concat([berInt(1), tlv(0x04, Buffer.from(String(community), 'latin1')), pdu])); // version 1 = v2c
}
// Lee un TLV en buf a partir de pos: { tag, start, end } (start..end = contenido).
function readTlv(buf, pos) {
  if (pos + 2 > buf.length) throw new Error('corto');
  const tag = buf[pos];
  let len = buf[pos + 1];
  let start = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 2 || start + n > buf.length) throw new Error('longitud');
    len = n === 1 ? buf[start] : (buf[start] << 8) | buf[start + 1];
    start += n;
  }
  if (start + len > buf.length) throw new Error('corto');
  return { tag, start, end: start + len };
}
const berUint = (buf, t) => { let v = 0; for (let i = t.start; i < t.end; i += 1) v = v * 256 + buf[i]; return v; };
// Devuelve { requestId, error, uptimeTicks | null } o lanza si no es una respuesta SNMP.
function snmpParse(buf) {
  const msg = readTlv(buf, 0);
  if (msg.tag !== 0x30) throw new Error('no es SNMP');
  const ver = readTlv(buf, msg.start);
  const com = readTlv(buf, ver.end);
  const pdu = readTlv(buf, com.end);
  if (pdu.tag !== 0xa2) throw new Error('no es una respuesta');
  const rid = readTlv(buf, pdu.start);
  const est = readTlv(buf, rid.end);
  const eix = readTlv(buf, est.end);
  let uptimeTicks = null;
  try {
    const list = readTlv(buf, eix.end);
    const vb = readTlv(buf, list.start);
    const oid = readTlv(buf, vb.start);
    const val = readTlv(buf, oid.end);
    if (val.tag === 0x43) uptimeTicks = berUint(buf, val); // TimeTicks, centesimas de segundo
  } catch (e) { uptimeTicks = null; }
  return { requestId: berUint(buf, rid), error: berUint(buf, est), uptimeTicks };
}
function snmpUptime(ip, community, port = 161, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const requestId = 1 + Math.floor(Math.random() * 0x7ffffffe);
    const sock = dgram.createSocket('udp4');
    const t0 = Date.now();
    let tries = 0; let timer = null; let finished = false;
    const finish = (r) => { if (finished) return; finished = true; clearTimeout(timer); try { sock.close(); } catch (e) { /* ya cerrado */ } resolve(r); };
    const send = () => {
      tries += 1;
      sock.send(snmpRequest(community, requestId), port, ip, (err) => { if (err) finish(null); });
      timer = setTimeout(() => (tries < 2 ? send() : finish(null)), timeoutMs);
    };
    sock.on('error', () => finish(null));
    sock.on('message', (m) => {
      try { const r = snmpParse(m); if (r.requestId === requestId) finish({ ms: Date.now() - t0, uptimeTicks: r.uptimeTicks, error: r.error }); } catch (e) { /* no era la respuesta */ }
    });
    send();
  });
}
function fmtUptime(ticks) {
  const s = Math.floor(ticks / 100);
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

// Comprueba un equipo: { status: 'up'|'down'|null, detail, ms }. null = no se pudo comprobar.
// d: { ip, mac, method, port, community (descifrada), omada: { status, fresh } | null }
async function check(d) {
  const method = METHODS[d.method] ? d.method : 'auto';
  if (method === 'no') return { status: null, detail: 'No se monitorea.', ms: null };
  const om = d.omada;
  if (method === 'auto' && om && om.fresh) {
    return om.status === 1 ? { status: 'up', detail: 'Conectado, según el controlador Omada.', ms: null } : { status: 'down', detail: 'Sin conexión, según el controlador Omada.', ms: null };
  }
  const ip = String(d.ip || '');
  if (!IPV4.test(ip)) return { status: null, detail: 'Sin dirección IP: no se puede comprobar.', ms: null };
  if (!isPrivate(ip) && !(_.allowLoopback && ip.startsWith('127.'))) return { status: null, detail: 'Solo se comprueban direcciones de la red interna.', ms: null };
  if (method === 'tcp') {
    const port = Number(d.port) || 443;
    const r = await tcp(ip, port);
    if (r.state === 'open') return { status: 'up', detail: `El puerto ${port} responde.`, ms: r.ms };
    return { status: 'down', detail: r.state === 'refused' ? `El equipo contesta, pero el puerto ${port} está cerrado.` : `El puerto ${port} no responde.`, ms: null };
  }
  if (method === 'snmp') {
    if (!d.community) return { status: null, detail: 'Falta la comunidad SNMP.', ms: null };
    const port = Number(d.port) || 161;
    const r = await snmpUptime(ip, d.community, port);
    if (!r) return { status: 'down', detail: `Sin respuesta SNMP (puerto ${port}, comunidad o equipo).`, ms: null };
    return { status: 'up', detail: r.uptimeTicks !== null ? `Responde por SNMP; encendido hace ${fmtUptime(r.uptimeTicks)}.` : 'Responde por SNMP.', ms: r.ms };
  }
  const p = await ping(ip);
  if (p !== null) return { status: 'up', detail: 'Responde al ping.', ms: p };
  const tries = await Promise.all(AUTO_PORTS.map((port) => tcp(ip, port, 2000).then((r) => ({ ...r, port }))));
  const hit = tries.find((r) => r.state === 'open') || tries.find((r) => r.state === 'refused');
  if (hit) return { status: 'up', detail: `No responde al ping, pero sí por el puerto ${hit.port}.`, ms: hit.ms };
  return { status: 'down', detail: 'No responde al ping ni por los puertos de gestión habituales.', ms: null };
}

// ---------------- lectura y guardado ----------------
async function targets(deviceId) {
  const [rows] = await pool.query(`SELECT d.id, d.name, d.ip, d.mac, COALESCE(sp.state, 'en_uso') AS state, mo.method, mo.port, mo.community, mo.status AS prev,
      (SELECT o.status FROM omada_devices o WHERE o.mac = d.mac AND o.present = 1 ORDER BY o.synced_at DESC LIMIT 1) AS omada_status,
      (SELECT TIMESTAMPDIFF(MINUTE, o.synced_at, NOW()) FROM omada_devices o WHERE o.mac = d.mac AND o.present = 1 ORDER BY o.synced_at DESC LIMIT 1) AS omada_age
    FROM network_devices d LEFT JOIN network_device_specs sp ON sp.device_id = d.id LEFT JOIN network_device_monitor mo ON mo.device_id = d.id
    WHERE d.kind IN ('switch', 'ap')${deviceId ? ' AND d.id = ?' : ''}`, deviceId ? [Number(deviceId)] : []);
  return rows;
}
async function store(id, prev, r) {
  await pool.query(`INSERT INTO network_device_monitor (device_id, status, detail, latency_ms, checked_at, changed_at) VALUES (?, ?, ?, ?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE changed_at = IF(status <=> VALUES(status), changed_at, NOW()), status = VALUES(status), detail = VALUES(detail), latency_ms = VALUES(latency_ms), checked_at = NOW()`,
  [id, r.status, String(r.detail || '').slice(0, 160), r.ms]);
  return { id, status: r.status, changed: (prev || null) !== (r.status || null) };
}
async function checkRow(t) {
  // Un equipo que no esta en uso (stock, reparacion, baja) no se comprueba.
  if (t.state !== 'en_uso') return store(t.id, t.prev, { status: null, detail: 'No está en uso: no se monitorea.', ms: null });
  const omada = t.mac && t.omada_status !== null && t.omada_status !== undefined ? { status: Number(t.omada_status), fresh: t.omada_age !== null && Number(t.omada_age) <= OMADA_FRESH_MIN } : null;
  const r = await check({ ip: t.ip, mac: t.mac, method: t.method || 'auto', port: t.port, community: t.community ? cryptoService.decrypt(t.community) : null, omada });
  return store(t.id, t.prev, r);
}

let running = false;
// Comprueba todos (o uno). Devuelve { skipped, total, up, down, unknown, changed }.
async function run(deviceId) {
  if (running && !deviceId) return { skipped: true };
  if (!deviceId) running = true;
  try {
    const list = await targets(deviceId);
    const out = [];
    for (let i = 0; i < list.length; i += CONCURRENCY) out.push(...await Promise.all(list.slice(i, i + CONCURRENCY).map(checkRow)));
    return { skipped: false, total: out.length, up: out.filter((x) => x.status === 'up').length, down: out.filter((x) => x.status === 'down').length,
      unknown: out.filter((x) => !x.status).length, changed: out.filter((x) => x.changed).length };
  } finally {
    if (!deviceId) running = false;
  }
}

// Lo que llega del formulario, validado. deviceId = 0 para un equipo nuevo.
// Una comunidad en blanco conserva la guardada. Se llama ANTES de guardar el equipo,
// para que un dato invalido no deje el equipo a medio registrar.
async function settingsInput(deviceId, b) {
  const method = METHODS[b.mon_method] ? b.mon_method : 'auto';
  const raw = String(b.mon_port === undefined || b.mon_port === null ? '' : b.mon_port).trim();
  if (raw && !(/^\d{1,5}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 65535)) throw new Error('El puerto de monitoreo debe ser un número entre 1 y 65535.');
  const community = String(b.mon_community || '').trim();
  if (community && !/^[\x21-\x7e]{1,60}$/.test(community)) throw new Error('La comunidad SNMP no es válida: hasta 60 caracteres, sin espacios.');
  const [[cur]] = await pool.query('SELECT method, port, community FROM network_device_monitor WHERE device_id = ?', [Number(deviceId) || 0]);
  const set = { method, port: raw ? Number(raw) : null, community: community ? cryptoService.encrypt(community) : (cur ? cur.community : null) };
  if (method !== 'snmp') set.community = null; // la comunidad solo se guarda mientras se usa
  if (method === 'snmp' && !set.community) throw new Error('Para monitorear por SNMP escriba la comunidad (v2c).');
  return { set, cur, method };
}
async function saveSettings(deviceId, b) {
  const { set, cur, method } = await settingsInput(deviceId, b);
  await pool.query('INSERT INTO network_device_monitor SET ? ON DUPLICATE KEY UPDATE ?', [{ device_id: deviceId, ...set }, set]);
  // Si cambio la forma de comprobar, el resultado anterior ya no vale.
  if (cur && (cur.method !== method || (cur.port || null) !== set.port)) await pool.query('UPDATE network_device_monitor SET status = NULL, detail = NULL, checked_at = NULL WHERE device_id = ?', [deviceId]);
}

module.exports = { METHODS, run, check, saveSettings, settingsInput, _, snmp: { request: snmpRequest, parse: snmpParse, uptime: snmpUptime } };
