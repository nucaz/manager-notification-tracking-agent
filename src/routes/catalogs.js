const express = require('express');
const { requireAuth, isAdmin } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const catalogService = require('../services/catalogService');
const mobileModelService = require('../services/mobileModelService');
const catalogMergeService = require('../services/catalogMergeService');
const auditService = require('../services/auditService');

const router = express.Router();
router.use(requireAuth, isAdmin, verifyCsrfToken);

const TYPES = [
  { value: 'sede', label: 'Sedes' },
  { value: 'area', label: 'Áreas' },
  { value: 'marca', label: 'Marcas' },
  { value: 'modelo', label: 'Modelos (por marca)' },
  { value: 'operadora', label: 'Operadoras' },
];

router.get('/', async (req, res, next) => {
  try {
    const tipo = TYPES.some((t) => t.value === req.query.tipo) ? req.query.tipo : 'sede';
    const items = await catalogService.getAll(tipo);
    const countries = await catalogService.getAllCountries();
    const models = tipo === 'modelo' ? await mobileModelService.list() : [];
    const marcas = tipo === 'modelo' ? await catalogService.getActive('marca') : [];
    res.render('catalogs/index', { title: 'Catálogos', types: TYPES, tipo, items, countries, models, marcas });
  } catch (err) {
    next(err);
  }
});

router.post('/nuevo', async (req, res, next) => {
  try {
    const { catalog_type, value } = req.body;
    if (!catalog_type || !value) {
      req.flash('error', 'Tipo y valor son obligatorios.');
      return res.redirect(`/configuracion/catalogos?tipo=${catalog_type || ''}`);
    }
    await catalogService.add(catalog_type, value.trim(), req.session.user.id);
    req.flash('success', 'Valor agregado correctamente.');
    res.redirect(`/configuracion/catalogos?tipo=${catalog_type}`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'Ese valor ya existe en el catálogo.');
      return res.redirect(`/configuracion/catalogos?tipo=${req.body.catalog_type}`);
    }
    next(err);
  }
});

// --- Unificar valores (ej. "BO" -> "BACKOFFICE") --------------------------
const MERGE_TYPES = [['area', 'Áreas'], ['sede', 'Sedes'], ['marca', 'Marcas'], ['operadora', 'Operadoras']];
const mergeType = (t) => (MERGE_TYPES.some((x) => x[0] === t) ? t : 'area');

router.get('/unificar', async (req, res, next) => {
  try {
    const tipo = mergeType(req.query.tipo);
    res.render('catalogs/merge', { title: 'Unificar valores', tipos: MERGE_TYPES, tipo, valores: await catalogMergeService.values(tipo), preview: null });
  } catch (err) {
    next(err);
  }
});

router.post('/unificar/vista-previa', async (req, res, next) => {
  const tipo = mergeType(req.body.tipo);
  try {
    const preview = await catalogMergeService.preview(tipo, req.body.sources, req.body.target);
    res.render('catalogs/merge', { title: 'Unificar valores', tipos: MERGE_TYPES, tipo, valores: await catalogMergeService.values(tipo), preview });
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', err.message);
    res.redirect(`/configuracion/catalogos/unificar?tipo=${tipo}`);
  }
});

router.post('/unificar', async (req, res, next) => {
  const tipo = mergeType(req.body.tipo);
  try {
    const r = await catalogMergeService.apply(tipo, req.body.sources, req.body.target, req.session.user.id);
    const detail = r.changed.map((c) => `${c.label}: ${c.n}`).join(', ');
    await auditService.log(req, {
      user: req.session.user, action: 'catalogo_unificado', target: `${tipo}: ${r.sources.join(', ')} → ${r.target}`,
      detail: `${detail}; catálogo: ${r.catalogRemoved} quitado(s)${r.catalogAddedTarget ? `, agregado ${r.target}` : ''}`,
    });
    req.flash('success', `Unificado en "${r.target}": ${detail}.`);
    res.redirect(`/configuracion/catalogos/unificar?tipo=${tipo}`);
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', err.message);
    res.redirect(`/configuracion/catalogos/unificar?tipo=${tipo}`);
  }
});

// --- Modelos de celular, cada uno con su marca ------------------------
router.post('/modelos/nuevo', async (req, res) => {
  try {
    await mobileModelService.add(req.body.brand, req.body.model, req.session.user.id);
    req.flash('success', `Modelo ${String(req.body.brand).trim()} ${String(req.body.model).trim()} agregado.`);
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/configuracion/catalogos?tipo=modelo');
});

router.post('/modelos/:id/activar', async (req, res, next) => {
  try {
    await mobileModelService.setActive(req.params.id, req.body.active === '1');
    res.redirect('/configuracion/catalogos?tipo=modelo');
  } catch (err) {
    next(err);
  }
});

router.post('/modelos/:id/eliminar', async (req, res, next) => {
  try {
    await mobileModelService.remove(req.params.id);
    req.flash('success', 'Modelo eliminado del catálogo (los celulares que lo tenían lo conservan).');
    res.redirect('/configuracion/catalogos?tipo=modelo');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/activar', async (req, res, next) => {
  try {
    await catalogService.setActive(req.params.id, req.body.active === '1');
    req.flash('success', 'Estado actualizado.');
    res.redirect(`/configuracion/catalogos?tipo=${req.body.tipo || ''}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/eliminar', async (req, res, next) => {
  try {
    await catalogService.remove(req.params.id);
    req.flash('success', 'Valor eliminado del catálogo.');
    res.redirect(`/configuracion/catalogos?tipo=${req.body.tipo || ''}`);
  } catch (err) {
    next(err);
  }
});

// Codigos de pais (numero de linea de celulares) - estructura distinta a
// catalog_items (3 campos, no un solo texto), ver catalogService.
router.post('/paises/nuevo', async (req, res, next) => {
  try {
    const { country_name, calling_code, mobile_length } = req.body;
    const length = parseInt(mobile_length, 10);
    if (!country_name || !calling_code || !Number.isInteger(length) || length <= 0) {
      req.flash('error', 'País, código y cantidad de dígitos son obligatorios.');
      return res.redirect('/configuracion/catalogos?tipo=sede');
    }
    await catalogService.addCountry(country_name.trim(), calling_code.trim(), length, req.session.user.id);
    req.flash('success', 'País agregado correctamente.');
    res.redirect('/configuracion/catalogos?tipo=sede');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'Ese país/código ya existe.');
      return res.redirect('/configuracion/catalogos?tipo=sede');
    }
    next(err);
  }
});

router.post('/paises/:id/activar', async (req, res, next) => {
  try {
    await catalogService.setCountryActive(req.params.id, req.body.active === '1');
    req.flash('success', 'Estado actualizado.');
    res.redirect('/configuracion/catalogos?tipo=sede');
  } catch (err) {
    next(err);
  }
});

router.post('/paises/:id/eliminar', async (req, res, next) => {
  try {
    await catalogService.removeCountry(req.params.id);
    req.flash('success', 'País eliminado del catálogo.');
    res.redirect('/configuracion/catalogos?tipo=sede');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
