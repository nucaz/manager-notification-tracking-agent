// Acceso unico con DevOps Sidecar: esta aplicacion es la unica que
// autentica personas (usuario, contrasena, captcha y 2FA) y emite pases
// firmados de corta duracion que el sidecar verifica con el mismo secreto
// (SSO_SHARED_SECRET en los dos .env).
//
// Formato: v1.<carga JSON en base64url>.<HMAC-SHA256 en base64url>
// El verificador esta en devops-sidecar/app/services/sso_service.py: si se
// cambia algo aqui, hay que cambiarlo alla.
const crypto = require('crypto');
const env = require('../config/env');

const PASS_SECONDS = 60;     // pase de entrada de una persona (un solo uso)
const SERVICE_SECONDS = 60;  // pase para una llamada de esta aplicacion a la API del sidecar

const enabled = () => !!env.ssoSharedSecret;

function sign(payload) {
  if (!enabled()) throw new Error('El acceso único con DevOps no está configurado (falta SSO_SHARED_SECRET).');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', env.ssoSharedSecret).update(`v1.${body}`).digest('base64url');
  return `v1.${body}.${signature}`;
}

const now = () => Math.floor(Date.now() / 1000);

// Pase para que `user` entre al sidecar. appUrl = por donde entro el
// usuario a esta aplicacion (para que el sidecar sepa volver).
function userPass(user, appUrl) {
  return sign({
    aud: 'sidecar-sso', exp: now() + PASS_SECONDS, jti: crypto.randomBytes(16).toString('hex'),
    sub: user.email, name: user.full_name || user.email, role: user.role, app: appUrl,
  });
}

function servicePass() {
  return sign({ aud: 'sidecar-api', exp: now() + SERVICE_SECONDS, sub: 'aplicacion-principal' });
}

// Verifica un pase firmado por el sidecar (mismo formato). Carga si la
// firma es valida, no vencio y es para `audience`; si no, null.
//   - app-ai  el sidecar pide a esta aplicacion que genere con la IA configurada
function verify(token, audience) {
  if (!enabled() || typeof token !== 'string' || token.split('.').length !== 3) return null;
  const [version, body, signature] = token.split('.');
  if (version !== 'v1') return null;
  const expected = crypto.createHmac('sha256', env.ssoSharedSecret).update(`v1.${body}`).digest('base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!payload || payload.aud !== audience || typeof payload.exp !== 'number' || payload.exp < now()) return null;
  return payload;
}

// Direccion del sidecar tal como la ve el navegador. SIDECAR_PUBLIC_URL
// admite {host} (el nombre o IP por el que se entro a esta aplicacion).
function sidecarPublicUrl(req) {
  const template = env.sidecarPublicUrl || `${req.protocol}://{host}:8091`;
  return template.replace('{host}', req.hostname).replace(/\/$/, '');
}

module.exports = { enabled, userPass, servicePass, verify, sidecarPublicUrl, _sign: sign };
