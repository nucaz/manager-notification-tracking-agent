const express = require('express');
const pool = require('../db/pool');
const { requireAuth, canWrite } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const employeeService = require('../services/employeeService');
const catalogService = require('../services/catalogService');

const router = express.Router();
router.use(requireAuth, verifyCsrfToken);

async function loadCatalogOptions() {
  const [sedes, areas] = await Promise.all([
    catalogService.getActive('sede'),
    catalogService.getActive('area'),
  ]);
  return { sedes, areas };
}

router.get('/', async (req, res, next) => {
  try {
    const { q } = req.query;
    const items = await employeeService.list(q);
    res.render('employees/list', { title: 'Empleados', items, q: q || '' });
  } catch (err) {
    next(err);
  }
});

router.get('/nuevo', canWrite, async (req, res, next) => {
  try {
    const catalogs = await loadCatalogOptions();
    res.render('employees/form', { title: 'Nuevo empleado', item: {}, ...catalogs });
  } catch (err) {
    next(err);
  }
});

router.post('/nuevo', canWrite, async (req, res, next) => {
  try {
    const { dni, first_name, last_name, area, sede, cargo, notes } = req.body;
    if (!dni || !first_name || !last_name) {
      req.flash('error', 'DNI, nombres y apellidos son obligatorios.');
      return res.redirect('/empleados/nuevo');
    }
    await pool.query(
      `INSERT INTO employees (dni, first_name, last_name, area, sede, cargo, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [dni, first_name, last_name, area || null, sede || null, cargo || null, notes || null, req.session.user.id]
    );
    req.flash('success', 'Empleado registrado correctamente.');
    res.redirect('/empleados');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'Ya existe un empleado con ese DNI.');
      return res.redirect('/empleados/nuevo');
    }
    next(err);
  }
});

router.get('/:id/editar', canWrite, async (req, res, next) => {
  try {
    const item = await employeeService.get(req.params.id);
    if (!item) {
      req.flash('error', 'Empleado no encontrado.');
      return res.redirect('/empleados');
    }
    const catalogs = await loadCatalogOptions();
    res.render('employees/form', { title: 'Editar empleado', item, ...catalogs });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/editar', canWrite, async (req, res, next) => {
  try {
    const { dni, first_name, last_name, area, sede, cargo, notes } = req.body;
    if (!dni || !first_name || !last_name) {
      req.flash('error', 'DNI, nombres y apellidos son obligatorios.');
      return res.redirect(`/empleados/${req.params.id}/editar`);
    }
    await employeeService.update(req.params.id, { dni, first_name, last_name, area, sede, cargo, notes });
    req.flash('success', 'Empleado actualizado correctamente.');
    res.redirect('/empleados');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'Ya existe otro empleado con ese DNI.');
      return res.redirect(`/empleados/${req.params.id}/editar`);
    }
    next(err);
  }
});

router.post('/:id/eliminar', canWrite, async (req, res, next) => {
  try {
    await employeeService.remove(req.params.id);
    req.flash('success', 'Empleado eliminado.');
    res.redirect('/empleados');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
