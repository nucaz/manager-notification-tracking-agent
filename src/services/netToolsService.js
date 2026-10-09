// Modulo Red: herramientas de diagnostico que se ejecutan DESDE el servidor de
// la aplicacion (lo que se ve es la red vista desde ese servidor, no desde la
// PC de quien consulta): ping, ruta (saltos), DNS y puertos TCP abiertos.
//
// Nombres de equipo: el servidor puede no resolver un nombre corto (pcsist01)
// porque su DNS no es el del dominio. Por eso un nombre se busca, en orden:
//   1. en el DNS de los controladores de dominio (nombre.dominio),
//   2. en lo que la aplicacion ya sabe (directorio activo e inventario de Red),
//   3. en el DNS del propio servidor.
// La herramienta siempre recibe la IP ya resuelta.
//
// Limites deliberados:
//   - El destino se valida (nombre o IPv4) y va como argumento de spawn,
//     nunca dentro de una linea de comandos.
//   - La revision de puertos solo se hace sobre direcciones privadas de la red
//     interna (10/8, 172.16/12, 192.168/16): no sirve para explorar terceros.
//   - Tope de puertos por consulta, tiempo maximo y tope de salida.
const { spawn } = require('child_process');
const dns = require('dns');
const net = require('net');

const HOST = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9_-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9_-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const MAX_PORTS = 100;
const MAX_OUTPUT = 20000;
const COMMON_PORTS = {
  21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 80: 'HTTP', 88: 'Kerberos', 110: 'POP3', 135: 'RPC', 139: 'NetBIOS', 143: 'IMAP', 161: 'SNMP (TCP)',
  389: 'LDAP', 443: 'HTTPS', 445: 'SMB (carpetas compartidas)', 515: 'Impresión LPD', 631: 'Impresión IPP', 636: 'LDAPS', 993: 'IMAPS', 995: 'POP3S', 1433: 'SQL Server',
  1521: 'Oracle', 3306: 'MySQL / MariaDB', 3389: 'Escritorio remoto', 5432: 'PostgreSQL', 5900: 'VNC', 5985: 'WinRM', 8080: 'HTTP alterno', 8443: 'HTTPS alterno',
  9100: 'Impresora (RAW)',
};

function target(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) throw new Error('Indique el equipo: un nombre o una IP.');
  if (!IPV4.test(h) && !HOST.test(h)) throw new Error('El destino no es válido: use un nombre de equipo o una IPv4 (ej. pc-ventas-01 o 172.16.1.20).');
  return h;
}

const isPrivate = (ip) => {
  const p = String(ip).split('.').map(Number);
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
};
const firstIp = (text) => String(text || '').split(',').map((x) => x.trim()).find((x) => IPV4.test(x)) || null;

// ------------------------------ resolucion de nombres ------------------------------
// Dominio y DNS de los controladores de dominio, de la ultima lectura del directorio activo.
async function domainDns() {
  try {
    const pool = require('../db/pool');
    const [dcs] = await pool.query('SELECT ips FROM ad_computers WHERE removed_at IS NULL AND is_dc = 1 AND ips IS NOT NULL');
    const [[run]] = await pool.query("SELECT summary_json FROM ad_sync_runs WHERE status IN ('ok', 'con_avisos') ORDER BY id DESC LIMIT 1");
    let domain = '';
    try { domain = String(JSON.parse(run.summary_json).domain || '').toLowerCase(); } catch (_) { domain = ''; }
    return { domain, servers: [...new Set(dcs.map((d) => firstIp(d.ips)).filter(Boolean))].slice(0, 4) };
  } catch (_) {
    return { domain: '', servers: [] };
  }
}

// Lo que la aplicacion ya sabe de ese nombre (directorio activo e inventario de Red).
async function inventoryIp(name) {
  try {
    const pool = require('../db/pool');
    const short = name.split('.')[0];
    const [[ad]] = await pool.query('SELECT ips FROM ad_computers WHERE removed_at IS NULL AND ips IS NOT NULL AND (LOWER(name) = ? OR LOWER(dns_host) = ?) LIMIT 1', [short, name]);
    if (ad && firstIp(ad.ips)) return { ip: firstIp(ad.ips), via: 'la última lectura del directorio activo' };
    const [[dev]] = await pool.query('SELECT ip FROM network_devices WHERE ip IS NOT NULL AND LOWER(name) = ? LIMIT 1', [short === name ? name : short]);
    if (dev && IPV4.test(dev.ip)) return { ip: dev.ip, via: 'el inventario de Red' };
  } catch (_) { /* sin base: se sigue con el DNS */ }
  return null;
}

