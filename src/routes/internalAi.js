// IA para DevOps Sidecar: el sidecar no tiene configuracion de IA propia,
// le pide a esta aplicacion que genere con el proveedor asignado a cada uso
// (Configuracion > Inteligencia artificial). Asi las API keys quedan solo
// aqui y cambiar de modelo aplica a las dos aplicaciones a la vez.
//
// Lo llama el sidecar por la red interna de Docker con un pase firmado
// (aud "app-ai", SSO_SHARED_SECRET, ver ssoService.verify). Sin sesion ni
// CSRF: no lo usa un navegador.
const express = require('express');
const ssoService = require('../services/ssoService');
const aiService = require('../services/aiService');

const SIDECAR_USES = ['sidecar_auditoria', 'sidecar_textos'];
const MAX_PROMPT = 400000;
// La auditoria manda el diff del dia completo: con un modelo local puede tardar.
const MIN_TIMEOUT_MS = { sidecar_auditoria: 900000, sidecar_textos: 300000 };

const router = express.Router();
router.use(express.json({ limit: '2mb' }));

router.use((req, res, next) => {
  const header = String(req.headers.authorization || '');
  const pass = header.startsWith('Bearer ') ? ssoService.verify(header.slice(7).trim(), 'app-ai') : null;
  if (!pass) return res.status(401).json({ ok: false, error: 'Pase no válido o vencido.' });
  next();
});

router.get('/estado', async (req, res) => {
  try {
    const out = {};
    for (const use of SIDECAR_USES) {
      const p = await aiService.resolve(use).catch(() => null);
      out[use] = aiService.publicInfo(p);
    }
    res.json({ ok: true, usos: out });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/generar', async (req, res) => {
  const use = String((req.body && req.body.uso) || '');
  const prompt = String((req.body && req.body.prompt) || '');
  if (!SIDECAR_USES.includes(use)) return res.status(400).json({ ok: false, error: `Uso no válido: ${use}` });
  if (!prompt.trim() || prompt.length > MAX_PROMPT) return res.status(400).json({ ok: false, error: 'Texto vacío o demasiado largo.' });
  try {
    const p = await aiService.resolve(use);
    const timeoutMs = Math.max(p.timeout_seconds * 1000, MIN_TIMEOUT_MS[use]);
    const r = await aiService.generateText(use, prompt, { timeoutMs, temperature: 0.2 });
    res.json({ ok: true, text: r.text, proveedor: r.provider, respaldo: r.fellBackFrom || null });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

module.exports = router;
