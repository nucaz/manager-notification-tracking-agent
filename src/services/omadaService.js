// Red > Omada: lee los controladores TP-Link Omada por su Open API oficial
// (la misma que usan las integraciones publicas) y guarda una copia para
// mostrar equipos, clientes y consumo sin depender de que el controlador
// responda en ese momento.
//
// SOLO LECTURA: este servicio unicamente hace GET (mas el POST que pide el
// token). No cambia nada en el controlador, aunque la aplicacion Open API
// tuviera permisos de administrador; con un rol "Viewer" es suficiente.
//
// Cada controlador (un OC300, o uno por software) tiene su propio
// identificador (omadacId) y su propia aplicacion Open API en modo "Client".
// La direccion de la interfaz sale en el propio controlador: Global >
// Settings > Platform Integration > Open API > ver la aplicacion.
const axios = require('axios');
const https = require('https');
const pool = require('../db/pool');
const cryptoService = require('./cryptoService');
const networkService = require('./networkService');

const SAMPLE_DAYS = 30;        // historial del grafico de consumo
const CLIENT_DAYS = 30;        // un cliente que no se ve en este tiempo se olvida
const PAGE_SIZE = 1000;        // maximo de la API
const MAX_PAGES = 20;
const TIMEOUT = 20000;
const STATUS = { 0: ['Desconectado', 'danger'], 1: ['Conectado', 'success'], 2: ['Pendiente', 'warning'], 3: ['Sin latido', 'warning'], 4: ['Aislado', 'warning'] };
const KINDS = { ap: ['Punto de acceso', 'bi-wifi'], switch: ['Switch', 'bi-hdd-network'], gateway: ['Gateway', 'bi-router'], otro: ['Otro', 'bi-box'] };
const RANGES = { 6: 'Últimas 6 horas', 24: 'Últimas 24 horas', 168: 'Últimos 7 días', 720: 'Últimos 30 días' };
// Codigos de la API "el token vencio" y "el token no es valido": se pide otro y se repite una vez.
const TOKEN_ERRORS = new Set([-44112, -44113]);

const _ = { allowHttp: false }; // las pruebas usan un controlador simulado sin TLS
const tokens = new Map();       // id del controlador -> { value, until }

const clean = (v, max) => { const s = String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim(); return s ? s.slice(0, max) : null; };
const mac = (v) => { try { return networkService.normalizeMac(v); } catch (e) { return null; } };
const int = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
const pct = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.min(100, Math.max(0, Math.round(Number(v)))));

