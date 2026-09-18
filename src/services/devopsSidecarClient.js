// Cliente delgado hacia el modulo DevOps Sidecar (devops-sidecar/, FastAPI
// en Python, servicio aparte en el mismo docker-compose). Se le habla por
// la red interna de Docker (nombre del servicio, no localhost/8091) y con
// HTTP Basic Auth (las mismas credenciales del dashboard de ese modulo).
const axios = require('axios');
const settingsService = require('./settingsService');

async function getConfig() {
  const settings = await settingsService.getAll();
  return {
    baseUrl: (settings.devops_sidecar_url || 'http://devops-sidecar:8000').replace(/\/$/, ''),
    user: settings.devops_sidecar_user || '',
    password: settings.devops_sidecar_password || '',
  };
}

function requireConfig(cfg) {
  if (!cfg.user || !cfg.password) {
    throw new Error('DevOps Sidecar no esta configurado. Ve a Configuracion y completa usuario/contraseña del dashboard.');
  }
}

async function request(method, path, opts = {}) {
  const cfg = await getConfig();
  requireConfig(cfg);
  const res = await axios.request({
    method,
    url: `${cfg.baseUrl}${path}`,
    auth: { username: cfg.user, password: cfg.password },
    timeout: opts.timeout || 20000,
    params: opts.params,
    data: opts.data,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    const detail = res.data && res.data.detail ? res.data.detail : JSON.stringify(res.data);
    throw new Error(`DevOps Sidecar respondió HTTP ${res.status}: ${detail}`);
  }
  return res.data;
}

async function testConnection() {
  return request('get', '/api/repos');
}

async function listRepos() {
  return request('get', '/api/repos');
}

async function leaderboard(period = 'week') {
  return request('get', '/api/leaderboard', { params: { period } });
}

async function latestReport(repoId) {
  return request('get', `/api/repos/${repoId}/reports/latest`);
}

async function commitsHoy(repoId) {
  return request('get', `/api/repos/${repoId}/commits-hoy`, { timeout: 30000 });
}

async function listDeployments(limit = 20) {
  return request('get', '/api/deployments', { params: { limit } });
}

async function listBackups(limit = 20, repoId = null) {
  const params = { limit };
  if (repoId) params.repo_id = repoId;
  return request('get', '/api/backups', { params });
}

async function resumenGeneral() {
  return request('get', '/api/resumen');
}

async function auditNow(repoId) {
  return request('post', `/api/repos/${repoId}/audit-now`, { timeout: 90000 });
}

async function syncNow(repoId) {
  return request('post', `/api/repos/${repoId}/sync`);
}

module.exports = {
  getConfig,
  testConnection,
  listRepos,
  leaderboard,
  latestReport,
  commitsHoy,
  listDeployments,
  listBackups,
  resumenGeneral,
  auditNow,
  syncNow,
};