// Devuelve { host, ip, via, tried } (ip null si no se pudo). No lanza por un nombre que no resuelve.
async function resolveTarget(host) {
  const h = target(host);
  if (IPV4.test(h)) return { host: h, ip: h, via: '', tried: [] };
  const tried = [];
  const dom = await domainDns();
  if (dom.servers.length) {
    const fqdn = h.includes('.') || !dom.domain ? h : `${h}.${dom.domain}`;
    try {
      const r = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
      r.setServers(dom.servers);
      const a = await r.resolve4(fqdn);
      if (a.length) return { host: h, ip: a[0], via: `el DNS del dominio (${fqdn} en ${dom.servers[0]})`, tried };
    } catch (err) {
      tried.push(`DNS del dominio (${dom.servers.join(', ')}): ${fqdn} no existe (${err.code || err.message})`);
    }
  } else tried.push('DNS del dominio: aún no se conocen los controladores de dominio (lea el directorio activo)');
  const inv = await inventoryIp(h);
  if (inv) return { host: h, ip: inv.ip, via: inv.via, tried };
  tried.push('Directorio activo e inventario de Red: no hay un equipo con ese nombre e IP');
  try {
    const a = await dns.promises.lookup(h, { family: 4 });
    return { host: h, ip: a.address, via: 'el DNS del servidor de la aplicación', tried };
  } catch (err) {
    tried.push(`DNS del servidor de la aplicación: no lo resuelve (${err.code || err.message})`);
  }
  return { host: h, ip: null, via: '', tried };
}

// ------------------------------ ejecucion ------------------------------
// Ejecuta un comando y entrega cada linea en cuanto sale (emit). Se corta con signal o por tiempo.
function runLines(cmd, args, timeoutMs, emit, signal) {
  return new Promise((resolve) => {
    let out = '';
    let buf = '';
    let done = false;
    let child;
    const finish = (extra) => { if (done) return; done = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); resolve({ output: out.trim(), ...extra }); };
    const line = (l) => { if (out.length < MAX_OUTPUT) { out += `${l}\n`; emit(l); } };
    const onAbort = () => { if (child) child.kill('SIGKILL'); line('(Detenido.)'); finish({ ok: false, stopped: true }); };
    const timer = setTimeout(() => { if (child) child.kill('SIGKILL'); line(`(Se cortó: superó el tiempo máximo de ${Math.round(timeoutMs / 1000)} s.)`); finish({ ok: false }); }, timeoutMs);
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (err) {
      line(err.message);
      return finish({ ok: false });
    }
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort); }
    const feed = (chunk) => {
      buf += chunk.toString('utf8');
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      parts.forEach(line);
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (err) => {
      line(err.code === 'ENOENT' ? `La herramienta "${cmd}" no está instalada en el servidor de la aplicación.` : err.message);
      finish({ ok: false });
    });
    child.on('close', (code) => { if (buf) line(buf); finish({ ok: code === 0 }); });
    return undefined;
  });
}

const unresolved = (r, emit) => {
  const lines = [`No se pudo resolver el nombre "${r.host}". Se buscó en:`, ...r.tried.map((t) => `  - ${t}`), 'Pruebe con la IP, o registre el equipo con su IP en Red → Equipos.'];
  lines.forEach(emit);
  return lines.join('\n');
};
const announce = (r, emit) => { if (r.via) emit(`${r.host} → ${r.ip}   (resuelto por ${r.via})`); };

