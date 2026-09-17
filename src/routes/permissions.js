const express = require('express');
const pool = require('../db/pool');
const { requireAuth, isAdmin } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const auditService = require('../services/auditService');
const { MODULES, CONFIGURABLE_ROLES, DEFAULT_MODULE_ACCESS } = require('../middleware/modules');

const router = express.Router();
router.use(requireAuth, isAdmin, verifyCsrfToken);

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT role, module, enabled FROM role_modules');
    const overrides = {};
    for (const row of rows) {
      overrides[`${row.role}:${row.module}`] = !!row.enabled;
    }

    const matrix = Object.entries(MODULES).map(([key, label]) => ({
      key,
      label,
      roles: CONFIGURABLE_ROLES.map((role) => ({
        role,
        enabled: overrides[`${role}:${key}`] !== undefined
          ? overrides[`${role}:${key}`]
          : !!(DEFAULT_MODULE_ACCESS[key] || {})[role],
      })),
    }));

    res.render('permissions/index', { title: 'Permisos', matrix, roles: CONFIGURABLE_ROLES });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const writes = [];
    for (const moduleKey of Object.keys(MODULES)) {
      for (const role of CONFIGURABLE_ROLES) {
        const enabled = req.body[`m_${role}_${moduleKey}`] ? 1 : 0;
        writes.push([role, moduleKey, enabled]);
      }
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const [role, moduleKey, enabled] of writes) {
        await conn.query(
          `INSERT INTO role_modules (role, module, enabled) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`,
          [role, moduleKey, enabled]
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    await auditService.log(req, { user: req.session.user, action: 'permissions_update' });
    req.flash('success', 'Permisos actualizados correctamente.');
    res.redirect('/permisos');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
