// Modulo Red: inventario de equipos (PC, celulares, AP, switches...), sus
// direcciones MAC e IP, y las VLAN.
//   - PC: se traen de lo que la aplicacion ya conoce (GLPI: nombre, MAC, IP,
//     serie; directorio activo: nombre e IP) y se completan a mano. Traerlas
//     de nuevo nunca pisa lo que se escribio a mano.
//   - Celulares: son los del modulo Celulares (codigo, IMEI, sede, area); aqui
//     se les agrega MAC, IP, ubicacion y VLAN.
//   - AP, switches y demas: a mano.
const pool = require('../db/pool');
const cryptoService = require('./cryptoService');

const KINDS = {
  pc: ['PC', 'bi-pc-display'], celular: ['Celular', 'bi-phone'], ap: ['Punto de acceso (AP)', 'bi-wifi'], switch: ['Switch', 'bi-hdd-network'],
  router: ['Router', 'bi-router'], firewall: ['Firewall', 'bi-shield'], impresora: ['Impresora', 'bi-printer'], servidor: ['Servidor', 'bi-server'],
  otro: ['Otro', 'bi-box'],
};
const SOURCES = { manual: 'A mano', glpi: 'GLPI', ad: 'Directorio activo', celular: 'Celulares', omada: 'Omada' };

const clean = (v, max) => { const s = String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim(); return s ? s.slice(0, max) : null; };

// Acepta AA:BB:CC:DD:EE:FF, aa-bb-cc-dd-ee-ff, aabb.ccdd.eeff o aabbccddeeff.
// Devuelve AA:BB:CC:DD:EE:FF, null si viene vacio, o lanza si no es una MAC.
function normalizeMac(v, label = 'La dirección MAC') {
  const raw = String(v === undefined || v === null ? '' : v).trim();
  if (!raw) return null;
  const hex = raw.replace(/[:\-.\s]/g, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(hex)) throw new Error(`${label} no es válida: son 12 dígitos hexadecimales (ej. AA:BB:CC:DD:EE:FF).`);
  if (/^0{12}$|^F{12}$/.test(hex)) throw new Error(`${label} no es válida (todo ceros o difusión).`);
  return hex.match(/.{2}/g).join(':');
}
const macOrNull = (v) => { try { return normalizeMac(v); } catch (_) { return null; } };

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
function normalizeIp(v, label = 'La IP') {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return null;
  if (!IPV4.test(s)) throw new Error(`${label} no es válida (ej. 172.16.1.20).`);
  return s;
}
function normalizeSubnet(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return null;
  const [ip, bits] = s.split('/');
  if (!IPV4.test(ip) || !/^\d{1,2}$/.test(bits || '') || Number(bits) > 32) throw new Error('La subred no es válida (ej. 172.16.10.0/24).');
  return `${ip}/${Number(bits)}`;
}

// ------------------------------ VLAN ------------------------------
async function vlans() {
  const [rows] = await pool.query(
    `SELECT v.*, (SELECT COUNT(*) FROM network_device_vlans dv WHERE dv.vlan_id = v.id) AS devices_count
     FROM network_vlans v ORDER BY v.sede IS NULL DESC, v.sede, v.vlan_number`
  );
  return rows;
}
async function vlan(id) {
  const [[row]] = await pool.query('SELECT * FROM network_vlans WHERE id = ?', [Number(id) || 0]);
  return row || null;
}
function vlanInput(b) {
  const number = Number(String(b.vlan_number || '').trim());
  if (!Number.isInteger(number) || number < 1 || number > 4094) throw new Error('El número de VLAN va de 1 a 4094.');
  const name = clean(b.name, 100);
  if (!name) throw new Error('Indique el nombre de la VLAN.');
  return { vlan_number: number, name, subnet: normalizeSubnet(b.subnet), gateway: normalizeIp(b.gateway, 'La puerta de enlace'), sede: clean(b.sede, 100), notes: clean(b.notes, 500) };
}
async function saveVlan(id, body, user) {
  const v = vlanInput(body);
  const [[dup]] = await pool.query('SELECT id FROM network_vlans WHERE vlan_number = ? AND sede <=> ? AND id <> ?', [v.vlan_number, v.sede, Number(id) || 0]);
  if (dup) throw new Error(`Ya existe la VLAN ${v.vlan_number}${v.sede ? ` en ${v.sede}` : ' (todas las sedes)'}.`);
  if (id) {
    await pool.query('UPDATE network_vlans SET ? WHERE id = ?', [v, Number(id)]);
    return Number(id);
  }
  const [r] = await pool.query('INSERT INTO network_vlans SET ?', [{ ...v, created_by: user ? user.id : null }]);
  return r.insertId;
}
async function deleteVlan(id) {
  const [r] = await pool.query('DELETE FROM network_vlans WHERE id = ?', [Number(id) || 0]);
  return r.affectedRows > 0;
}

