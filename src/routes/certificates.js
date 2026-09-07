const express = require('express');
const pool = require('../db/pool');
const { requireAuth, canWrite } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const { daysUntil, statusFromDays } = require('../services/expirationService');

const router = express.Router();
router.use(requireAuth, verifyCsrfToken);

const FIELDS = [
  'common_name', 'certificate_type', 'issuer', 'domain_id', 'issue_date', 'expiration_date',
  'auto_renew', 'cost', 'currency', 'responsible', 'site_location', 'notes',
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

async function loadDomainOptions() {
  const [rows] = await pool.query('SELECT id, domain_name FROM domains ORDER BY domain_name');
  return rows;
}

router.get('/', async (req, res, next) => {
  try {
    const { q, status } = req.query;
    let sql = 'SELECT * FROM certificates WHERE 1=1';
    const params = [];
    if (q) {
      sql += ' AND (common_name LIKE ? OR issuer LIKE ? OR responsible LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += ' ORDER BY expiration_date IS NULL, expiration_date ASC';
    const [rows] = await pool.query(sql, params);
    const enriched = rows.map((r) => {
      const days = daysUntil(r.expiration_date);
      return { ...r, days_left: days, computed_status: statusFromDays(days) };
    });
    const filtered = status ? enriched.filter((r) => r.computed_status === status) : enriched;
    res.render('certificates/list', { title: 'Certificados TLS', items: filtered, q: q || '', status: status || '' });
  } catch (err) {
    next(err);
  }
});

router.get('/nuevo', canWrite, async (req, res, next) => {
  try {
    const domains = await loadDomainOptions();
    res.render('certificates/form', { title: 'Nuevo certificado', item: {}, domains, errors: [] });
  } catch (err) {
    next(err);
  }
});

router.post('/nuevo', canWrite, async (req, res, next) => {
  try {
    const data = readForm(req.body);
    if (!data.common_name) {
      req.flash('error', 'El nombre común (dominio cubierto) es obligatorio.');
      return res.redirect('/certificados/nuevo');
    }
    const cols = Object.keys(data);
    const values = Object.values(data);
    const placeholders = cols.map(() => '?').join(', ');
    await pool.query(
      `INSERT INTO certificates (${cols.join(', ')}, created_by) VALUES (${placeholders}, ?)`,
      [...values, req.session.user.id]
    );
    req.flash('success', 'Certificado registrado correctamente.');
    res.redirect('/certificados');
  } catch (err) {
    next(err);
  }
});

router.get('/:id/editar', canWrite, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM certificates WHERE id = ?', [req.params.id]);
    if (!rows[0]) {
      req.flash('error', 'Certificado no encontrado.');
      return res.redirect('/certificados');
    }
    const domains = await loadDomainOptions();
    res.render('certificates/form', { title: 'Editar certificado', item: rows[0], domains, errors: [] });
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
    await pool.query(`UPDATE certificates SET ${setClause} WHERE id = ?`, [...values, req.params.id]);
    req.flash('success', 'Certificado actualizado correctamente.');
    res.redirect('/certificados');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/eliminar', canWrite, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM certificates WHERE id = ?', [req.params.id]);
    req.flash('success', 'Certificado eliminado.');
    res.redirect('/certificados');
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT c.*, d.domain_name FROM certificates c LEFT JOIN domains d ON d.id = c.domain_id WHERE c.id = ?',
      [req.params.id]
    );
    if (!rows[0]) {
      req.flash('error', 'Certificado no encontrado.');
      return res.redirect('/certificados');
    }
    const [attachments] = await pool.query(
      'SELECT * FROM attachments WHERE entity_type = "certificate" AND entity_id = ? ORDER BY uploaded_at DESC',
      [req.params.id]
    );
    const days = daysUntil(rows[0].expiration_date);
    res.render('certificates/detail', {
      title: rows[0].common_name,
      item: { ...rows[0], days_left: days, computed_status: statusFromDays(days) },
      attachments,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