async function ping(host, { emit, signal }) {
  const r = await resolveTarget(host);
  emit(`$ ping -c 4 ${r.host}`);
  if (!r.ip) return { tool: 'ping', host: r.host, ok: false, summary: 'El nombre no se resuelve desde el servidor: use la IP.', output: unresolved(r, emit) };
  announce(r, emit);
  const x = await runLines('ping', ['-c', '4', '-W', '2', r.ip], 15000, emit, signal);
  const loss = /(\d+)% packet loss/.exec(x.output);
  const avg = /= [\d.]+\/([\d.]+)\//.exec(x.output);
  const who = r.via ? `${r.host} (${r.ip})` : r.ip;
  const summary = x.stopped ? 'Detenido.' : (!loss ? 'No se pudo hacer ping (no hay ruta hacia esa dirección).'
    : (Number(loss[1]) === 100 ? `${who} no responde: se perdieron todos los paquetes (apagado, fuera de la red o con el ping bloqueado por su firewall).`
      : `${who} responde${Number(loss[1]) ? ` con ${loss[1]}% de pérdida` : ''}${avg ? `; tiempo promedio ${avg[1]} ms` : ''}.`));
  return { tool: 'ping', host: r.host, ip: r.ip, ok: !!loss && Number(loss[1]) < 100, summary, output: `${r.via ? `${r.host} → ${r.ip} (${r.via})\n` : ''}${x.output}` };
}

// Saltos hasta el destino. tracepath no necesita privilegios (traceroute si).
async function trace(host, { emit, signal }) {
  const r = await resolveTarget(host);
  emit(`$ tracepath -n ${r.host}`);
  if (!r.ip) return { tool: 'ruta', host: r.host, ok: false, hops: [], summary: 'El nombre no se resuelve desde el servidor: use la IP.', output: unresolved(r, emit) };
  announce(r, emit);
  const x = await runLines('tracepath', ['-n', '-m', '20', r.ip], 60000, emit, signal);
  const hops = [];
  x.output.split('\n').forEach((line) => {
    const m = /^\s*(\d+):\s+(\S+)\s+([\d.]+ms)?/.exec(line);
    if (!m || /LOCALHOST/.test(line)) return;
    const n = Number(m[1]);
    const reply = m[2] === 'no' ? null : m[2];
    const prev = hops.find((h) => h.hop === n);
    if (prev) { if (!prev.address && reply) { prev.address = reply; prev.time = m[3] || ''; } } else hops.push({ hop: n, address: reply, time: reply ? (m[3] || '') : '' });
  });
  const reached = /reached/i.test(x.output);
  const last = [...hops].reverse().find((h) => h.address);
  return { tool: 'ruta', host: r.host, ip: r.ip, ok: reached, hops,
    summary: x.stopped ? 'Detenido.' : (!hops.length ? 'No se pudo trazar la ruta.'
      : `${reached ? 'Llegó al destino' : 'No llegó al destino'}: ${hops.filter((h) => h.address).length} salto(s) respondieron${last ? `; el último fue ${last.address}` : ''}. `
        + 'Un salto "sin respuesta" suele ser un equipo que no contesta estas pruebas, no necesariamente un corte.'), output: x.output };
}

// DNS: que dice cada fuente sobre ese nombre (o que nombre tiene esa IP).
async function lookup(host, { emit }) {
  const h = target(host);
  emit(`$ nslookup ${h}`);
  const lines = [];
  const say = (l) => { lines.push(l); emit(l); };
  let ok = false;
  const dom = await domainDns();
  const resolver = dom.servers.length ? new dns.promises.Resolver({ timeout: 2000, tries: 1 }) : null;
  if (resolver) resolver.setServers(dom.servers);
  if (IPV4.test(h)) {
    for (const [label, fn] of [[`DNS del dominio (${dom.servers[0] || '—'})`, resolver ? () => resolver.reverse(h) : null], ['DNS del servidor', () => dns.promises.reverse(h)]]) {
      if (!fn) continue;
      try { const names = await fn(); ok = ok || names.length > 0; say(`${label}: ${h} → ${names.join(', ')}`); } catch (err) { say(`${label}: ${h} sin nombre registrado (${err.code || err.message}).`); }
    }
  } else {
    const fqdn = h.includes('.') || !dom.domain ? h : `${h}.${dom.domain}`;
    if (resolver) {
      try { const a = await resolver.resolve4(fqdn); ok = true; say(`DNS del dominio (${dom.servers[0]}): ${fqdn} → ${a.join(', ')}`); } catch (err) { say(`DNS del dominio (${dom.servers[0]}): ${fqdn} no existe (${err.code || err.message}).`); }
    } else say('DNS del dominio: aún no se conocen los controladores de dominio (lea el directorio activo).');
    const inv = await inventoryIp(h);
    if (inv) { ok = true; say(`Registrado en ${inv.via}: ${h} → ${inv.ip}`); }
    try { const a = await dns.promises.lookup(h, { all: true }); ok = true; say(`DNS del servidor: ${h} → ${a.map((x) => x.address).join(', ')}`); } catch (err) { say(`DNS del servidor: ${h} no se resuelve (${err.code || err.message}).`); }
  }
  return { tool: 'dns', host: h, ok, summary: ok ? 'El nombre se resuelve.' : 'No se resuelve en ninguna de las fuentes.', output: lines.join('\n') };
}

