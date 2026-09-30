// Cliente de la API v2 de GLPI 11 ("High-Level REST API", .../api.php).
//
// Verificado contra el doc.json que publica GLPI 11 (OpenAPI 3, v2.3) y su
// codigo fuente (rama 11.0/bugfixes):
// - Autenticacion OAuth 2: POST /api.php/token con grant_type=password,
//   client_id/client_secret de un cliente OAuth de GLPI (Configuracion ->
//   Clientes OAuth) y usuario/contrasena de un usuario de servicio, scope
//   "api". El token dura 1 hora. Client Credentials NO sirve para leer
//   inventario: el enrutador de la API inicia la sesion con el user_id del
//   token y ese grant no tiene usuario.
// - Listados: /Assets/Computer|Monitor|Printer con start/limit, filtro RSQL
//   (filter=name=ilike=*texto*, "," = OR) y sort=name:asc. Responden un
//   arreglo, 200 o 206, y Content-Range "inicio-fin/total".
// - Por defecto solo se ve la entidad por defecto del usuario: se envia
//   GLPI-Entity-Recursive: true para incluir las entidades hijas.
const axios = require('axios');

const TYPES = { computadoras: 'Computer', monitores: 'Monitor', impresoras: 'Printer' };
const KEY_OF = { Computer: 'computadoras', Monitor: 'monitores', Printer: 'impresoras' };
const SINGULAR = { Computer: 'Computadora', Monitor: 'Monitor', Printer: 'Impresora' };

// La URL que muestra GLPI (.../api.php/v2.3), la de la Legacy API
// (.../api.php/v1) o la de GLPI a secas: todo lleva a la raiz .../api.php.
function apiRoot(url) {
  let clean = (url || '').trim().replace(/\/+$/, '');
  if (!clean) return '';
  clean = clean.replace(/\/v\d+(\.\d+)*$/i, '').replace(/\/apirest\.php$/i, '');
  return /\/api\.php$/i.test(clean) ? clean : `${clean}/api.php`;
}

const OAUTH_ERRORS = {
  invalid_client: 'GLPI rechazó el cliente OAuth: revise el ID y el secreto del cliente (Configuración → Clientes OAuth), que esté activo y que tenga habilitado el tipo de acceso "Password".',
  invalid_grant: 'GLPI rechazó el usuario o la contraseña del usuario de servicio (o el usuario está inactivo).',
  unsupported_grant_type: 'El cliente OAuth no tiene habilitado el tipo de acceso "Password" (Configuración → Clientes OAuth → tipos de acceso).',
  invalid_scope: 'El cliente OAuth no tiene el alcance "api" habilitado.',
  invalid_request: 'Faltan datos para pedir el token (ID de cliente, secreto, usuario o contraseña).',
};

function explain(status, data) {
  const code = data && (data.error || data.status);
  if (code && OAUTH_ERRORS[code]) return `${OAUTH_ERRORS[code]} (${code})`;
  if (status === 401) return 'GLPI no aceptó el token de acceso (ERROR_UNAUTHENTICATED).';
  if (status === 403) return 'El usuario de servicio no tiene permiso para ver esto: revise su perfil y entidades en GLPI.';
  if (status === 404) return 'GLPI no encontró ese recurso (revise la URL de la API: debe terminar en /api.php o /api.php/v2.x).';
  if (typeof data === 'string' && /<html/i.test(data)) return `La URL no responde como la API de GLPI (HTTP ${status}).`;
  const detail = data && (data.detail || data.title || data.message || data.error_description);
  return `GLPI respondió HTTP ${status}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`;
}

// Token en memoria por configuracion, hasta 1 minuto antes de vencer.
const tokenCache = new Map();