// ------------------------------ equipos ------------------------------
const DEVICE_SQL = `SELECT d.*, (SELECT GROUP_CONCAT(CONCAT(v.vlan_number, ' ', v.name) ORDER BY v.vlan_number SEPARATOR ', ')
    FROM network_device_vlans dv JOIN network_vlans v ON v.id = dv.vlan_id WHERE dv.device_id = d.id) AS vlan_names FROM network_devices d`;

// Equipos que no son celulares (esos se listan desde el modulo Celulares).
async function devices() {
  const [rows] = await pool.query(`${DEVICE_SQL} WHERE d.kind <> 'celular' ORDER BY d.kind, d.name`);
  return rows;
}
async function device(id) {
  const [[row]] = await pool.query(`${DEVICE_SQL} WHERE d.id = ?`, [Number(id) || 0]);
  if (!row) return null;
  const [v] = await pool.query('SELECT vlan_id FROM network_device_vlans WHERE device_id = ?', [row.id]);
  return { ...row, vlan_ids: v.map((x) => x.vlan_id) };
}

// Todos los celulares del inventario, con lo de red si ya se registro.
async function phones() {
  const [rows] = await pool.query(
    `SELECT m.id AS mobile_id, m.asset_code, m.imei, m.brand, m.model, m.sede, m.area, m.status, m.phone_number,
            d.id AS device_id, d.mac, d.ip, d.location, d.notes AS net_notes,
            (SELECT GROUP_CONCAT(CONCAT(v.vlan_number, ' ', v.name) ORDER BY v.vlan_number SEPARATOR ', ')
               FROM network_device_vlans dv JOIN network_vlans v ON v.id = dv.vlan_id WHERE dv.device_id = d.id) AS vlan_names,
            (SELECT a.holder_name FROM mobile_device_assignments a WHERE a.device_id = m.id AND a.returned_date IS NULL ORDER BY a.id DESC LIMIT 1) AS holder_name
     FROM mobile_devices m LEFT JOIN network_devices d ON d.mobile_device_id = m.id
     ORDER BY m.asset_code IS NULL, m.asset_code, m.imei`
  );
  return rows;
}
async function phone(mobileId) {
  const [[m]] = await pool.query('SELECT id, asset_code, imei, brand, model, sede, area, status FROM mobile_devices WHERE id = ?', [Number(mobileId) || 0]);
  if (!m) return null;
  const [[d]] = await pool.query('SELECT * FROM network_devices WHERE mobile_device_id = ?', [m.id]);
  const [v] = d ? await pool.query('SELECT vlan_id FROM network_device_vlans WHERE device_id = ?', [d.id]) : [[]];
  return { mobile: m, device: d ? { ...d, vlan_ids: v.map((x) => x.vlan_id) } : null };
}

async function macTaken(mac, exceptId) {
  if (!mac) return null;
  const [[row]] = await pool.query('SELECT id, name, kind FROM network_devices WHERE (mac = ? OR mac_wifi = ?) AND id <> ? LIMIT 1', [mac, mac, Number(exceptId) || 0]);
  return row || null;
}
async function setVlans(conn, deviceId, ids) {
  const list = [...new Set([].concat(ids || []).map(Number).filter((n) => n > 0))];
  await conn.query('DELETE FROM network_device_vlans WHERE device_id = ?', [deviceId]);
  if (!list.length) return;
  const [ok] = await conn.query('SELECT id FROM network_vlans WHERE id IN (?)', [list]);
  if (ok.length) await conn.query('INSERT INTO network_device_vlans (device_id, vlan_id) VALUES ?', [ok.map((v) => [deviceId, v.id])]);
}

