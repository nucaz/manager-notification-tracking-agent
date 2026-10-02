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
  ERROR_API_DISABLED: 'La API clásica está desactivada en GLPI: Configuración → General → API → "Habilitar API Rest" = Sí (en GLPI 11: "Enable Legacy REST API" = Sí).',
  ERROR_LOGIN_WITH_TOKEN_DISABLED: 'GLPI no permite iniciar sesión con token: Configuración → General → API → "Habilitar inicio de sesión con token externo" = Sí.',
  ERROR_RIGHT_MISSING: 'El usuario de servicio no tiene permiso para ver ese inventario (revise su perfil y entidades en GLPI).',
  ERROR_SESSION_TOKEN_INVALID: 'La sesión con GLPI expiró; vuelva a intentarlo.',
};

function explainGlpiError(status, data) {
  let code = Array.isArray(data) ? data[0] : data && (data.error || data.status);
  // GLPI 11 con la Legacy API apagada responde ["ERROR", "API deshabilitada"].
  if (code === 'ERROR' && Array.isArray(data) && /deshabilitad|disabled|d[eé]sactiv/i.test(String(data[1] || ''))) code = 'ERROR_API_DISABLED';
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

// Varios valores de un mismo campo (dos modulos de memoria, varias IP)
// llegan de la busqueda como arreglo o unidos con "$$##$$".
function values(raw) {
  const list = Array.isArray(raw) ? raw : String(raw === null || raw === undefined ? '' : raw).split('$$##$$');
  return list.map(decodeHtml).filter(Boolean);
}
const unique = (raw) => [...new Set(values(raw))].join(', ');

// Memoria: GLPI guarda el tamano de cada modulo en MiB; se muestra el total.
function memoryTotal(raw) {
  const sizes = values(raw).map(Number);
  if (!sizes.length) return '';
  if (sizes.some((n) => !Number.isFinite(n))) return values(raw).join(', ');
  const total = sizes.reduce((a, b) => a + b, 0);
  const gb = total / 1024;
  const text = total >= 1024 ? `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB` : `${total} MB`;
  return sizes.length > 1 ? `${text} (${sizes.length} módulos)` : text;
}

// IP: sin la de loopback ni las locales de enlace; IPv4 primero.
function ipList(raw) {
  const ips = [...new Set(values(raw))].filter((ip) => !/^(127\.|::1$|fe80:|0\.0\.0\.0$|169\.254\.)/i.test(ip));
  return [...ips.filter((ip) => !ip.includes(':')), ...ips.filter((ip) => ip.includes(':'))].join(', ');
}

// Columnas de computadoras que solo entrega la busqueda de la API clasica
// (sistema operativo, componentes y red). El numero de cada opcion de
// busqueda se averigua en el propio GLPI por su tabla y campo (ver
// resolveColumns); `id` es el de GLPI 11, por si esa consulta fallara.
const EXTRA_COLUMNS = [
  { id: 45, key: 'os', label: 'Sistema operativo', table: 'glpi_operatingsystems', field: 'name', format: unique },
  { id: 46, key: 'os_version', label: 'Versión del SO', table: 'glpi_operatingsystemversions', field: 'name', format: unique },
  { id: 17, key: 'processor', label: 'Procesador', table: 'glpi_deviceprocessors', field: 'designation', format: unique },
  { id: 110, key: 'memory_type', label: 'Tipo de memoria', table: 'glpi_devicememories', field: 'designation', format: unique },
  { id: 111, key: 'memory', label: 'Memoria', table: 'glpi_items_devicememories', field: 'size', format: memoryTotal },
  { id: 126, key: 'ip', label: 'IP', table: 'glpi_ipaddresses', field: 'name', format: ipList },
].map((c) => ({ ...c, extra: true }));

const ASSET_TYPES = {
  computadoras: {
    itemtype: 'Computer', label: 'Computadoras', singular: 'Computadora', icon: 'bi-pc-display',
    columns: [...COMMON_COLUMNS.slice(0, 5), ...EXTRA_COLUMNS, ...COMMON_COLUMNS.slice(5)],
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

function mapRow(columns, raw) {
  const row = { id: raw['2'] };
  for (const c of columns) row[c.key] = (c.format || decodeHtml)(raw[String(c.id)]);
  return row;
}

// Una columna que este GLPI no ofrece no viene en la fila: se deja vacia.
function fillMissing(type, row) {
  for (const c of type.columns) if (row[c.key] === undefined) row[c.key] = '';
  return row;
}

// Columnas del tipo con el numero de opcion de busqueda de ESTE GLPI. Las
// comunes no cambian; las "extra" se buscan en listSearchOptions por tabla
// y campo, porque su numero puede variar entre versiones y plugins.
const optionsCache = new Map();
async function resolveColumns(type, http, headers, cfg) {
  if (!type.columns.some((c) => c.extra)) return type.columns;
  const key = `${cfg.baseUrl}|${type.itemtype}`;
  const hit = optionsCache.get(key);
  if (hit && Date.now() - hit.at < 3600 * 1000) return hit.columns;
  let options = {};
  try {
    const res = await http.get(`/listSearchOptions/${type.itemtype}`, { headers });
    if (res.status === 200 && res.data && typeof res.data === 'object') options = res.data;
  } catch (_) {
    // sin la lista se usan los numeros habituales
  }
  const loaded = Object.keys(options).length > 0;
  const columns = type.columns.map((c) => {
    if (!c.extra) return c;
    const match = (id) => options[id] && options[id].table === c.table && options[id].field === c.field;
    const id = match(c.id) ? c.id : Object.keys(options).find((k) => /^\d+$/.test(k) && match(k));
    if (id) return { ...c, id: Number(id) };
    // GLPI respondio sus opciones y esta no existe: la columna queda vacia.
    // Pedir el numero habitual traeria OTRO dato (en un GLPI el 10 era la
    // fecha de ultimo arranque, no el tipo de memoria).
    return loaded ? null : c;
  }).filter(Boolean);
  if (loaded) optionsCache.set(key, { at: Date.now(), columns });
  return columns;
}

async function listItems(typeKey, { query, start = 0, limit = 20 } = {}) {
  const type = ASSET_TYPES[typeKey];
  if (!type) throw new Error('Tipo de inventario no válido.');
  return withSession(async (http, cfg, sessionToken) => {
    const headers = { 'App-Token': cfg.appToken, 'Session-Token': sessionToken };
    const columns = await resolveColumns(type, http, headers, cfg);
    const display = [2, ...columns.map((c) => c.id)];
    const res = await http.get(`/search/${type.itemtype}?${searchQuery({ query, start, limit, display })}`, { headers });
    if (res.status !== 200 && res.status !== 206) {
      throw new Error(`Error listando ${type.label.toLowerCase()} en GLPI: ${explainGlpiError(res.status, res.data)}`);
    }
    const total = parseInt(String(res.headers['content-range'] || '').split('/')[1], 10);
    const rows = (res.data && res.data.data) || [];
    return {
      items: rows.map((r) => fillMissing(type, mapRow(columns, r))),
      total: Number.isNaN(total) ? (res.data.totalcount || rows.length) : total,
    };
  });
}

// Todo el inventario de un tipo (para exportar), en paginas de 200.
async function listAllItems(typeKey, { query, max = 20000 } = {}) {
  const type = ASSET_TYPES[typeKey];
  if (!type) throw new Error('Tipo de inventario no válido.');
  return withSession(async (http, cfg, sessionToken) => {
    const headers = { 'App-Token': cfg.appToken, 'Session-Token': sessionToken };
    const columns = await resolveColumns(type, http, headers, cfg);
    const display = [2, ...columns.map((c) => c.id)];
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
      all.push(...rows.map((r) => fillMissing(type, mapRow(columns, r))));
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

// ---------------------------------------------------------------------
// Datos ampliados de las computadoras (sistema operativo, procesador,
// memoria, IP). La API v2 de GLPI 11 no los entrega: no tiene sistema
// operativo ni direcciones IP, y los componentes van uno por equipo. La
// busqueda de la API clasica si, en una sola consulta. Por eso, aunque la
// app este en modo v2, estos datos se piden a la API clasica del mismo
// GLPI con el App-Token y el User-Token, si estan configurados.
// ---------------------------------------------------------------------
const EXTRAS_HELP = 'En GLPI: Configuración → General → API → active la API clásica ("Enable Legacy REST API") y el inicio de sesión con token externo; '
  + 'en el cliente de API autorice la IP de este servidor; y en Configuración de esta app complete App-Token y User-Token.';
const extrasCache = new Map(); // baseUrl -> { at, map }

// Map id de computadora -> { os, os_version, processor, memory_type, memory, ip }.
async function computerExtras() {
  const legacy = await getConfig();
  if (!legacy.appToken || !legacy.userToken) throw new Error('faltan el App-Token y el User-Token de la API clásica.');
  const hit = extrasCache.get(legacy.baseUrl);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.map;
  const type = ASSET_TYPES.computadoras;
  const map = await withSession(async (http, cfg, sessionToken) => {
    const headers = { 'App-Token': cfg.appToken, 'Session-Token': sessionToken };
    const columns = (await resolveColumns(type, http, headers, cfg)).filter((c) => c.extra);
    const display = [2, ...columns.map((c) => c.id)];
    const out = new Map();
    let total = Infinity;
    for (let start = 0; start < Math.min(total, 20000); start += 200) {
      const res = await http.get(`/search/${type.itemtype}?${searchQuery({ start, limit: 200, display })}`, { headers });
      if (res.status !== 200 && res.status !== 206) throw new Error(explainGlpiError(res.status, res.data));
      const t = parseInt(String(res.headers['content-range'] || '').split('/')[1], 10);
      total = Number.isNaN(t) ? (res.data.totalcount || 0) : t;
      const rows = (res.data && res.data.data) || [];
      rows.forEach((r) => { const row = mapRow(columns, r); out.set(String(row.id), row); });
      if (rows.length < 200) break;
    }
    return out;
  });
  extrasCache.set(legacy.baseUrl, { at: Date.now(), map });
  return map;
}

// Completa las filas (del modo v2) con los datos ampliados. Nunca hace
// fallar el listado: si la API clasica no responde, devuelve el motivo.
async function addExtras(typeKey, items) {
  if (typeKey !== 'computadoras') return null;
  try {
    const map = await computerExtras();
    items.forEach((it) => {
      const extra = map.get(String(it.id));
      if (extra) EXTRA_COLUMNS.forEach((c) => { it[c.key] = extra[c.key] || ''; });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message.replace(/^No se pudo iniciar sesión en GLPI: /, ''), help: EXTRAS_HELP };
  }
}

async function listItemsAny(typeKey, opts) {
  const cfg = await v2Config();
  if (!cfg) return listItems(typeKey, opts); // la API clasica ya trae todas las columnas
  const res = await v2.listItems(cfg, typeKey, opts);
  res.extras = await addExtras(typeKey, res.items);
  return res;
}

async function listAllItemsAny(typeKey, opts) {
  const cfg = await v2Config();
  if (!cfg) return listAllItems(typeKey, opts);
  const items = await v2.listAllItems(cfg, typeKey, opts);
  items.extras = await addExtras(typeKey, items); // el arreglo lleva el resultado, para quien quiera avisar
  return items;
}

// Detalle del equipo: a los datos generales se suman los ampliados.
async function getItemDetailAny(typeKey, id) {
  const cfg = await v2Config();
  const detail = cfg ? await v2.getItemDetail(cfg, typeKey, id) : await getItemDetail(typeKey, id);
  if (typeKey === 'computadoras') {
    try {
      const extra = (await computerExtras()).get(String(id));
      if (extra) EXTRA_COLUMNS.forEach((c) => { if (extra[c.key]) detail.fields.push({ label: c.label, value: extra[c.key] }); });
    } catch (_) {
      // el detalle se muestra igual, sin los datos ampliados
    }
  }
  return detail;
}

// ---------------------------------------------------------------------
// Cuantas computadoras, monitores e impresoras hay en GLPI (panel
// principal). El panel no puede quedar esperando a GLPI: el conteo se
// guarda 10 minutos, pasado ese tiempo se entrega el ultimo conocido
// mientras se renueva por detras, y la primera vez se espera poco.
//   null                      -> GLPI no esta configurado
//   { computadoras: n|null }  -> null = sin respuesta o sin permiso
// ---------------------------------------------------------------------
const COUNTS_TTL_MS = 10 * 60 * 1000;
const COUNTS_WAIT_MS = 4000;
const countsCache = { url: null, at: 0, value: null, pending: null };
const NO_COUNTS = Object.fromEntries(Object.keys(ASSET_TYPES).map((k) => [k, null]));

async function assetCounts() {
  const settings = await settingsService.getAll();
  const url = settings.glpi_base_url || '';
  if (!url) return null;
  if (countsCache.url !== url) Object.assign(countsCache, { url, at: 0, value: null });
  if (countsCache.value && Date.now() - countsCache.at < COUNTS_TTL_MS) return countsCache.value;
  if (!countsCache.pending) {
    // Se cuenta pidiendo un solo registro de cada tipo (el total viene en la
    // respuesta). No se usa "probar conexion": esa pide ademas el perfil del
    // usuario, que un usuario de servicio puede no tener permiso de ver.
    countsCache.pending = Promise.all(Object.keys(ASSET_TYPES).map(async (key) => {
      try {
        const v2cfg = await v2Config();
        const r = v2cfg ? await v2.listItems(v2cfg, key, { start: 0, limit: 1 }) : await listItems(key, { start: 0, limit: 1 });
        return [key, Number.isFinite(Number(r.total)) ? Number(r.total) : null];
      } catch (_) {
        return [key, null];
      }
    })).then((pairs) => {
      if (countsCache.url !== url) return;
      const value = Object.fromEntries(pairs);
      // Si GLPI no respondio nada, se anota "sin respuesta" solo por un minuto.
      const failed = pairs.every((pair) => pair[1] === null);
      const at = failed ? Date.now() - COUNTS_TTL_MS + 60000 : Date.now();
      Object.assign(countsCache, { at, value: failed && countsCache.value ? countsCache.value : value }); // con fallo se conserva el ultimo conteo bueno
    }).finally(() => { countsCache.pending = null; });
  }
  if (countsCache.value) return countsCache.value;
  await Promise.race([countsCache.pending, new Promise((resolve) => { setTimeout(resolve, COUNTS_WAIT_MS).unref(); })]);
  return countsCache.value || NO_COUNTS;
}

module.exports = {
  ASSET_TYPES,
  assetCounts,
  normalizeBaseUrl,
  explainGlpiError,
  getConfig,
  apiVersion: async () => ((await v2Config()) ? 'v2' : 'legacy'),
  listItems: listItemsAny,
  listAllItems: listAllItemsAny,
  getItemDetail: getItemDetailAny,
  _clearCaches: () => { optionsCache.clear(); extrasCache.clear(); Object.assign(countsCache, { url: null, at: 0, value: null }); },
  _formats: { ipList, memoryTotal },
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