async function getToken(cfg) {
  const missing = [['cliente OAuth', cfg.clientId], ['secreto del cliente', cfg.clientSecret], ['usuario', cfg.username], ['contraseña', cfg.password]]
    .filter(([, v]) => !v).map(([k]) => k);
  if (!cfg.root || missing.length) {
    throw new Error(`GLPI (API v2) no está configurado por completo: falta ${cfg.root ? missing.join(', ') : 'la URL de la API'}. Complételo en Configuración.`);
  }
  const key = [cfg.root, cfg.clientId, cfg.username, cfg.clientSecret, cfg.password].join('\u0000');
  const cached = tokenCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.token;
  let res;
  try {
    res = await axios.post(`${cfg.root}/token`, new URLSearchParams({
      grant_type: 'password', client_id: cfg.clientId, client_secret: cfg.clientSecret,
      username: cfg.username, password: cfg.password, scope: 'api',
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, timeout: 15000, validateStatus: () => true });
  } catch (err) {
    const hint = /certificate|self.signed|CERT_/i.test(err.message)
      ? ' El certificado HTTPS de GLPI no es de confianza para este servidor (autofirmado o de una CA interna).'
      : ' Revise que la URL y el puerto sean alcanzables desde el servidor de la app.';
    throw new Error(`No se pudo conectar con ${cfg.root}: ${err.message}.${hint}`);
  }
  if (res.status !== 200 || !res.data || !res.data.access_token) {
    throw new Error(`No se pudo obtener el token de GLPI: ${explain(res.status, res.data)}`);
  }
  const ttl = Math.max(Number(res.data.expires_in) || 3600, 120);
  tokenCache.set(key, { token: res.data.access_token, expires: Date.now() + (ttl - 60) * 1000 });
  return res.data.access_token;
}

async function request(cfg, method, path, { params, data } = {}) {
  const token = await getToken(cfg);
  const res = await axios.request({
    method, url: `${cfg.root}${path}`, params, data, timeout: 20000, validateStatus: () => true,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'GLPI-Entity-Recursive': 'true' },
  });
  if (res.status === 401) tokenCache.clear(); // token revocado o vencido antes de tiempo
  return res;
}

function totalFrom(res, fallback) {
  const t = parseInt(String(res.headers['content-range'] || '').split('/')[1], 10);
  return Number.isNaN(t) ? fallback : t;
}

const nameOf = (v) => (v && typeof v === 'object' ? (v.completename || v.name || '') : (v || ''));

