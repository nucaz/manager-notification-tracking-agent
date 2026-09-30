// Cliente ligero para la API REST de GLPI.
// Documentacion oficial: https://github.com/glpi-project/glpi/blob/main/apirest.md
//
// Flujo de autenticacion GLPI:
//   1. initSession con App-Token + (User-Token o usuario/clave) -> Session-Token
//   2. Cada peticion posterior envia App-Token + Session-Token
//   3. killSession al terminar (opcional, GLPI expira la sesion por inactividad)
const axios = require('axios');
const settingsService = require('./settingsService');

// Esta app usa la API REST "clasica" de GLPI (App-Token + User-Token):
// - GLPI 9/10: .../apirest.php
// - GLPI 11: la misma API se llama "Legacy API", en .../api.php/v1 (sigue
//   respondiendo tambien en .../apirest.php).
// GLPI 11 muestra primero la URL de su API nueva (.../api.php/v2.x), que usa
// OAuth y no sirve con estos tokens: si se pega esa, se pasa a la clasica.
// Si se pega solo la direccion de GLPI, se completa con /apirest.php.
function normalizeBaseUrl(url) {
  const clean = (url || '').trim().replace(/\/+$/, '');
  if (!clean) return '';
  if (/\/apirest\.php$/i.test(clean) || /\/api\.php\/v1$/i.test(clean)) return clean;
  const v2 = clean.match(/^(.*\/api\.php)\/v2(\.\d+)*$/i);
  if (v2) return `${v2[1]}/v1`;
  if (/\/api\.php$/i.test(clean)) return `${clean}/v1`;
  return `${clean}/apirest.php`;
}

// GLPI responde los errores como ["CODIGO", "mensaje"]. Se traducen los
// que aparecen al configurar la conexion por primera vez.
const GLPI_ERRORS = {
  ERROR_WRONG_APP_TOKEN_PARAMETER: 'El App-Token no es válido. En GLPI: Configuración → General → API → cliente de API: copie el "Token de aplicación (app_token)".',
  ERROR_APP_TOKEN_PARAMETERS_MISSING: 'Falta el App-Token.',
  ERROR_GLPI_LOGIN_USER_TOKEN: 'El User-Token no es válido. En GLPI, con el usuario de servicio: Mis preferencias → Claves de acceso remoto → Token de API.',
  ERROR_LOGIN_PARAMETERS_MISSING: 'Falta el User-Token.',
  ERROR_GLPI_LOGIN: 'GLPI rechazó el inicio de sesión (usuario inactivo, sin perfil o token revocado).',
  ERROR_NOT_ALLOWED_IP: 'GLPI no acepta conexiones desde la IP de este servidor: en Configuración → General → API → cliente de API de la app, ponga en "Rango de direcciones IPv4" la IP del servidor de la app (inicio y fin iguales) o déjelo vacío, y Activo = Sí.',
  ERROR_UNAUTHENTICATED: 'Esa URL es la API nueva de GLPI 11 (v2), que no usa App-Token/User-Token. Use la URL de la "Legacy API" (termina en /api.php/v1).',
  ERROR_API_DISABLED: 'La API REST está desactivada en GLPI: Configuración → General → API → "Habilitar API Rest" = Sí.',
  ERROR_LOGIN_WITH_TOKEN_DISABLED: 'GLPI no permite iniciar sesión con token: Configuración → General → API → "Habilitar inicio de sesión con token externo" = Sí.',
  ERROR_RIGHT_MISSING: 'El usuario de servicio no tiene permiso para ver ese inventario (revise su perfil y entidades en GLPI).',
  ERROR_SESSION_TOKEN_INVALID: 'La sesión con GLPI expiró; vuelva a intentarlo.',
};

function explainGlpiError(status, data) {
  const code = Array.isArray(data) ? data[0] : data && (data.error || data.status);
  if (code && GLPI_ERRORS[code]) {
    // GLPI incluye la IP que ve en el mensaje: sirve para saber cual autorizar.
    const ip = code === 'ERROR_NOT_ALLOWED_IP' && Array.isArray(data) && /\((\d+\.\d+\.\d+\.\d+)\)/.exec(String(data[1] || ''));
    return `${GLPI_ERRORS[code]}${ip ? ` GLPI ve la conexión llegando desde ${ip[1]}.` : ''} (${code})`;
  }
  if (status === 404) return 'No se encontró la API en esa URL: debe terminar en /apirest.php (ej. https://glpi.empresa.com/apirest.php).';
  if (typeof data === 'string' && /<html/i.test(data)) return `La URL no responde como la API de GLPI (HTTP ${status}): revise la URL base.`;
  return `GLPI respondió HTTP ${status}: ${JSON.stringify(data).slice(0, 300)}`;
}

