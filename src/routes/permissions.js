const express = require('express');
const pool = require('../db/pool');
const { requireAuth, isSuperAdmin, ROLES } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const auditService = require('../services/auditService');
const { MODULES, CONFIGURABLE_ROLES, DEFAULT_MODULE_ACCESS, ACCESS } = require('../middleware/modules');

const router = express.Router();
router.use(requireAuth, isSuperAdmin, verifyCsrfToken);

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

    // Usuarios con permisos especiales (mandan sobre su perfil; se editan en la ficha del usuario).
    const [special] = await pool.query(`SELECT u.id, u.full_name, u.role, m.module, m.access FROM user_modules m JOIN users u ON u.id = m.user_id
      WHERE u.role <> 'superadmin' ORDER BY u.full_name, m.module`);
    const byUser = new Map();
    for (const r of special) {
      if (!MODULES[r.module] || !ACCESS[r.access]) continue;
      const u = byUser.get(r.id) || { id: r.id, name: r.full_name, role: r.role, items: [] };
      u.items.push({ label: MODULES[r.module].replace(/ \(.*/, ''), access: r.access });
      byUser.set(r.id, u);
    }
    res.render('permissions/index', { title: 'Permisos', matrix, roles: CONFIGURABLE_ROLES, ROLES, ACCESS, specials: [...byUser.values()] });
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
