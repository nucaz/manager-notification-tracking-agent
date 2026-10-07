// Configuracion > Inteligencia artificial: proveedores (locales y en la
// nube), que proveedor usa cada funcion de esta aplicacion y de DevOps
// Sidecar, y el respaldo. Solo administradores.
const crypto = require('crypto');
const express = require('express');
const { requireAuth, isSuperAdmin } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const aiService = require('../services/aiService');
const auditService = require('../services/auditService');

const router = express.Router();
router.use(requireAuth, isSuperAdmin);

router.get('/', async (req, res, next) => {
  try {
    const providers = await aiService.list();
    const editing = req.query.editar ? providers.find((p) => p.id === Number(req.query.editar)) || null : null;
    res.render('settings/ai', {
      title: 'Inteligencia artificial',
      providers, editing, adding: req.query.nuevo === '1',
      uses: await aiService.uses(), USES: aiService.USES, KINDS: aiService.KINDS,
    });
  } catch (err) {
    next(err);
  }
});

async function saveProvider(req, res, id) {
  try {
    const savedId = await aiService.save(req.body, id);
    await auditService.log(req, { user: req.session.user, action: id ? 'ia_proveedor_editado' : 'ia_proveedor_creado', target: `${req.body.label} (${req.body.kind} ${req.body.model})` });
    req.flash('success', `Proveedor "${req.body.label}" guardado. Use "Probar" para comprobar que responde y detectar qué sabe hacer el modelo.`);
    res.redirect(`/configuracion/ia#p${savedId}`);
  } catch (err) {
    req.flash('error', err.message);
    res.redirect(id ? `/configuracion/ia?editar=${id}` : '/configuracion/ia?nuevo=1');
  }
}

router.post('/proveedores', verifyCsrfToken, (req, res) => saveProvider(req, res, null));
router.post('/proveedores/:id', verifyCsrfToken, (req, res) => saveProvider(req, res, Number(req.params.id)));

router.post('/proveedores/:id/eliminar', verifyCsrfToken, async (req, res) => {
  try {
    const p = await aiService.get(req.params.id);
    await aiService.remove(req.params.id);
    await auditService.log(req, { user: req.session.user, action: 'ia_proveedor_eliminado', target: p ? p.label : req.params.id });
    req.flash('success', 'Proveedor eliminado.');
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/configuracion/ia');
});

router.post('/proveedores/:id/probar', verifyCsrfToken, async (req, res) => {
  try {
    const r = await aiService.test(req.params.id);
    req.flash(r.ok ? 'success' : 'error', `${r.provider.label} (${r.provider.model}): ${r.message}`);
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect(`/configuracion/ia#p${Number(req.params.id)}`);
});

router.post('/usos', verifyCsrfToken, async (req, res) => {
  try {
    await aiService.saveUses(req.body);
    await auditService.log(req, { user: req.session.user, action: 'ia_usos_actualizados',
      detail: Object.keys(aiService.USES).map((k) => `${k}=${req.body[`ai_uso_${k}`] || '-'}`).concat(`respaldo=${req.body.ai_respaldo || '-'}`).join(', ') });
    req.flash('success', 'Asignación de modelos guardada. Aplica de inmediato, también en DevOps Sidecar.');
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/configuracion/ia');
});

// Modelos que ofrece el proveedor, con los datos del formulario (aun sin
// guardar). Responde JSON al boton "Cargar modelos".
router.post('/modelos', async (req, res) => {
  const expected = req.session.csrfToken;
  const given = req.body && req.body._csrf;
  if (typeof expected !== 'string' || typeof given !== 'string' || expected.length !== given.length
    || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return res.status(403).json({ ok: false, error: 'La sesión cambió. Recargue la página.' });
  try {
    const models = await aiService.models(req.body, Number(req.body.id) || null);
    res.json({ ok: true, models: models.slice(0, 300) });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

module.exports = router;