async function getConfig() {
  const settings = await settingsService.getAll();
  return {
    baseUrl: normalizeBaseUrl(settings.glpi_base_url),
    appToken: settings.glpi_app_token || '',
    userToken: settings.glpi_user_token || '',
  };
}

function client(baseUrl) {
  return axios.create({
    baseURL: baseUrl,
    timeout: 15000,
    validateStatus: () => true, // manejamos el status manualmente para dar mensajes claros
  });
}

async function initSession() {
  const cfg = await getConfig();
  if (!cfg.baseUrl || !cfg.appToken || !cfg.userToken) {
    throw new Error(
      'GLPI no esta configurado por completo. Ve a Configuracion y completa URL base, App-Token y User-Token.'
    );
  }
  const http = client(cfg.baseUrl);
  let res;
  try {
    res = await http.get('/initSession', {
      headers: {
        'App-Token': cfg.appToken,
        Authorization: `user_token ${cfg.userToken}`,
      },
    });
  } catch (err) {
    const hint = /certificate|self.signed|CERT_/i.test(err.message)
      ? ' El certificado HTTPS de GLPI no es de confianza para este servidor (autofirmado o de una CA interna).'
      : /EAI_AGAIN|ENOTFOUND/.test(err.message)
        ? ' El servidor de la app no puede resolver ese nombre: use el nombre completo con el dominio (ej. glpi.empresa.local) o la IP de GLPI. Un nombre corto funciona en PCs del dominio, pero no dentro del contenedor.'
        : ' Revise que la URL y el puerto sean alcanzables desde el servidor de la app.';
    throw new Error(`No se pudo conectar con ${cfg.baseUrl}: ${err.message}.${hint}`);
  }
  if (res.status !== 200 || !res.data || !res.data.session_token) {
    throw new Error(`No se pudo iniciar sesión en GLPI: ${explainGlpiError(res.status, res.data)}`);
  }
  return { http, cfg, sessionToken: res.data.session_token };
}

async function killSession(http, cfg, sessionToken) {
  try {
    await http.get('/killSession', {
      headers: {
        'App-Token': cfg.appToken,
        'Session-Token': sessionToken,
      },
    });
  } catch (_) {
    // no critico si falla el cierre de sesion
  }
}

async function withSession(fn) {
  const { http, cfg, sessionToken } = await initSession();
  try {
    return await fn(http, cfg, sessionToken);
  } finally {
    await killSession(http, cfg, sessionToken);
  }
}

async function testConnection() {
  return withSession(async (http, cfg, sessionToken) => {
    const headers = { 'App-Token': cfg.appToken, 'Session-Token': sessionToken };
    const res = await http.get('/getMyProfiles', { headers });
    if (res.status !== 200) {
      throw new Error(explainGlpiError(res.status, res.data));
    }
    // Cuantos activos de cada tipo ve este usuario (confirma los permisos).
    const counts = {};
    for (const [key, t] of Object.entries(ASSET_TYPES)) {
      try {
        const r = await http.get(`/search/${t.itemtype}?${searchQuery({ start: 0, limit: 1, display: [2] })}`, { headers });
        const total = parseInt(String(r.headers['content-range'] || '').split('/')[1], 10);
        counts[key] = r.status === 200 || r.status === 206 ? (Number.isNaN(total) ? (r.data.totalcount || 0) : total) : null;
      } catch (_) {
        counts[key] = null;
      }
    }
    return { ok: true, profiles: res.data.myprofiles || res.data, counts };
  });
}

// Busca equipos (Computer) en GLPI por nombre, para vincular con licencias/contratos
async function searchComputers(query, limit = 20) {
  return withSession(async (http, cfg, sessionToken) => {
    const res = await http.get('/search/Computer', {
      headers: { 'App-Token': cfg.appToken, 'Session-Token': sessionToken },
      params: {
        criteria: query
          ? [{ field: 1, searchtype: 'contains', value: query }] // field 1 = name
          : undefined,
        range: `0-${limit - 1}`,
        forcedisplay: [2, 1, 80], // id, name, entity
      },
    });
    if (res.status !== 200 && res.status !== 206) {
      throw new Error(`Error buscando equipos en GLPI (HTTP ${res.status})`);
    }
    return res.data.data || [];
  });
}

