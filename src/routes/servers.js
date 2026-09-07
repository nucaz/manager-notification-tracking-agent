const express = require('express');
const pool = require('../db/pool');
const { requireAuth, canWrite } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const { daysUntil, statusFromDays } = require('../services/expirationService');

const router = express.Router();
router.use(requireAuth, verifyCsrfToken);

const FIELDS = [
  'name', 'asset_type', 'environment', 'criticality', 'ip_address', 'operating_system',
  'provider', 'responsible', 'site_location', 'purchase_date', 'support_expiration_date',
  'cost', 'currency', 'status', 'dependencies', 'glpi_computer_id', 'notes',
];

function readForm(body) {
  const out = {};
  for (const f of FIELDS) {
    let v = body[f];
    if (v === '') v = null;
    out[f] = v;
  }
  return out;
}

router.get('/', async (req, res, next) => {
  try {
    const { q, status } = req.query;
    let sql = 'SELECT * FROM servers WHERE 1=1';
    const params = [];
    if (q) {
      sql += ' AND (name LIKE ? OR ip_address LIKE ? OR responsible LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += ' ORDER BY support_expiration_date IS NULL, support_expiration_date ASC';
    const [rows] = await pool.query(sql, params);
    const enriched = rows.map((r) => {
      const days = daysUntil(r.support_expiration_date);
      return { ...r, days_left: days, computed_status: statusFromDays(days) };
    });
    const filtered = status ? enriched.filter((r) => r.computed_status === status) : enriched;
    res.render('servers/list', { title: 'Servidores y Activos TI', items: filtered, q: q || '', status: status || '' });
  } catch (err) {
    next(err);
  }
});

router.get('/nuevo', canWrite, (req, res) => {
  res.render('servers/form', { title: 'Nuevo servidor / activo', item: {}, errors: [] });
});

router.post('/nuevo', canWrite, async (req, res, next) => {
  try {
    const data = readForm(req.body);
    if (!data.name) {
      req.flash('error', 'El nombre del activo es obligatorio.');
      return res.redirect('/servidores/nuevo');
    }
    const cols = Object.keys(data);
    const values = Object.values(data);
    const placeholders = cols.map(() => '?').join(', ');
    await pool.query(
      `INSERT INTO servers (${cols.join(', ')}, created_by) VALUES (${placeholders}, ?)`,
      [...values, req.session.user.id]
    );
    req.flash('success', 'Activo registrado correctamente.');
    res.redirect('/servidores');
  } catch (err) {
    next(err);
  }
});

router.get('/:id/editar', canWrite, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM servers WHERE id = ?', [req.params.id]);
    if (!rows[0]) {
      req.flash('error', 'Activo no encontrado.');
      return res.redirect('/servidores');
    }
    res.render('servers/form', { title: 'Editar servidor / activo', item: rows[0], errors: [] });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/editar', canWrite, async (req, res, next) => {
  try {
    const data = readForm(req.body);
    const cols = Object.keys(data);
    const values = Object.values(data);
    const setClause = cols.map((c) => `${c} = ?`).join(', ');
    await pool.query(`UPDATE servers SET ${setClause} WHERE id = ?`, [...values, req.params.id]);
    req.flash('success', 'Activo actualizado correctamente.');
    res.redirect('/servidores');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/eliminar', canWrite, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM servers WHERE id = ?', [req.params.id]);
    req.flash('success', 'Activo eliminado.');
    res.redirect('/servidores');
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM servers WHERE id = ?', [req.params.id]);
    if (!rows[0]) {
      req.flash('error', 'Activo no encontrado.');
      return res.redirect('/servidores');
    }
    const [attachments] = await pool.query(
      'SELECT * FROM attachments WHERE entity_type = "server" AND entity_id = ? ORDER BY uploaded_at DESC',
      [req.params.id]
    );
    const days = daysUntil(rows[0].support_expiration_date);
    res.render('servers/detail', {
      title: rows[0].name,
      item: { ...rows[0], days_left: days, computed_status: statusFromDays(days) },
      attachments,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