function fmtBps(v) {
  const n = Number(v) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} Gbps`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} Mbps`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} Kbps`;
  return `${n} bps`;
}
function fmtBytes(v) {
  const n = Number(v) || 0;
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(2)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

// ---------------- controladores ----------------
function controllerInput(b, { isNew }) {
  const name = clean(b.name, 100);
  if (!name) throw new Error('Escriba un nombre para el controlador (ej. OC300 Pueblo Libre).');
  let url;
  try { url = new URL(String(b.base_url || '').trim()); } catch (e) { throw new Error('La dirección de la interfaz no es válida: debe ser como https://use1-omada-northbound.tplinkcloud.com'); }
  if (url.protocol !== 'https:' && !(_.allowHttp && url.protocol === 'http:')) throw new Error('La dirección de la interfaz debe empezar con https://');
  if (url.username || url.password || url.search || url.hash) throw new Error('La dirección de la interfaz no lleva usuario, parámetros ni #: solo https://servidor[:puerto]');
  const omadacId = String(b.omadac_id || '').trim();
  if (!/^[A-Za-z0-9]{8,64}$/.test(omadacId)) throw new Error('El Omada ID no es válido: son letras y números, sin espacios (aparece junto a la aplicación Open API).');
  const clientId = String(b.client_id || '').trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) throw new Error('El Client ID no es válido: cópielo tal como aparece en la aplicación Open API.');
  const secret = String(b.client_secret || '').trim();
  if (isNew && !secret) throw new Error('Escriba el Client Secret de la aplicación Open API.');
  if (secret && !/^[\x21-\x7e]{8,200}$/.test(secret)) throw new Error('El Client Secret no es válido: cópielo completo, sin espacios.');
  return { row: { name, base_url: url.origin, omadac_id: omadacId, client_id: clientId, verify_tls: b.verify_tls === '0' ? 0 : 1, enabled: b.enabled === '0' ? 0 : 1 }, secret };
}

// Sin el secreto: lo que se puede mostrar.
async function controllers() {
  const [rows] = await pool.query(`SELECT c.id, c.name, c.base_url, c.omadac_id, c.client_id, c.verify_tls, c.enabled, c.last_sync_at, c.last_sync_ok, c.last_sync_detail,
      (c.client_secret IS NOT NULL AND c.client_secret <> '') AS has_secret, (SELECT COUNT(*) FROM omada_sites s WHERE s.controller_id = c.id) AS sites
    FROM omada_controllers c ORDER BY c.name`);
  return rows;
}
async function controller(id) {
  return (await controllers()).find((c) => c.id === Number(id)) || null;
}
async function withSecret(id) {
  const [[c]] = await pool.query('SELECT * FROM omada_controllers WHERE id = ?', [Number(id) || 0]);
  if (!c) return null;
  return { ...c, client_secret: cryptoService.decrypt(c.client_secret) };
}

async function saveController(id, body, user) {
  const cur = id ? await withSecret(id) : null;
  if (id && !cur) throw new Error('El controlador ya no existe.');
  const { row, secret } = controllerInput(body, { isNew: !cur });
  const [[dup]] = await pool.query('SELECT id FROM omada_controllers WHERE base_url = ? AND omadac_id = ? AND id <> ?', [row.base_url, row.omadac_id, cur ? cur.id : 0]);
  if (dup) throw new Error('Ese controlador (misma dirección y mismo Omada ID) ya está registrado.');
  if (secret) row.client_secret = cryptoService.encrypt(secret);
  if (cur) {
    await pool.query('UPDATE omada_controllers SET ? WHERE id = ?', [row, cur.id]);
    tokens.delete(cur.id);
    return cur.id;
  }
  const [r] = await pool.query('INSERT INTO omada_controllers SET ?', [{ ...row, created_by: user ? user.id : null }]);
  return r.insertId;
}

async function deleteController(id) {
  const [r] = await pool.query('DELETE FROM omada_controllers WHERE id = ?', [Number(id) || 0]);
  tokens.delete(Number(id));
  return r.affectedRows > 0;
}

// ---------------- cliente de la API (solo GET) ----------------
const agentFor = (c) => (c.verify_tls ? undefined : new https.Agent({ rejectUnauthorized: false }));

// Un mensaje que diga que revisar, sin el secreto ni el token.
function explain(err) {
  if (err.omada) return err;
  const st = err.response && err.response.status;
  let msg = `No se pudo conectar con el controlador (${err.code || err.message}).`;
  if (st === 401 || st === 403) msg = 'El controlador rechazó las credenciales (Client ID o Client Secret).';
  else if (st === 404) msg = 'La dirección responde, pero no es la interfaz Open API (revise la dirección de la interfaz).';
  else if (st) msg = `El controlador respondió con el código ${st}.`;
  else if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(String(err.code))) msg = 'El certificado del controlador no es de confianza. Si es un controlador local con certificado propio, desactive "Verificar certificado".';
  else if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message)) msg = 'El controlador no respondió a tiempo.';
  else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') msg = 'No se pudo resolver el nombre del servidor (revise la dirección de la interfaz).';
  const e = new Error(msg);
  e.omada = true;
  return e;
}
// La API responde 200 con { errorCode, msg, result }.
function unwrap(data) {
  if (!data || typeof data !== 'object' || data.errorCode === undefined) throw explain({ message: 'respuesta inesperada', response: { status: 404 } });
  if (Number(data.errorCode) !== 0) {
    const e = new Error(`Omada respondió: ${clean(data.msg, 200) || 'error'} (código ${data.errorCode}).`);
    e.omada = true;
    e.code = Number(data.errorCode);
    throw e;
  }
  return data.result;
}

async function token(c, { fresh = false } = {}) {
  const hit = tokens.get(c.id);
  if (!fresh && hit && hit.until > Date.now()) return hit.value;
  if (!c.client_secret || cryptoService.isEncrypted(c.client_secret)) {
    const e = new Error('No se puede leer el Client Secret guardado (¿cambió la clave de cifrado del servidor?). Vuelva a escribirlo en la configuración.');
    e.omada = true;
    throw e;
  }
  let r;
  try {
    r = await axios.post(`${c.base_url}/openapi/authorize/token`, { omadacId: c.omadac_id, client_id: c.client_id, client_secret: c.client_secret },
      { params: { grant_type: 'client_credentials' }, timeout: TIMEOUT, httpsAgent: agentFor(c), maxRedirects: 0 });
  } catch (err) { throw explain(err); }
  const res = unwrap(r.data);
  if (!res || !res.accessToken) throw explain({ message: 'sin token', response: { status: 404 } });
  // Se renueva un minuto antes de que venza (dura 2 horas).
  if (c.id) tokens.set(c.id, { value: res.accessToken, until: Date.now() + Math.max(60, (Number(res.expiresIn) || 7200) - 60) * 1000 });
  return res.accessToken;
}

async function get(c, path, params = {}) {
  const once = async (fresh) => {
    const tok = await token(c, { fresh });
    let r;
    try {
      r = await axios.get(`${c.base_url}/openapi/v1/${encodeURIComponent(c.omadac_id)}${path}`,
        { params, headers: { Authorization: `AccessToken=${tok}` }, timeout: TIMEOUT, httpsAgent: agentFor(c), maxRedirects: 0 });
    } catch (err) { throw explain(err); }
    return unwrap(r.data);
  };
  try { return await once(false); } catch (err) {
    if (!TOKEN_ERRORS.has(err.code)) throw err;
    return once(true);
  }
}
// Listas paginadas: { totalRows, data }.
async function getAll(c, path) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await get(c, path, { page, pageSize: PAGE_SIZE });
    const data = (res && res.data) || [];
    out.push(...data);
    if (!data.length || out.length >= (Number(res.totalRows) || 0)) break;
  }
  return out;
}

// Prueba de conexion: pide el token y lista los sitios.
async function test(id) {
  const c = await withSecret(id);
  if (!c) throw new Error('El controlador ya no existe.');
  tokens.delete(c.id);
  const sites = await getAll(c, '/sites');
  return { sites: sites.map((s) => clean(s.name, 100)).filter(Boolean) };
}

// ---------------- lectura ----------------
const kindOf = (t) => { const k = String(t || '').toLowerCase(); return KINDS[k] && k !== 'otro' ? k : 'otro'; };

async function syncSite(c, s, now) {
  await pool.query(`INSERT INTO omada_sites (controller_id, site_key, name, region) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE name = VALUES(name), region = VALUES(region)`, [c.id, String(s.siteId), clean(s.name, 100) || String(s.siteId), clean(s.region, 60)]);
  const [[site]] = await pool.query('SELECT id FROM omada_sites WHERE controller_id = ? AND site_key = ?', [c.id, String(s.siteId)]);
  const base = `/sites/${encodeURIComponent(s.siteId)}`;
  const [devs, clis] = [await getAll(c, `${base}/devices`), await getAll(c, `${base}/clients`)];

  // Clientes: los que vienen en la lista estan conectados ahora.
  const perDevice = new Map();
  let down = 0; let up = 0; let wireless = 0; let total = 0;
  await pool.query('UPDATE omada_clients SET active = 0, down_bps = 0, up_bps = 0 WHERE site_id = ? AND active = 1', [site.id]);
  for (const x of clis) {
    const m = mac(x.mac);
    if (!m) continue;
    const isWifi = !!x.wireless;
    const via = mac(isWifi ? x.apMac : (x.switchMac || x.gatewayMac));
    const row = {
      site_id: site.id, mac: m, name: clean(x.name || x.hostName, 150), vendor: clean(x.vendor, 100), device_type: clean(x.deviceType || x.deviceCategory, 40), ip: clean(x.ip, 45),
      wireless: isWifi ? 1 : 0, ssid: isWifi ? clean(x.ssid, 64) : null, via_mac: via, via_name: clean(isWifi ? x.apName : (x.switchName || x.gatewayName), 150),
      via_port: isWifi ? null : clean(x.portName || x.standardPort || x.port, 40), vlan: Number.isInteger(x.vid) ? x.vid : null, signal_pct: isWifi ? pct(x.signalLevel) : null,
      down_bps: int(x.activity) * 8, up_bps: int(x.uploadActivity) * 8, traffic_down: int(x.trafficDown), traffic_up: int(x.trafficUp), active: 1, last_seen: now,
    };
    await pool.query('INSERT INTO omada_clients SET ? ON DUPLICATE KEY UPDATE ?', [row, row]);
    total += 1;
    if (isWifi) wireless += 1;
    down += row.down_bps;
    up += row.up_bps;
    if (via) perDevice.set(via, (perDevice.get(via) || 0) + 1);
  }

  // Equipos.
  let online = 0; let present = 0;
  await pool.query('UPDATE omada_devices SET present = 0 WHERE site_id = ?', [site.id]);
  for (const d of devs) {
    const m = mac(d.mac);
    if (!m) continue;
    const st = STATUS[d.status] ? Number(d.status) : 0;
    const row = {
      site_id: site.id, mac: m, name: clean(d.name, 150) || m, kind: kindOf(d.type), model: clean(d.model || d.modelName, 100), ip: clean(d.ip, 45), status: st,
      cpu: pct(d.cpuUtil), mem: pct(d.memUtil), uptime: clean(d.uptime, 40), firmware: clean(d.firmwareVersion, 80), serial: clean(d.sn, 60),
      uplink_name: clean(d.uplinkDeviceName, 150), uplink_port: clean(d.uplinkDevicePort, 40), clients: perDevice.get(m) || 0, present: 1, synced_at: now,
    };
    await pool.query('INSERT INTO omada_devices SET ? ON DUPLICATE KEY UPDATE ?', [row, row]);
    present += 1;
    if (st === 1) online += 1;
  }
  await pool.query('DELETE FROM omada_devices WHERE site_id = ? AND present = 0 AND (synced_at IS NULL OR synced_at < ? - INTERVAL ? DAY)', [site.id, now, CLIENT_DAYS]);

  await pool.query('UPDATE omada_sites SET devices_total = ?, devices_online = ?, clients_total = ?, clients_wireless = ?, down_bps = ?, up_bps = ?, synced_at = ? WHERE id = ?',
    [present, online, total, wireless, down, up, now, site.id]);
  await pool.query('INSERT INTO omada_samples (site_id, taken_at, clients, wireless, down_bps, up_bps, devices_offline) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [site.id, now, total, wireless, down, up, present - online]);
  return { name: clean(s.name, 100), devices: present, clients: total };
}

async function syncController(id) {
  const c = await withSecret(id);
  if (!c) throw new Error('El controlador ya no existe.');
  // La hora la pone la base: es la misma con la que luego se compara (NOW()).
  const [[{ now }]] = await pool.query('SELECT NOW() AS now');
  try {
    const sites = await getAll(c, '/sites');
    const done = [];
    for (const s of sites) if (s && s.siteId) done.push(await syncSite(c, s, now));
    // Un sitio que ya no existe en el controlador se quita (con sus equipos, clientes y muestras).
    const keys = sites.map((s) => String(s.siteId));
    await pool.query(`DELETE FROM omada_sites WHERE controller_id = ?${keys.length ? ' AND site_key NOT IN (?)' : ''}`, keys.length ? [c.id, keys] : [c.id]);
    const detail = done.length ? done.map((d) => `${d.name}: ${d.devices} equipos, ${d.clients} clientes`).join(' · ') : 'El controlador no tiene sitios visibles para esta aplicación.';
    await pool.query('UPDATE omada_controllers SET last_sync_at = ?, last_sync_ok = 1, last_sync_detail = ? WHERE id = ?', [now, detail.slice(0, 500), c.id]);
    return { ok: true, name: c.name, detail };
  } catch (err) {
    const detail = (err.omada ? err.message : `Error interno: ${err.message}`).slice(0, 500);
    await pool.query('UPDATE omada_controllers SET last_sync_at = ?, last_sync_ok = 0, last_sync_detail = ? WHERE id = ?', [now, detail, c.id]);
    return { ok: false, name: c.name, detail };
  }
}

let running = false;
async function sync() {
  if (running) return { skipped: true, results: [] };
  running = true;
  try {
    const [rows] = await pool.query('SELECT id FROM omada_controllers WHERE enabled = 1 ORDER BY id');
    const results = [];
    for (const r of rows) results.push(await syncController(r.id));
    await pool.query('DELETE FROM omada_samples WHERE taken_at < NOW() - INTERVAL ? DAY', [SAMPLE_DAYS]);
    await pool.query('DELETE FROM omada_clients WHERE active = 0 AND (last_seen IS NULL OR last_seen < NOW() - INTERVAL ? DAY)', [CLIENT_DAYS]);
    return { skipped: false, results };
  } finally {
    running = false;
  }
}

// ---------------- consultas para las pantallas ----------------
async function sites() {
  const [rows] = await pool.query(`SELECT s.*, c.name AS controller_name, c.enabled, c.last_sync_ok, c.last_sync_detail, c.last_sync_at
    FROM omada_sites s JOIN omada_controllers c ON c.id = s.controller_id ORDER BY s.name`);
  return rows;
}

async function devices({ siteId = 0 } = {}) {
  const [rows] = await pool.query(`SELECT d.*, s.name AS site_name, n.id AS inventory_id
    FROM omada_devices d JOIN omada_sites s ON s.id = d.site_id
    LEFT JOIN network_devices n ON n.mac = d.mac
    WHERE d.present = 1${siteId ? ' AND d.site_id = ?' : ''} ORDER BY s.name, FIELD(d.kind, 'gateway', 'switch', 'ap', 'otro'), d.name`, siteId ? [siteId] : []);
  return rows;
}

// Los clientes, con el nombre del inventario de Red cuando la MAC coincide.
async function clients({ siteId = 0, onlyActive = true } = {}) {
  const where = ['1=1'];
  const args = [];
  if (siteId) { where.push('k.site_id = ?'); args.push(siteId); }
  if (onlyActive) where.push('k.active = 1');
  const [rows] = await pool.query(`SELECT k.*, s.name AS site_name, n.id AS inventory_id, n.name AS inventory_name, n.kind AS inventory_kind
    FROM omada_clients k JOIN omada_sites s ON s.id = k.site_id
    LEFT JOIN network_devices n ON n.id = (SELECT MIN(n2.id) FROM network_devices n2 WHERE n2.mac = k.mac OR n2.mac_wifi = k.mac)
    WHERE ${where.join(' AND ')} ORDER BY k.active DESC, (k.traffic_down + k.traffic_up) DESC, k.name`, args);
  return rows;
}

async function samples({ siteId = 0, hours = 24 } = {}) {
  const h = RANGES[hours] ? Number(hours) : 24;
  // Con varios sitios se suman las muestras de la misma lectura.
  const [rows] = await pool.query(`SELECT taken_at, SUM(clients) AS clients, SUM(wireless) AS wireless, SUM(down_bps) AS down_bps, SUM(up_bps) AS up_bps, SUM(devices_offline) AS devices_offline
    FROM omada_samples WHERE taken_at >= NOW() - INTERVAL ? HOUR${siteId ? ' AND site_id = ?' : ''} GROUP BY taken_at ORDER BY taken_at`, siteId ? [h, siteId] : [h]);
  // Un grafico no necesita mas de ~300 puntos: se promedian por tramos.
  const max = 300;
  if (rows.length <= max) return rows.map((r) => ({ t: r.taken_at, clients: Number(r.clients), wireless: Number(r.wireless), down: Number(r.down_bps), up: Number(r.up_bps), offline: Number(r.devices_offline) }));
  const size = Math.ceil(rows.length / max);
  const out = [];
  for (let i = 0; i < rows.length; i += size) {
    const part = rows.slice(i, i + size);
    const avg = (k) => Math.round(part.reduce((t, r) => t + Number(r[k]), 0) / part.length);
    out.push({ t: part[part.length - 1].taken_at, clients: avg('clients'), wireless: avg('wireless'), down: avg('down_bps'), up: avg('up_bps'), offline: Math.max(...part.map((r) => Number(r.devices_offline))) });
  }
  return out;
}

// Todo lo del tablero para un sitio (o para todos).
async function dashboard({ siteId = 0, hours = 24 } = {}) {
  const allSites = await sites();
  const chosen = siteId ? allSites.filter((s) => s.id === siteId) : allSites;
  const devs = await devices({ siteId });
  const clis = await clients({ siteId });
  const sum = (k) => chosen.reduce((t, s) => t + Number(s[k] || 0), 0);
  const group = (key) => {
    const m = new Map();
    clis.forEach((c) => { const k = key(c); if (!k) return; const g = m.get(k) || { label: k, clients: 0, bytes: 0 }; g.clients += 1; g.bytes += Number(c.traffic_down) + Number(c.traffic_up); m.set(k, g); });
    return [...m.values()].sort((a, b) => b.clients - a.clients);
  };
  return {
    sites: allSites, chosen,
    totals: { devices: sum('devices_total'), online: sum('devices_online'), clients: sum('clients_total'), wireless: sum('clients_wireless'), down: sum('down_bps'), up: sum('up_bps'),
      aps: devs.filter((d) => d.kind === 'ap').length, switches: devs.filter((d) => d.kind === 'switch').length },
    offline: devs.filter((d) => d.status !== 1),
    series: await samples({ siteId, hours }),
    topClients: clis.slice(0, 10),
    topAps: devs.filter((d) => d.kind === 'ap').sort((a, b) => b.clients - a.clients).slice(0, 10),
    bySsid: group((c) => (c.wireless ? c.ssid || '(sin SSID)' : null)),
    weak: clis.filter((c) => c.wireless && c.signal_pct !== null && c.signal_pct < 40).sort((a, b) => a.signal_pct - b.signal_pct).slice(0, 10),
  };
}

// Registra en el inventario de Red (pestaña Equipos) los AP, switches y
// gateway que Omada conoce y que aun no estan (por MAC). No pisa nada.
async function registerInInventory(user) {
  const devs = await devices();
  const map = { ap: 'ap', switch: 'switch', gateway: 'router', otro: 'otro' };
  let created = 0;
  for (const d of devs) {
    if (d.inventory_id) continue;
    const [[taken]] = await pool.query('SELECT id FROM network_devices WHERE mac = ? OR mac_wifi = ?', [d.mac, d.mac]);
    if (taken) continue;
    await pool.query('INSERT INTO network_devices SET ?', [{ kind: map[d.kind] || 'otro', name: d.name, mac: d.mac, ip: /^\d{1,3}(\.\d{1,3}){3}$/.test(d.ip || '') ? d.ip : null,
      brand_model: d.model, serial: d.serial, notes: `Omada: sitio ${d.site_name}`.slice(0, 500), source: 'omada', created_by: user ? user.id : null }]);
    created += 1;
  }
  return { created, total: devs.length };
}

module.exports = {
  STATUS, KINDS, RANGES, fmtBps, fmtBytes, controllers, controller, saveController, deleteController, test, sync, syncController,
  sites, devices, clients, samples, dashboard, registerInInventory, _,
};