// Busca/lista equipos (Computer) en GLPI con paginacion real, usando el
// header Content-Range ("inicio-fin/total") para saber el total sin traer
// todo. Usado por /glpi/inventario.
async function listComputers({ query, start = 0, limit = 20 } = {}) {
  return withSession(async (http, cfg, sessionToken) => {
    const res = await http.get('/search/Computer', {
      headers: { 'App-Token': cfg.appToken, 'Session-Token': sessionToken },
      params: {
        criteria: query
          ? [{ field: 1, searchtype: 'contains', value: query }]
          : undefined,
        range: `${start}-${start + limit - 1}`,
        forcedisplay: [2, 1, 80], // id, name, entity
      },
    });
    if (res.status !== 200 && res.status !== 206) {
      throw new Error(`Error listando equipos en GLPI (HTTP ${res.status})`);
    }
    const contentRange = res.headers['content-range'] || '';
    const total = parseInt(contentRange.split('/')[1], 10);
    return {
      items: res.data.data || [],
      total: Number.isNaN(total) ? (res.data.data || []).length : total,
    };
  });
}

// Datos generales de un equipo (nombre, entidad, SO, serie, etc.), con
// expand_dropdowns para que los campos tipo dropdown vengan como texto
// legible en vez de un id crudo.
async function getComputerDetail(id) {
  return withSession(async (http, cfg, sessionToken) => {
    const res = await http.get(`/Computer/${id}`, {
      headers: { 'App-Token': cfg.appToken, 'Session-Token': sessionToken },
      params: { expand_dropdowns: true },
    });
    if (res.status !== 200) {
      throw new Error(`Error obteniendo el equipo en GLPI (HTTP ${res.status})`);
    }
    return res.data;
  });
}

// Software instalado en un equipo. GLPI modela esto como
// Software -> SoftwareVersion -> Item_SoftwareVersion (la relacion con el
// equipo). El conteo es el largo de esa lista; el nombre de cada software
// se resuelve por separado (SoftwareVersion.name es solo la version, el
// nombre del producto vive en softwares_id, que expand_dropdowns convierte
// a texto). Si una fila puntual no se puede resolver, se omite en vez de
// romper el listado completo.
async function getComputerSoftware(id, { max = 100 } = {}) {
  return withSession(async (http, cfg, sessionToken) => {
    const headers = { 'App-Token': cfg.appToken, 'Session-Token': sessionToken };
    const res = await http.get(`/Computer/${id}/Item_SoftwareVersion`, { headers });
    if (res.status !== 200 && res.status !== 206) {
      throw new Error(`Error obteniendo el software instalado (HTTP ${res.status})`);
    }
    const rows = Array.isArray(res.data) ? res.data : [];
    const total = rows.length;
    const truncated = total > max;
    const toResolve = rows.slice(0, max);

    const resolved = await Promise.all(
      toResolve.map(async (row) => {
        const versionId = row.softwareversions_id;
        if (!versionId) return null;
        try {
          const versionRes = await http.get(`/SoftwareVersion/${versionId}`, {
            headers,
            params: { expand_dropdowns: true },
          });
          if (versionRes.status !== 200) return null;
          return {
            name: versionRes.data.softwares_id || versionRes.data.name || 'Software desconocido',
            version: versionRes.data.name || '',
          };
        } catch (_) {
          return null;
        }
      })
    );

    return { items: resolved.filter(Boolean), total, truncated };
  });
}

// Lista entidades GLPI (para asociar licencias/dominios a una entidad/sucursal)
async function listEntities(limit = 100) {
  return withSession(async (http, cfg, sessionToken) => {
    const res = await http.get('/Entity', {
      headers: { 'App-Token': cfg.appToken, 'Session-Token': sessionToken },
      params: { range: `0-${limit - 1}` },
    });
    if (res.status !== 200 && res.status !== 206) {
      throw new Error(`Error listando entidades en GLPI (HTTP ${res.status})`);
    }
    return res.data || [];
  });
}

