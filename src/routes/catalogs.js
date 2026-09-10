const express = require('express');
const { requireAuth, isAdmin } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const catalogService = require('../services/catalogService');

const router = express.Router();
router.use(requireAuth, isAdmin, verifyCsrfToken);

const TYPES = [
  { value: 'sede', label: 'Sedes' },
  { value: 'area', label: 'Áreas' },
  { value: 'marca', label: 'Marcas' },
  { value: 'modelo', label: 'Modelos' },
];

router.get('/', async (req, res, next) => {
  try {
    const tipo = TYPES.some((t) => t.value === req.query.tipo) ? req.query.tipo : 'sede';
    const items = await catalogService.getAll(tipo);
    res.render('catalogs/index', { title: 'Catálogos', types: TYPES, tipo, items });
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

module.exports = router;