function deviceInput(b, { phone: isPhone = false } = {}) {
  const kind = isPhone ? 'celular' : String(b.kind || '');
  if (!KINDS[kind] || (!isPhone && kind === 'celular')) throw new Error('Elija el tipo de equipo.');
  const name = clean(b.name, 150);
  if (!name) throw new Error('Indique el nombre del equipo.');
  const mac = normalizeMac(b.mac);
  const macWifi = isPhone ? null : normalizeMac(b.mac_wifi, 'La segunda MAC');
  if (mac && macWifi && mac === macWifi) throw new Error('Las dos direcciones MAC son la misma.');
  return { kind, name, mac, mac_wifi: macWifi, ip: normalizeIp(b.ip), sede: clean(b.sede, 100), area: clean(b.area, 100), location: clean(b.location, 150),
    brand_model: clean(b.brand_model, 150), serial: clean(b.serial, 100), notes: clean(b.notes, 500) };
}

async function saveRow(id, data, vlanIds, user) {
  for (const m of [data.mac, data.mac_wifi]) {
    const other = await macTaken(m, id);
    if (other) throw new Error(`La MAC ${m} ya está registrada en ${other.name} (${(KINDS[other.kind] || [other.kind])[0]}).`);
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let rowId = Number(id) || 0;
    if (rowId) await conn.query('UPDATE network_devices SET ? WHERE id = ?', [data, rowId]);
    else rowId = (await conn.query('INSERT INTO network_devices SET ?', [{ ...data, created_by: user ? user.id : null }]))[0].insertId;
    await setVlans(conn, rowId, vlanIds);
    await conn.commit();
    return rowId;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function saveDevice(id, body, user) {
  const data = deviceInput(body);
  if (id) {
    const [[cur]] = await pool.query('SELECT kind FROM network_devices WHERE id = ?', [Number(id)]);
    if (!cur || cur.kind === 'celular') throw new Error('El equipo ya no existe.');
  }
  return saveRow(id, id ? data : { ...data, source: 'manual' }, body.vlan_ids, user);
}

// Datos de red de un celular: sede, area, codigo e IMEI siguen siendo los de Celulares.
async function savePhone(mobileId, body, user) {
  const p = await phone(mobileId);
  if (!p) throw new Error('El celular ya no existe en el inventario.');
  const data = deviceInput({ ...body, name: p.mobile.asset_code || p.mobile.imei }, { phone: true });
  const row = { kind: 'celular', name: data.name, mac: data.mac, mac_wifi: null, ip: data.ip, location: data.location, notes: data.notes, sede: null, area: null,
    brand_model: null, serial: null };
  return saveRow(p.device ? p.device.id : 0, p.device ? row : { ...row, source: 'celular', mobile_device_id: p.mobile.id }, body.vlan_ids, user);
}

async function deleteDevice(id) {
  const [r] = await pool.query("DELETE FROM network_devices WHERE id = ? AND kind <> 'celular'", [Number(id) || 0]);
  return r.affectedRows > 0;
}

// ------------------------------ switches y AP ------------------------------
// Ficha tecnica (network_device_specs, 1:1) de los equipos de tipo switch o AP.
const INFRA_KINDS = ['switch', 'ap'];
const POE = { no: 'No PoE', poe: 'PoE (802.3af)', poe_plus: 'PoE+ (802.3at)', poe_pp: 'PoE++ (802.3bt)', pasivo: 'PoE pasivo' };
const SPEEDS = { fast: 'Fast Ethernet (100 Mbps)', gigabit: 'Gigabit (1 Gbps)', multigig: 'Multigigabit (2.5 / 5 Gbps)', '10g': '10 Gigabit' };
// Formas de consultar o gestionar el equipo: [nombre, formato de datos, tipo de comunicacion, ideal para].
const PROTOCOLS = {
  rest: ['REST API (HTTPS)', 'JSON / XML', 'Consulta (petición / respuesta)', 'Integración directa con paneles web y scripts personalizados.'],
  restconf: ['RESTCONF', 'JSON / XML', 'Consulta (petición / respuesta)', 'Configuración y monitoreo estándar basado en modelos YANG.'],
  snmp: ['SNMP', 'MIB / OID (binario)', 'Consulta (petición / respuesta)', 'Herramientas de monitoreo tradicionales (Zabbix, PRTG).'],
  grpc: ['gRPC Telemetry', 'Protocol Buffers', 'Flujo continuo (streaming)', 'Analítica avanzada en tiempo real y grandes volúmenes de datos.'],
};
// Estado del equipo: solo los que estan en uso se monitorean.
const STATES = { en_uso: ['En uso', 'success'], stock: ['En stock', 'info'], reparacion: ['En reparación', 'warning'], baja: ['De baja', 'secondary'] };
const INFRA_SQL = `SELECT d.*, sp.model_id, sp.brand, sp.model, sp.port_count, sp.poe, sp.speed, sp.floor, sp.uplink1, sp.uplink2, sp.protocols, COALESCE(sp.state, 'en_uso') AS state, sp.mgmt_user,
    (sp.mgmt_password IS NOT NULL AND sp.mgmt_password <> '') AS has_password, md.brand_id,
    COALESCE(mo.method, 'auto') AS mon_method, mo.port AS mon_port, (mo.community IS NOT NULL AND mo.community <> '') AS has_community,
    mo.status AS mon_status, mo.detail AS mon_detail, mo.latency_ms AS mon_ms, mo.checked_at AS mon_checked_at, mo.changed_at AS mon_changed_at,
    (SELECT GROUP_CONCAT(v.vlan_number ORDER BY v.vlan_number SEPARATOR ', ') FROM network_device_vlans dv JOIN network_vlans v ON v.id = dv.vlan_id WHERE dv.device_id = d.id) AS vlan_numbers,
    (SELECT GROUP_CONCAT(CONCAT(v.vlan_number, ' ', v.name) ORDER BY v.vlan_number SEPARATOR ', ') FROM network_device_vlans dv JOIN network_vlans v ON v.id = dv.vlan_id WHERE dv.device_id = d.id) AS vlan_names
  FROM network_devices d LEFT JOIN network_device_specs sp ON sp.device_id = d.id LEFT JOIN network_models md ON md.id = sp.model_id
    LEFT JOIN network_device_monitor mo ON mo.device_id = d.id`;

async function infra() {
  const [rows] = await pool.query(`${INFRA_SQL} WHERE d.kind IN (?) ORDER BY d.sede, sp.floor, d.kind DESC, d.name`, [INFRA_KINDS]);
  return rows;
}
async function infraDevice(id) {
  const [[row]] = await pool.query(`${INFRA_SQL} WHERE d.id = ? AND d.kind IN (?)`, [Number(id) || 0, INFRA_KINDS]);
  if (!row) return null;
  const [v] = await pool.query('SELECT vlan_id FROM network_device_vlans WHERE device_id = ?', [row.id]);
  return { ...row, vlan_ids: v.map((x) => x.vlan_id) };
}

// --- catalogo de marcas y modelos (tablas network_brands y network_models) ---
async function brands({ all = false } = {}) {
  const [rows] = await pool.query(`SELECT b.*, (SELECT COUNT(*) FROM network_models m WHERE m.brand_id = b.id) AS models FROM network_brands b${all ? '' : ' WHERE b.active = 1'} ORDER BY b.name`);
  return rows;
}
async function models({ all = false } = {}) {
  const [rows] = await pool.query(`SELECT m.*, b.name AS brand_name, (SELECT COUNT(*) FROM network_device_specs sp WHERE sp.model_id = m.id) AS devices
    FROM network_models m JOIN network_brands b ON b.id = m.brand_id${all ? '' : ' WHERE m.active = 1 AND b.active = 1'} ORDER BY b.name, m.name`);
  return rows;
}
function portsInput(v) {
  const ports = String(v === undefined || v === null ? '' : v).trim();
  if (ports && !(/^\d{1,4}$/.test(ports) && Number(ports) >= 1 && Number(ports) <= 1024)) throw new Error('La cantidad de puertos debe ser un número entre 1 y 1024.');
  return ports ? Number(ports) : null;
}
async function saveBrand(body, user) {
  const name = clean(body.name, 80);
  if (!name) throw new Error('Escriba el nombre de la marca.');
  const [[dup]] = await pool.query('SELECT id FROM network_brands WHERE name = ?', [name]);
  if (dup) throw new Error(`La marca ${name} ya está en el catálogo.`);
  return (await pool.query('INSERT INTO network_brands SET ?', [{ name, created_by: user ? user.id : null }]))[0].insertId;
}
async function saveModel(id, body, user) {
  const name = clean(body.name, 100);
  if (!name) throw new Error('Escriba el nombre del modelo.');
  const [[brand]] = await pool.query('SELECT id, name FROM network_brands WHERE id = ?', [Number(body.brand_id) || 0]);
  if (!brand) throw new Error('Elija la marca del modelo.');
  if (!INFRA_KINDS.includes(String(body.kind))) throw new Error('Indique si el modelo es un switch o un punto de acceso.');
  const row = { brand_id: brand.id, name, kind: String(body.kind), port_count: portsInput(body.port_count), poe: POE[body.poe] ? body.poe : null, speed: SPEEDS[body.speed] ? body.speed : null };
  const [[dup]] = await pool.query('SELECT id FROM network_models WHERE brand_id = ? AND name = ? AND id <> ?', [brand.id, name, Number(id) || 0]);
  if (dup) throw new Error(`El modelo ${brand.name} ${name} ya está en el catálogo.`);
  if (Number(id)) {
    const [r] = await pool.query('UPDATE network_models SET ? WHERE id = ?', [row, Number(id)]);
    if (!r.affectedRows) throw new Error('El modelo ya no existe.');
    // Las fichas guardan una copia de marca y modelo (para buscar y listar): se actualizan.
    await pool.query('UPDATE network_device_specs SET brand = ?, model = ? WHERE model_id = ?', [brand.name, name, Number(id)]);
    await pool.query('UPDATE network_devices d JOIN network_device_specs sp ON sp.device_id = d.id SET d.brand_model = ? WHERE sp.model_id = ?', [`${brand.name} ${name}`.slice(0, 150), Number(id)]);
    return Number(id);
  }
  return (await pool.query('INSERT INTO network_models SET ?', [{ ...row, created_by: user ? user.id : null }]))[0].insertId;
}
// Activa o desactiva (un elemento desactivado deja de ofrecerse, sin tocar los equipos que ya lo tienen).
async function setCatalogActive(table, id, active) {
  const t = table === 'marca' ? 'network_brands' : 'network_models';
  const [r] = await pool.query('UPDATE ?? SET active = ? WHERE id = ?', [t, active ? 1 : 0, Number(id) || 0]);
  return r.affectedRows > 0;
}
// Solo se borra lo que ningun equipo usa.
async function deleteCatalog(table, id) {
  const n = Number(id) || 0;
  if (table === 'marca') {
    const [[u]] = await pool.query('SELECT COUNT(*) AS n FROM network_models WHERE brand_id = ?', [n]);
    if (Number(u.n)) throw new Error('Esa marca tiene modelos: quite primero sus modelos, o desactívela.');
    return (await pool.query('DELETE FROM network_brands WHERE id = ?', [n]))[0].affectedRows > 0;
  }
  const [[u]] = await pool.query('SELECT COUNT(*) AS n FROM network_device_specs WHERE model_id = ?', [n]);
  if (Number(u.n)) throw new Error(`Ese modelo lo usan ${u.n} equipo(s): desactívelo en lugar de borrarlo.`);
  return (await pool.query('DELETE FROM network_models WHERE id = ?', [n]))[0].affectedRows > 0;
}

// Sede y area salen del catalogo general (Configuracion > Catalogos). Se acepta
// tambien el valor que el equipo ya tenia, aunque luego se haya quitado del catalogo.
async function fromCatalog(type, value, current, label) {
  const v = clean(value, 100);
  if (!v || v === (current || null)) return v;
  const [[hit]] = await pool.query('SELECT value FROM catalog_items WHERE catalog_type = ? AND value = ? AND active = 1', [type, v]);
  if (!hit) throw new Error(`${label} «${v}» no está en el catálogo. Agréguela en Configuración → Catálogos.`);
  return hit.value;
}

function specInput(b) {
  const pick = (v, set) => (set[v] ? v : null);
  const protocols = [...new Set([].concat(b.protocols || []).map(String))].filter((p) => PROTOCOLS[p]);
  return { port_count: portsInput(b.port_count), poe: pick(b.poe, POE), speed: pick(b.speed, SPEEDS), floor: clean(b.floor, 40),
    uplink1: clean(b.uplink1, 100), uplink2: clean(b.uplink2, 100), protocols: protocols.join(',') || null, state: STATES[b.state] ? b.state : 'en_uso', mgmt_user: clean(b.mgmt_user, 80) };
}
// Guarda el equipo (los mismos datos que en Equipos) y su ficha tecnica.
// Marca y modelo salen del catalogo (model_id); sede y area, del catalogo general.
async function saveInfra(id, body, user) {
  if (!INFRA_KINDS.includes(String(body.kind))) throw new Error('Elija si es un switch o un punto de acceso.');
  const spec = specInput(body);
  let cur = null;
  if (id) {
    [[cur]] = await pool.query(`SELECT d.kind, d.mac_wifi, d.sede, d.area, d.brand_model, sp.model_id, sp.brand, sp.model FROM network_devices d
      LEFT JOIN network_device_specs sp ON sp.device_id = d.id WHERE d.id = ?`, [Number(id)]);
    if (!cur || !INFRA_KINDS.includes(cur.kind)) throw new Error('El equipo ya no existe.');
  }
  const modelId = Number(body.model_id) || 0;
  let brandModel = null;
  if (modelId) {
    const [[m]] = await pool.query('SELECT m.id, m.name, m.active, b.name AS brand_name, b.active AS brand_active FROM network_models m JOIN network_brands b ON b.id = m.brand_id WHERE m.id = ?', [modelId]);
    if (!m || ((!m.active || !m.brand_active) && !(cur && cur.model_id === m.id))) throw new Error('Elija un modelo del catálogo.');
    Object.assign(spec, { model_id: m.id, brand: m.brand_name, model: m.name });
    brandModel = `${m.brand_name} ${m.name}`;
  } else {
    // Sin modelo del catalogo: si el equipo vino de otra parte (Omada, Equipos), conserva su texto.
    Object.assign(spec, { model_id: null, brand: null, model: null });
    brandModel = cur && !cur.model_id ? cur.brand_model : null;
  }
  const password = String(body.mgmt_password || '');
  if (password.length > 200) throw new Error('La contraseña de acceso es demasiado larga (máximo 200).');
  if (password) spec.mgmt_password = cryptoService.encrypt(password);
  else if (body.mgmt_password_clear === '1' || !spec.mgmt_user) spec.mgmt_password = null; // sin usuario no se guarda una clave suelta
  const data = deviceInput({ ...body, mac_wifi: '', brand_model: brandModel || '',
    sede: await fromCatalog('sede', body.sede, cur && cur.sede, 'La sede'), area: await fromCatalog('area', body.area, cur && cur.area, 'El área') });
  const rowId = await saveRow(id, id ? { ...data, mac_wifi: cur.mac_wifi } : { ...data, source: 'manual' }, body.vlan_ids, user);
  await pool.query('INSERT INTO network_device_specs SET ? ON DUPLICATE KEY UPDATE ?', [{ device_id: rowId, ...spec }, spec]);
  return rowId;
}
// La credencial de acceso de un equipo, descifrada. Quien la pide y cuando lo registra la ruta.
async function credential(id) {
  const [[row]] = await pool.query(`SELECT d.name, d.ip, sp.mgmt_user, sp.mgmt_password FROM network_devices d JOIN network_device_specs sp ON sp.device_id = d.id
    WHERE d.id = ? AND d.kind IN (?)`, [Number(id) || 0, INFRA_KINDS]);
  if (!row) return null;
  const password = row.mgmt_password ? cryptoService.decrypt(row.mgmt_password) : '';
  return { name: row.name, ip: row.ip, user: row.mgmt_user || '', password: cryptoService.isEncrypted(password) ? null : password };
}

// Trae las PC que la aplicacion ya conoce. GLPI aporta MAC, IP, serie, modelo
// y ubicacion; el directorio activo, nombre e IP. Solo llena lo que esta vacio:
// lo escrito a mano no se pisa. Devuelve { created, updated, withMac }.
async function importPcs(user) {
  const [glpi] = await pool.query("SELECT name, mac, ip, serial, manufacturer, model, location FROM glpi_assets WHERE asset_type = 'computadoras' AND name IS NOT NULL");
  let ad = [];
  try { [ad] = await pool.query('SELECT name, ips FROM ad_computers WHERE removed_at IS NULL AND is_dc = 0'); } catch (_) { ad = []; }
  const found = new Map(); // nombre en minusculas -> datos
  const firstIp = (v) => String(v || '').split(',').map((x) => x.trim()).find((x) => IPV4.test(x)) || null;
  for (const c of ad) found.set(String(c.name).toLowerCase(), { name: String(c.name).toUpperCase(), ip: firstIp(c.ips), source: 'ad' });
  for (const g of glpi) {
    const k = String(g.name).toLowerCase();
    const macs = [...new Set(String(g.mac || '').split(',').map((x) => macOrNull(x)).filter(Boolean))];
    const prev = found.get(k) || {};
    found.set(k, { name: prev.name || String(g.name).toUpperCase(), ip: firstIp(g.ip) || prev.ip || null, mac: macs[0] || null, mac_wifi: macs[1] || null,
      serial: clean(g.serial, 100), brand_model: clean([g.manufacturer, g.model].filter(Boolean).join(' '), 150), location: clean(g.location, 150), source: 'glpi' });
  }
  const [existing] = await pool.query("SELECT * FROM network_devices WHERE kind = 'pc'");
  const byName = new Map(existing.map((d) => [String(d.name).toLowerCase(), d]));
  const [used] = await pool.query('SELECT mac, mac_wifi FROM network_devices');
  const taken = new Set(used.flatMap((u) => [u.mac, u.mac_wifi]).filter(Boolean));
  const out = { created: 0, updated: 0, withMac: 0 };
  for (const [k, f] of found) {
    // Una MAC que ya tiene otro equipo no se repite (docking o adaptador compartido).
    const free = (m) => (m && !taken.has(m) ? m : null);
    const cur = byName.get(k);
    if (!cur) {
      const mac = free(f.mac);
      const wifi = free(f.mac_wifi);
      await pool.query('INSERT INTO network_devices SET ?', [{ kind: 'pc', name: f.name, mac, mac_wifi: wifi, ip: f.ip || null, location: f.location || null,
        brand_model: f.brand_model || null, serial: f.serial || null, source: f.source, created_by: user ? user.id : null }]);
      [mac, wifi].filter(Boolean).forEach((m) => taken.add(m));
      out.created += 1;
      if (mac) out.withMac += 1;
      continue;
    }
    const set = {};
    ['mac', 'mac_wifi'].forEach((c) => { if (!cur[c] && free(f[c]) && f[c] !== cur.mac && f[c] !== cur.mac_wifi) { set[c] = f[c]; taken.add(f[c]); } });
    ['ip', 'location', 'brand_model', 'serial'].forEach((c) => { if (!cur[c] && f[c]) set[c] = f[c]; });
    if (Object.keys(set).length) {
      await pool.query('UPDATE network_devices SET ? WHERE id = ?', [set, cur.id]);
      out.updated += 1;
    }
    if (cur.mac || set.mac) out.withMac += 1;
  }
  return out;
}

async function overview() {
  const [byKind] = await pool.query("SELECT kind, COUNT(*) AS n, SUM(mac IS NOT NULL) AS with_mac FROM network_devices WHERE kind <> 'celular' GROUP BY kind");
  const [[ph]] = await pool.query(
    `SELECT COUNT(*) AS n, SUM(d.mac IS NOT NULL) AS with_mac FROM mobile_devices m LEFT JOIN network_devices d ON d.mobile_device_id = m.id`
  );
  const [[vl]] = await pool.query('SELECT COUNT(*) AS n FROM network_vlans');
  return { byKind, phones: { n: Number(ph.n || 0), withMac: Number(ph.with_mac || 0) }, vlans: Number(vl.n || 0) };
}

module.exports = {
  KINDS, SOURCES, INFRA_KINDS, POE, SPEEDS, PROTOCOLS, STATES, infra, infraDevice, saveInfra, credential, brands, models, saveBrand, saveModel, setCatalogActive, deleteCatalog,
  normalizeMac, normalizeIp, vlans, vlan, saveVlan, deleteVlan, devices, device, phones, phone, saveDevice, savePhone, deleteDevice, importPcs, overview,
};