// "80,443,3389" o "20-25" -> lista de puertos (tope MAX_PORTS). Vacio = los comunes.
function parsePorts(text) {
  const s = String(text || '').trim();
  if (!s) return Object.keys(COMMON_PORTS).map(Number);
  const out = new Set();
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
    if (!m) throw new Error(`Puerto no válido: "${part}". Use números separados por coma o un rango (ej. 80,443 o 8000-8010).`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 65535 || b < a) throw new Error(`Puerto fuera de rango: "${part}" (1 a 65535).`);
    for (let p = a; p <= b; p += 1) { out.add(p); if (out.size > MAX_PORTS) throw new Error(`Como máximo ${MAX_PORTS} puertos por consulta.`); }
  }
  return [...out].sort((x, y) => x - y);
}

function probe(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const end = (state) => { if (done) return; done = true; s.destroy(); resolve({ port, state, service: COMMON_PORTS[port] || '' }); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => end('abierto'));
    s.once('timeout', () => end('sin respuesta'));
    s.once('error', (err) => end(err.code === 'ECONNREFUSED' ? 'cerrado' : 'sin respuesta'));
    s.connect(port, ip);
  });
}

async function ports(host, portsText, { emit, signal, allowAny = false }) {
  const list = parsePorts(portsText);
  const r = await resolveTarget(host);
  if (!r.ip) throw new Error(`${r.host} no se resuelve desde el servidor de la aplicación: use la IP.`);
  if (!allowAny && !isPrivate(r.ip)) throw new Error(`${r.ip} no es una dirección de la red interna: la revisión de puertos solo se hace sobre equipos propios (10.x, 172.16-31.x, 192.168.x).`);
  emit(`$ puertos ${r.host} (${list.length} puertos TCP)`);
  announce(r, emit);
  const rows = [];
  const fmt = (x) => `${String(x.port).padStart(5)}/tcp  ${x.state.padEnd(13)} ${x.service}`;
  for (let i = 0; i < list.length && !(signal && signal.aborted); i += 20) {
    const batch = await Promise.all(list.slice(i, i + 20).map((p) => probe(r.ip, p, 1500)));
    batch.forEach((x) => { rows.push(x); emit(fmt(x)); });
  }
  const open = rows.filter((x) => x.state === 'abierto');
  return { tool: 'puertos', host: r.host, ip: r.ip, ok: open.length > 0, rows,
    summary: open.length ? `${open.length} puerto(s) abierto(s) de ${rows.length} revisados: ${open.map((x) => x.port + (x.service ? ` (${x.service})` : '')).join(', ')}.`
      : `Ninguno de los ${rows.length} puertos revisados está abierto (o un firewall los filtra).`,
    output: rows.map(fmt).join('\n') };
}

const TOOLS = { ping: ['Ping', '¿Responde el equipo?'], ruta: ['Ruta (saltos)', 'Por dónde pasa hasta llegar'], dns: ['DNS', 'Nombre ↔ IP'], puertos: ['Puertos abiertos', 'Qué servicios acepta'] };

// opts: { emit(linea) para ver el avance en vivo, signal para detener, allowAny }.
async function execute(tool, host, portsText, opts = {}) {
  const o = { emit: () => {}, ...opts };
  if (tool === 'ping') return ping(host, o);
  if (tool === 'ruta') return trace(host, o);
  if (tool === 'dns') return lookup(host, o);
  if (tool === 'puertos') return ports(host, portsText, o);
  throw new Error('Herramienta no válida.');
}

module.exports = { TOOLS, COMMON_PORTS, MAX_PORTS, execute, resolveTarget, _: { target, isPrivate, parsePorts } };