// RSQL: se quitan los caracteres que tienen significado en el filtro.
function filterFor(query) {
  const q = String(query || '').replace(/[;,()"'=!<>*\\]/g, ' ').trim();
  if (!q) return undefined;
  return ['name', 'serial', 'otherserial'].map((f) => `${f}=ilike=*${q}*`).join(',');
}

function mapRow(it) {
  return {
    id: it.id, name: it.name || '', state: nameOf(it.status), type: nameOf(it.type), manufacturer: nameOf(it.manufacturer),
    model: nameOf(it.model), os: '', serial: it.serial || '', otherserial: it.otherserial || '', location: nameOf(it.location),
    user: nameOf(it.user), entity: nameOf(it.entity), date_mod: it.date_mod || '',
  };
}

async function listItems(cfg, typeKey, { query, start = 0, limit = 20 } = {}) {
  const itemtype = TYPES[typeKey];
  const res = await request(cfg, 'get', `/Assets/${itemtype}`, { params: { start, limit, sort: 'name:asc', filter: filterFor(query) } });
  if (res.status !== 200 && res.status !== 206) throw new Error(explain(res.status, res.data));
  const rows = Array.isArray(res.data) ? res.data : [];
  return { items: rows.map(mapRow), total: totalFrom(res, rows.length) };
}

async function listAllItems(cfg, typeKey, { query, max = 20000 } = {}) {
  const all = [];
  for (let start = 0; start < max; start += 200) {
    const { items, total } = await listItems(cfg, typeKey, { query, start, limit: 200 });
    all.push(...items);
    if (items.length < 200 || all.length >= total) break;
  }
  return all;
}

async function getItemDetail(cfg, typeKey, id) {
  const itemtype = TYPES[typeKey];
  const res = await request(cfg, 'get', `/Assets/${itemtype}/${encodeURIComponent(id)}`);
  if (res.status !== 200) throw new Error(explain(res.status, res.data));
  const it = res.data || {};
  const groups = (list) => (Array.isArray(list) ? list.map(nameOf).filter(Boolean).join(', ') : nameOf(list));
  const fields = [
    ['Nombre', it.name], ['Estado', nameOf(it.status)], ['Tipo', nameOf(it.type)], ['Fabricante', nameOf(it.manufacturer)],
    ['Modelo', nameOf(it.model)], ['Tamaño (pulgadas)', it.size], ['N.º de serie', it.serial], ['N.º de inventario', it.otherserial],
    ['Ubicación', nameOf(it.location)], ['Usuario', nameOf(it.user)], ['Grupo', groups(it.group)],
    ['Responsable técnico', nameOf(it.user_tech)], ['Entidad', nameOf(it.entity)], ['UUID', it.uuid],
    ['Último inventario', it.last_inventory_update], ['Comentarios', it.comment], ['Última modificación', it.date_mod],
  ].filter(([label, v]) => v !== undefined && v !== null && !(label === 'Tamaño (pulgadas)' && typeKey !== 'monitores'))
    .map(([label, v]) => ({ label, value: String(v) || '—' }));
  return { name: it.name || `${SINGULAR[itemtype]} #${id}`, fields, raw: it };
}

// PeripheralConnection: una computadora -> sus perifericos; un monitor o
// impresora -> la computadora a la que esta conectado.
async function getConnections(cfg, typeKey, id) {
  const itemtype = TYPES[typeKey];
  const res = await request(cfg, 'get', `/Assets/${itemtype}/${encodeURIComponent(id)}/PeripheralConnection`);
  if (res.status !== 200 && res.status !== 206) return [];
  const out = [];
  for (const row of (Array.isArray(res.data) ? res.data : []).slice(0, 50)) {
    if (row.is_deleted) continue;
    const isAsset = itemtype === 'Computer';
    const otherType = isAsset ? row.itemtype_peripheral : row.itemtype_asset;
    const otherId = isAsset ? row.items_id_peripheral : row.items_id_asset;
    let name = `#${otherId}`;
    try {
      const r = await request(cfg, 'get', `/Assets/${otherType}/${otherId}`);
      if (r.status === 200 && r.data && r.data.name) name = r.data.name;
    } catch (_) { /* se muestra el id */ }
    out.push({ itemtype: otherType, typeKey: KEY_OF[otherType] || null, id: otherId, name });
  }
  return out;
}

// Software instalado. La API v2 solo entrega la version instalada
// (softwareversion {id, name}): el nombre del programa no viene en esta
// consulta, asi que se informa como limitacion en la pantalla.
async function getComputerSoftware(cfg, id, { max = 100 } = {}) {
  const res = await request(cfg, 'get', `/Assets/Computer/${encodeURIComponent(id)}/SoftwareInstallation`, { params: { limit: max } });
  if (res.status !== 200 && res.status !== 206) throw new Error(explain(res.status, res.data));
  const rows = Array.isArray(res.data) ? res.data : [];
  const total = totalFrom(res, rows.length);
  return {
    items: rows.map((r) => ({ name: nameOf(r.softwareversion) || '—', version: r.date_install ? `instalado ${r.date_install}` : '' })),
    total, truncated: total > rows.length,
    note: 'Con la API v2 de GLPI se listan las versiones instaladas; el nombre de cada programa no viene en esta consulta.',
  };
}

async function testConnection(cfg) {
  const me = await request(cfg, 'get', '/Administration/User/Me');
  if (me.status !== 200) throw new Error(explain(me.status, me.data));
  const counts = {};
  for (const key of Object.keys(TYPES)) {
    try {
      const r = await request(cfg, 'get', `/Assets/${TYPES[key]}`, { params: { start: 0, limit: 1 } });
      counts[key] = r.status === 200 || r.status === 206 ? totalFrom(r, (r.data || []).length) : null;
    } catch (_) {
      counts[key] = null;
    }
  }
  return { ok: true, user: me.data && (me.data.username || me.data.name), counts };
}

// Misma forma que la API clasica ({ '2': id, '1': nombre, '80': entidad }).
async function searchComputers(cfg, query, limit = 20) {
  const { items } = await listItems(cfg, 'computadoras', { query, start: 0, limit });
  return items.map((i) => ({ 2: i.id, 1: i.name, 80: i.entity }));
}

async function listEntities(cfg, limit = 100) {
  const res = await request(cfg, 'get', '/Administration/Entity', { params: { start: 0, limit } });
  if (res.status !== 200 && res.status !== 206) throw new Error(explain(res.status, res.data));
  return (Array.isArray(res.data) ? res.data : []).map((e) => ({ id: e.id, name: e.name, completename: e.completename }));
}

async function createContract(cfg, { name, notes, begin_date, duree }) {
  const res = await request(cfg, 'post', '/Management/Contract', {
    data: { name, comment: notes || '', date_begin: begin_date || null, duration: duree || 0 },
  });
  if (res.status !== 200 && res.status !== 201) throw new Error(`Error creando el contrato en GLPI: ${explain(res.status, res.data)}`);
  return { id: res.data && res.data.id };
}

module.exports = {
  apiRoot, explain, getToken, listItems, listAllItems, getItemDetail, getConnections, getComputerSoftware,
  testConnection, searchComputers, listEntities, createContract, _tokenCache: tokenCache,
};
