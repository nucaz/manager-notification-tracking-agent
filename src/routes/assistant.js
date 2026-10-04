// Asistente de la aplicacion ("Preguntar a la IA"). Responde en JSON al
// panel que aparece en todas las pantallas (public/js/asistente.js).
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const assistantService = require('../services/assistantService');
const aiService = require('../services/aiService');
const reportService = require('../services/reportService');
const { buildPdf } = require('../services/reportPdf');

const router = express.Router();

// Las respuestas son JSON: aqui no sirven los redirects de requireAuth,
// moduleRequired ni verifyCsrfToken (el navegador recibiria una pagina).
router.use((req, res, next) => {
  if (!req.session.user) return res.status(401).json({ ok: false, error: 'Su sesión expiró. Recargue la página e inicie sesión.' });
  if (!(res.locals.enabledModules || {}).asistente) {
    return res.status(403).json({ ok: false, error: 'Su rol no tiene habilitado el asistente. Pídalo a un administrador en Permisos.' });
  }
  const expected = req.session.csrfToken;
  const given = req.body && req.body._csrf;
  if (typeof expected !== 'string' || typeof given !== 'string' || expected.length !== given.length
    || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) {
    return res.status(403).json({ ok: false, error: 'La solicitud no es válida o la sesión cambió. Recargue la página.' });
  }
  next();
});

// Cada pregunta es una o varias llamadas a la IA: se limita por usuario.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `asistente:${req.session.user.id}`,
  handler: (req, res) => res.status(429).json({ ok: false, error: 'Demasiadas preguntas seguidas. Espere un minuto e intente de nuevo.' }),
});

router.post('/preguntar', limiter, async (req, res) => {
  const question = String((req.body && req.body.question) || '').trim();
  if (!question) return res.status(400).json({ ok: false, error: 'Escriba una pregunta.' });
  if (question.length > 2000) return res.status(400).json({ ok: false, error: 'La pregunta es demasiado larga (máximo 2000 caracteres).' });
  const user = req.session.user;
  await assistantService.log(user, 'entrante', question);
  try {
    const result = await assistantService.ask({
      question,
      history: Array.isArray(req.body.history) ? req.body.history : [],
      page: String(req.body.page || ''),
      user,
      enabledModules: res.locals.enabledModules,
      providerId: Number(req.body.provider_id) || null,
    });
    await assistantService.log(user, 'saliente', result.provider ? `[${result.provider.label} · ${result.provider.model}] ${result.answer}` : result.answer);
    res.json({ ok: true, ...result });
  } catch (err) {
    await assistantService.log(user, 'saliente', `Error: ${err.message}`);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// Modelos que la persona puede elegir para una pregunta (selector del panel).
router.post('/modelos', async (req, res) => {
  try {
    res.json({ ok: true, ...(await aiService.choices()) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const specOf = (req) => JSON.parse(String(req.body.spec || '{}'));
const metaOf = (req, res) => ({
  appName: res.locals.appName || 'Gestión de Licencias',
  generatedBy: req.session.user.full_name || req.session.user.email || 'usuario',
  generatedAt: reportService.now(),
});

// Reporte temporal: la tabla de una respuesta, a pantalla completa (con
// registros por pagina y columnas ajustables) y con exportacion. No se
// guarda: se vuelve a calcular con la consulta que viaja en el formulario.
router.post('/reporte', async (req, res) => {
  try {
    const result = await assistantService.rerun({ spec: specOf(req), user: req.session.user, enabledModules: res.locals.enabledModules });
    res.render('assistant/report', { title: 'Reporte temporal', result, spec: JSON.stringify(result.spec), generatedAt: reportService.now() });
  } catch (err) {
    res.status(400).render('error', { title: 'No se pudo armar el reporte', message: err.message });
  }
});

// Descarga de una tabla del asistente en Excel o PDF (formulario normal).
router.post('/exportar', async (req, res) => {
  const pdf = req.body.formato === 'pdf';
  try {
    const result = await assistantService.rerun({ spec: specOf(req), user: req.session.user, enabledModules: res.locals.enabledModules });
    const body = pdf
      ? await buildPdf(assistantService.pdfInput(result, metaOf(req, res), String(req.body.barras || '')))
      : await assistantService.buildWorkbook(result, req.session.user);
    res.setHeader('Content-Type', pdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="consulta_${new Date().toISOString().slice(0, 10)}.${pdf ? 'pdf' : 'xlsx'}"`);
    res.send(body);
  } catch (err) {
    res.status(400).json({ ok: false, error: `No se pudo generar el archivo: ${err.message}` });
  }
});

module.exports = router;