// Crea un objeto "Contract" en GLPI a partir de un registro local
// (licencia, dominio o contrato ISP), para mantener trazabilidad tambien en GLPI.
async function createContract({ name, notes, begin_date, duree, alert }) {
  return withSession(async (http, cfg, sessionToken) => {
    const res = await http.post(
      '/Contract',
      {
        input: {
          name,
          comment: notes || '',
          begin_date: begin_date || null,
          duration: duree || 0,
          alert: alert || 0,
        },
      },
      { headers: { 'App-Token': cfg.appToken, 'Session-Token': sessionToken } }
    );
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`Error creando contrato en GLPI (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
    }
    return res.data;
  });
}

// Crea un objeto "Software License" (SoftwareLicense) en GLPI
async function createSoftwareLicense({ name, number, expire, comment }) {
  return withSession(async (http, cfg, sessionToken) => {
    const res = await http.post(
      '/SoftwareLicense',
      {
        input: {
          name,
          number: number || 1,
          expire: expire || null,
          comment: comment || '',
        },
      },
      { headers: { 'App-Token': cfg.appToken, 'Session-Token': sessionToken } }
    );
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(
        `Error creando licencia en GLPI (HTTP ${res.status}): ${JSON.stringify(res.data)}`
      );
    }
    return res.data;
  });
}

// ---------------------------------------------------------------------
// Inventario: computadoras, monitores e impresoras
// ---------------------------------------------------------------------
// Opciones de busqueda de GLPI (mismos numeros en los tres tipos de activo):
// 1 nombre, 2 id, 3 ubicacion, 4 tipo, 5 serie, 6 n. de inventario,
// 23 fabricante, 31 estado, 40 modelo, 70 usuario, 80 entidad, 19 ult. modificacion.
const COMMON_COLUMNS = [
  { id: 1, key: 'name', label: 'Nombre' },
  { id: 31, key: 'state', label: 'Estado' },
  { id: 4, key: 'type', label: 'Tipo' },
  { id: 23, key: 'manufacturer', label: 'Fabricante' },
  { id: 40, key: 'model', label: 'Modelo' },
  { id: 5, key: 'serial', label: 'N.º de serie' },
  { id: 6, key: 'otherserial', label: 'N.º de inventario' },
  { id: 3, key: 'location', label: 'Ubicación' },
  { id: 70, key: 'user', label: 'Usuario' },
  { id: 80, key: 'entity', label: 'Entidad' },
  { id: 19, key: 'date_mod', label: 'Última modificación' },
];

const ASSET_TYPES = {
  computadoras: {
    itemtype: 'Computer', label: 'Computadoras', singular: 'Computadora', icon: 'bi-pc-display',
    columns: [...COMMON_COLUMNS.slice(0, 5), { id: 45, key: 'os', label: 'Sistema operativo' }, ...COMMON_COLUMNS.slice(5)],
    detail: [['name', 'Nombre'], ['states_id', 'Estado'], ['computertypes_id', 'Tipo'], ['manufacturers_id', 'Fabricante'],
      ['computermodels_id', 'Modelo'], ['serial', 'N.º de serie'], ['otherserial', 'N.º de inventario'],
      ['locations_id', 'Ubicación'], ['users_id', 'Usuario'], ['groups_id', 'Grupo'], ['entities_id', 'Entidad'],
      ['uuid', 'UUID'], ['comment', 'Comentarios'], ['date_mod', 'Última modificación']],
  },
  monitores: {
    itemtype: 'Monitor', label: 'Monitores', singular: 'Monitor', icon: 'bi-display',
    columns: COMMON_COLUMNS,
    detail: [['name', 'Nombre'], ['states_id', 'Estado'], ['monitortypes_id', 'Tipo'], ['manufacturers_id', 'Fabricante'],
      ['monitormodels_id', 'Modelo'], ['size', 'Tamaño (pulgadas)'], ['serial', 'N.º de serie'], ['otherserial', 'N.º de inventario'],
      ['locations_id', 'Ubicación'], ['users_id', 'Usuario'], ['groups_id', 'Grupo'], ['entities_id', 'Entidad'],
      ['comment', 'Comentarios'], ['date_mod', 'Última modificación']],
  },
  impresoras: {
    itemtype: 'Printer', label: 'Impresoras', singular: 'Impresora', icon: 'bi-printer',
    columns: COMMON_COLUMNS,
    detail: [['name', 'Nombre'], ['states_id', 'Estado'], ['printertypes_id', 'Tipo'], ['manufacturers_id', 'Fabricante'],
      ['printermodels_id', 'Modelo'], ['serial', 'N.º de serie'], ['otherserial', 'N.º de inventario'],
      ['locations_id', 'Ubicación'], ['users_id', 'Usuario'], ['groups_id', 'Grupo'], ['entities_id', 'Entidad'],
      ['memory_size', 'Memoria'], ['init_pages_counter', 'Contador inicial de páginas'], ['last_pages_counter', 'Último contador de páginas'],
      ['comment', 'Comentarios'], ['date_mod', 'Última modificación']],
  },
};
const ITEMTYPE_TO_KEY = Object.fromEntries(Object.entries(ASSET_TYPES).map(([k, t]) => [t.itemtype, k]));

// GLPI entrega los textos de la busqueda con entidades HTML (ej. "Raiz &#62;
// Sede"): se decodifican aqui para que la vista no las muestre escapadas.
function decodeHtml(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(decodeHtml).filter(Boolean).join(', ');
  return String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&')
    .trim();
}

// Query string explicito (criteria[0][field]=1...), sin depender de como un
// cliente HTTP serializa arreglos de objetos.
function searchQuery({ query, start, limit, display }) {
  const p = new URLSearchParams();
  if (query) {
    p.append('criteria[0][field]', '1');
    p.append('criteria[0][searchtype]', 'contains');
    p.append('criteria[0][value]', query);
    // Tambien por serie y numero de inventario.
    for (const [i, field] of [[1, 5], [2, 6]]) {
      p.append(`criteria[${i}][link]`, 'OR');
      p.append(`criteria[${i}][field]`, String(field));
      p.append(`criteria[${i}][searchtype]`, 'contains');
      p.append(`criteria[${i}][value]`, query);
    }
  }
  display.forEach((id, i) => p.append(`forcedisplay[${i}]`, String(id)));
  p.append('range', `${start}-${start + limit - 1}`);
  p.append('sort', '1');
  p.append('order', 'ASC');
  return p.toString();
}

function mapRow(type, raw) {
  const row = { id: raw['2'] };
  for (const c of type.columns) row[c.key] = decodeHtml(raw[String(c.id)]);
  return row;
}

async function listItems(typeKey, { query, start = 0, limit = 20 } = {}) {
  const type = ASSET_TYPES[typeKey];
  if (!type) throw new Error('Tipo de inventario no válido.');
  return withSession(async (http, cfg, sessionToken) => {
    const display = [2, ...type.columns.map((c) => c.id)];
    const res = await http.get(`/search/${type.itemtype}?${searchQuery({ query, start, limit, display })}`, {
      headers: { 'App-Token': cfg.appToken, 'Session-Token': sessionToken },
    });
    if (res.status !== 200 && res.status !== 206) {
      throw new Error(`Error listando ${type.label.toLowerCase()} en GLPI: ${explainGlpiError(res.status, res.data)}`);
    }
    const total = parseInt(String(res.headers['content-range'] || '').split('/')[1], 10);
    const rows = (res.data && res.data.data) || [];
    return {
      items: rows.map((r) => mapRow(type, r)),
      total: Number.isNaN(total) ? (res.data.totalcount || rows.length) : total,
    };
  });
}

// Todo el inventario de un tipo (para exportar), en paginas de 200.
async function listAllItems(typeKey, { query, max = 20000 } = {}) {
  const type = ASSET_TYPES[typeKey];
  if (!type) throw new Error('Tipo de inventario no válido.');
  return withSession(async (http, cfg, sessionToken) => {
    const display = [2, ...type.columns.map((c) => c.id)];
    const headers = { 'App-Token': cfg.appToken, 'Session-Token': sessionToken };
    const all = [];
    let total = Infinity;
    for (let start = 0; start < Math.min(total, max); start += 200) {
      const res = await http.get(`/search/${type.itemtype}?${searchQuery({ query, start, limit: 200, display })}`, { headers });
      if (res.status !== 200 && res.status !== 206) {
        throw new Error(`Error exportando ${type.label.toLowerCase()}: ${explainGlpiError(res.status, res.data)}`);
      }
      const t = parseInt(String(res.headers['content-range'] || '').split('/')[1], 10);
      total = Number.isNaN(t) ? (res.data.totalcount || 0) : t;
      const rows = (res.data && res.data.data) || [];
      all.push(...rows.map((r) => mapRow(type, r)));
      if (rows.length < 200) break;
    }
    return all;
  });
}

async function getItemDetail(typeKey, id) {
  const type = ASSET_TYPES[typeKey];
  if (!type) throw new Error('Tipo de inventario no válido.');
  return withSession(async (http, cfg, sessionToken) => {
    const res = await http.get(`/${type.itemtype}/${encodeURIComponent(id)}`, {
      headers: { 'App-Token': cfg.appToken, 'Session-Token': sessionToken },
      params: { expand_dropdowns: true },
    });
    if (res.status !== 200) throw new Error(explainGlpiError(res.status, res.data));
    const fields = type.detail
      .filter(([k]) => res.data[k] !== undefined)
      .map(([k, label]) => ({ label, value: decodeHtml(res.data[k]) || '—' }));
    return { name: decodeHtml(res.data.name) || `${type.singular} #${id}`, fields, raw: res.data };
  });
}

