// Cliente ligero para la API REST de GLPI.
// Documentacion oficial: https://github.com/glpi-project/glpi/blob/main/apirest.md
//
// Flujo de autenticacion GLPI:
//   1. initSession con App-Token + (User-Token o usuario/clave) -> Session-Token
//   2. Cada peticion posterior envia App-Token + Session-Token
//   3. killSession al terminar (opcional, GLPI expira la sesion por inactividad)
const axios = require('axios');
const settingsService = require('./settingsService');

async function getConfig() {
  const settings = await settingsService.getAll();
  return {
    baseUrl: (settings.glpi_base_url || '').replace(/\/+$/, ''),
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
  const res = await http.get('/initSession', {
    headers: {
      'App-Token': cfg.appToken,
      Authorization: `user_token ${cfg.userToken}`,
    },
  });
  if (res.status !== 200 || !res.data || !res.data.session_token) {
    throw new Error(
      `No se pudo iniciar sesion en GLPI (HTTP ${res.status}): ${JSON.stringify(res.data)}`
    );
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
    const res = await http.get('/getMyProfiles', {
      headers: { 'App-Token': cfg.appToken, 'Session-Token': sessionToken },
    });
    if (res.status !== 200) {
      throw new Error(`GLPI respondio con HTTP ${res.status}: ${JSON.stringify(res.data)}`);
    }
    return { ok: true, profiles: res.data.myprofiles || res.data };
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

module.exports = {
  getConfig,
  testConnection,
  searchComputers,
  listComputers,
  getComputerDetail,
  getComputerSoftware,
  listEntities,
  createContract,
  createSoftwareLicense,
};
