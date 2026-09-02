const express = require('express');
const pool = require('../db/pool');
const { requireAuth, canWrite } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const { daysUntil, statusFromDays } = require('../services/expirationService');

const router = express.Router();
router.use(requireAuth, verifyCsrfToken);

const FIELDS = [
  'domain_name', 'registrar', 'dns_provider', 'registration_date', 'expiration_date',
  'renewal_cost', 'currency', 'auto_renew', 'responsible', 'site_location', 'notes',
];

function readForm(body) {
  const out = {};
  for (const f of FIELDS) {
    let v = body[f];
    if (v === '') v = null;
    if (f === 'auto_renew') v = v ? 1 : 0;
    out[f] = v;
  }
  return out;
}

router.get('/', async (req, res, next) => {
  try {
    const { q, status } = req.query;
    let sql = 'SELECT * FROM domains WHERE 1=1';
    const params = [];
    if (q) {
      sql += ' AND (domain_name LIKE ? OR registrar LIKE ? OR responsible LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += ' ORDER BY expiration_date IS NULL, expiration_date ASC';
    const [rows] = await pool.query(sql, params);
    const enriched = rows.map((r) => {
      const days = daysUntil(r.expiration_date);
      return { ...r, days_left: days, computed_status: statusFromDays(days) };
    });
    const filtered = status ? enriched.filter((r) => r.computed_status === status) : enriched;
    res.render('domains/list', { title: 'Dominios', items: filtered, q: q || '', status: status || '' });
  } catch (err) {
    next(err);
  }
});

router.get('/nuevo', canWrite, (req, res) => {
  res.render('domains/form', { title: 'Nuevo dominio', item: {}, errors: [] });
});

router.post('/nuevo', canWrite, async (req, res, next) => {
  try {
    const data = readForm(req.body);
    if (!data.domain_name) {
      req.flash('error', 'El nombre de dominio es obligatorio.');
      return res.redirect('/dominios/nuevo');
    }
    const cols = Object.keys(data);
    const values = Object.values(data);
    const placeholders = cols.map(() => '?').join(', ');
    await pool.query(
      `INSERT INTO domains (${cols.join(', ')}, created_by) VALUES (${placeholders}, ?)`,
      [...values, req.session.user.id]
    );
    req.flash('success', 'Dominio registrado correctamente.');
    res.redirect('/dominios');
  } catch (err) {
    next(err);
  }
});

router.get('/:id/editar', canWrite, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM domains WHERE id = ?', [req.params.id]);
    if (!rows[0]) {
      req.flash('error', 'Dominio no encontrado.');
      return res.redirect('/dominios');
    }
    res.render('domains/form', { title: 'Editar dominio', item: rows[0], errors: [] });
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
    await pool.query(`UPDATE domains SET ${setClause} WHERE id = ?`, [...values, req.params.id]);
    req.flash('success', 'Dominio actualizado correctamente.');
    res.redirect('/dominios');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/eliminar', canWrite, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM domains WHERE id = ?', [req.params.id]);
    req.flash('success', 'Dominio eliminado.');
    res.redirect('/dominios');
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM domains WHERE id = ?', [req.params.id]);
    if (!rows[0]) {
      req.flash('error', 'Dominio no encontrado.');
      return res.redirect('/dominios');
    }
    const [attachments] = await pool.query(
      'SELECT * FROM attachments WHERE entity_type = "domain" AND entity_id = ? ORDER BY uploaded_at DESC',
      [req.params.id]
    );
    const days = daysUntil(rows[0].expiration_date);
    res.render('domains/detail', {
      title: rows[0].domain_name,
      item: { ...rows[0], days_left: days, computed_status: statusFromDays(days) },
      attachments,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