// Monitores, impresoras y otros equipos conectados a una computadora
// (Computer_Item en GLPI). Para un monitor/impresora, a que computadora esta
// conectado.
async function getConnections(typeKey, id) {
  const type = ASSET_TYPES[typeKey];
  if (!type) return [];
  return withSession(async (http, cfg, sessionToken) => {
    const headers = { 'App-Token': cfg.appToken, 'Session-Token': sessionToken };
    const res = await http.get(`/${type.itemtype}/${encodeURIComponent(id)}/Computer_Item`, { headers });
    if (res.status !== 200 && res.status !== 206) return [];
    const rows = Array.isArray(res.data) ? res.data : [];
    const out = [];
    for (const row of rows.slice(0, 50)) {
      const otherType = type.itemtype === 'Computer' ? row.itemtype : 'Computer';
      const otherId = type.itemtype === 'Computer' ? row.items_id : row.computers_id;
      let name = `#${otherId}`;
      try {
        const r = await http.get(`/${otherType}/${otherId}`, { headers });
        if (r.status === 200) name = decodeHtml(r.data.name) || name;
      } catch (_) { /* se muestra el id */ }
      out.push({ itemtype: otherType, typeKey: ITEMTYPE_TO_KEY[otherType] || null, id: otherId, name });
    }
    return out;
  });
}

