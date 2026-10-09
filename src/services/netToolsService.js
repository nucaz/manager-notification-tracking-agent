// Modulo Red: herramientas de diagnostico que se ejecutan DESDE el servidor de
// la aplicacion (lo que se ve es la red vista desde ese servidor, no desde la
// PC de quien consulta): ping, ruta (saltos), DNS y puertos TCP abiertos.
//
// Limites deliberados:
//   - El destino se valida (nombre o IPv4) y va como argumento de execFile,
//     nunca dentro de una linea de comandos.
//   - La revision de puertos solo se hace sobre direcciones privadas de la red
//     interna (10/8, 172.16/12, 192.168/16): no sirve para explorar terceros.
//   - Tope de puertos por consulta, tiempo maximo y tope de salida.
const { execFile } = require('child_process');
const dns = require('dns').promises;
const net = require('net');

const HOST = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const MAX_PORTS = 100;
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

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 200 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim().slice(0, 20000);
      if (err && err.code === 'ENOENT') return resolve({ ok: false, output: `La herramienta "${cmd}" no está instalada en el servidor de la aplicación.` });
      if (err && err.killed) return resolve({ ok: false, output: `${out}\n\n(Se cortó: superó el tiempo máximo de ${Math.round(timeoutMs / 1000)} s.)`.trim() });
      return resolve({ ok: !err, output: out || (err ? err.message : '') });
    });
  });
}

async function ping(host) {
  const h = target(host);
  const r = await run('ping', ['-c', '4', '-W', '2', h], 15000);
  const loss = /(\d+)% packet loss/.exec(r.output);
  const avg = /= [\d.]+\/([\d.]+)\//.exec(r.output);
  const summary = !loss ? (r.ok ? 'Responde.' : 'No se pudo hacer ping (el nombre no resuelve o no hay ruta).')
    : (Number(loss[1]) === 100 ? 'No responde: se perdieron todos los paquetes (apagado, fuera de la red o con el ping bloqueado).'
      : `Responde${Number(loss[1]) ? ` con ${loss[1]}% de pérdida` : ''}${avg ? `; tiempo promedio ${avg[1]} ms` : ''}.`);
  return { tool: 'ping', host: h, ok: !!loss && Number(loss[1]) < 100, summary, output: r.output };
}

// Saltos hasta el destino. tracepath no necesita privilegios (traceroute si).
async function trace(host) {
  const h = target(host);
  const r = await run('tracepath', ['-n', '-m', '20', h], 60000);
  const hops = [];
  r.output.split('\n').forEach((line) => {
    const m = /^\s*(\d+):\s+(\S+)\s+([\d.]+ms)?/.exec(line);
    if (!m || /LOCALHOST/.test(line)) return;
    const n = Number(m[1]);
    const reply = m[2] === 'no' ? null : m[2];
    const prev = hops.find((x) => x.hop === n);
    if (prev) { if (!prev.address && reply) { prev.address = reply; prev.time = m[3] || ''; } } else hops.push({ hop: n, address: reply, time: reply ? (m[3] || '') : '' });
  });
  const reached = /Resume:.*|reached/i.test(r.output) && hops.some((x) => x.address);
  const last = [...hops].reverse().find((x) => x.address);
  return { tool: 'ruta', host: h, ok: reached, hops,
    summary: !hops.length ? 'No se pudo trazar la ruta.' : `${hops.filter((x) => x.address).length} salto(s) respondieron${last ? `; el último fue ${last.address}` : ''}. `
      + 'Un salto "sin respuesta" suele ser un equipo que no contesta estas pruebas, no necesariamente un corte.', output: r.output };
}

async function lookup(host) {
  const h = target(host);
  const lines = [];
  let ok = false;
  if (IPV4.test(h)) {
    try { const names = await dns.reverse(h); ok = names.length > 0; lines.push(`${h} → ${names.join(', ')}`); } catch (err) { lines.push(`${h}: sin nombre registrado (${err.code || err.message}).`); }
  } else {
    try {
      const addrs = await dns.lookup(h, { all: true });
      ok = addrs.length > 0;
      addrs.forEach((a) => lines.push(`${h} → ${a.address} (IPv${a.family})`));
      for (const a of addrs.filter((x) => x.family === 4).slice(0, 3)) {
        try { lines.push(`${a.address} → ${(await dns.reverse(a.address)).join(', ')}`); } catch (_) { lines.push(`${a.address}: sin registro inverso (PTR).`); }
      }
    } catch (err) { lines.push(`${h}: no se resuelve (${err.code || err.message}).`); }
  }
  return { tool: 'dns', host: h, ok, summary: ok ? 'El nombre se resuelve.' : 'No se resuelve desde el servidor de la aplicación.', output: lines.join('\n') };
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

async function ports(host, portsText, { allowAny = false } = {}) {
  const h = target(host);
  const list = parsePorts(portsText);
  let ip = h;
  if (!IPV4.test(h)) {
    try { ip = (await dns.lookup(h, { family: 4 })).address; } catch (err) { throw new Error(`${h} no se resuelve desde el servidor de la aplicación.`); }
  }
  if (!allowAny && !isPrivate(ip)) throw new Error(`${ip} no es una dirección de la red interna: la revisión de puertos solo se hace sobre equipos propios (10.x, 172.16-31.x, 192.168.x).`);
  const rows = [];
  for (let i = 0; i < list.length; i += 20) rows.push(...await Promise.all(list.slice(i, i + 20).map((p) => probe(ip, p, 1500))));
  const open = rows.filter((r) => r.state === 'abierto');
  return { tool: 'puertos', host: h, ip, ok: open.length > 0, rows,
    summary: open.length ? `${open.length} puerto(s) abierto(s) de ${rows.length} revisados: ${open.map((r) => r.port + (r.service ? ` (${r.service})` : '')).join(', ')}.`
      : `Ninguno de los ${rows.length} puertos revisados está abierto (o un firewall los filtra).`,
    output: rows.map((r) => `${String(r.port).padStart(5)}  ${r.state.padEnd(13)} ${r.service}`).join('\n') };
}

const TOOLS = { ping: ['Ping', '¿Responde el equipo?'], ruta: ['Ruta (saltos)', 'Por dónde pasa hasta llegar'], dns: ['DNS', 'Nombre ↔ IP'], puertos: ['Puertos abiertos', 'Qué servicios acepta'] };
async function execute(tool, host, portsText, opts) {
  if (tool === 'ping') return ping(host);
  if (tool === 'ruta') return trace(host);
  if (tool === 'dns') return lookup(host);
  if (tool === 'puertos') return ports(host, portsText, opts);
  throw new Error('Herramienta no válida.');
}

module.exports = { TOOLS, COMMON_PORTS, MAX_PORTS, execute, _: { target, isPrivate, parsePorts } };