// ---------------------------------------------------------------------
// API clasica o API v2 (GLPI 11): se elige en Configuracion
// (glpi_api_version). Las rutas llaman siempre a estas funciones y no
// necesitan saber cual esta en uso.
// ---------------------------------------------------------------------
const v2 = require('./glpiV2Client');

async function v2Config() {
  const s = await settingsService.getAll();
  if (s.glpi_api_version !== 'v2') return null;
  return {
    root: v2.apiRoot(s.glpi_base_url),
    clientId: s.glpi_oauth_client_id || '',
    clientSecret: s.glpi_oauth_client_secret || '',
    username: s.glpi_oauth_username || '',
    password: s.glpi_oauth_password || '',
  };
}

function dual(legacyFn, v2Fn) {
  return async (...args) => {
    const cfg = await v2Config();
    return cfg ? v2Fn(cfg, ...args) : legacyFn(...args);
  };
}

module.exports = {
  ASSET_TYPES,
  normalizeBaseUrl,
  explainGlpiError,
  getConfig,
  apiVersion: async () => ((await v2Config()) ? 'v2' : 'legacy'),
  listItems: dual(listItems, v2.listItems),
  listAllItems: dual(listAllItems, v2.listAllItems),
  getItemDetail: dual(getItemDetail, v2.getItemDetail),
  getConnections: dual(getConnections, v2.getConnections),
  testConnection: dual(testConnection, v2.testConnection),
  searchComputers: dual(searchComputers, v2.searchComputers),
  listComputers,
  getComputerDetail,
  getComputerSoftware: dual(getComputerSoftware, v2.getComputerSoftware),
  listEntities: dual(listEntities, v2.listEntities),
  createContract: dual(createContract, v2.createContract),
  createSoftwareLicense: dual(createSoftwareLicense, async () => {
    throw new Error('Crear licencias en GLPI todavía no está disponible con la API v2; use la API clásica para esa acción.');
  }),
};
