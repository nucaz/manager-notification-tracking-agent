const express = require('express');
const pool = require('../db/pool');
const { requireAuth, canWrite } = require('../middleware/auth');
const { daysUntil, statusFromDays } = require('../services/expirationService');

const router = express.Router();
router.use(requireAuth);

const FIELDS = [
  'provider', 'contract_number', 'service_type', 'bandwidth_down', 'bandwidth_up',
  'monthly_cost', 'currency', 'start_date', 'end_date', 'auto_renew', 'sla_notes',
  'contact_name', 'contact_phone', 'contact_email', 'site_location', 'notes',
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
    let sql = 'SELECT * FROM isp_contracts WHERE 1=1';
    const params = [];
    if (q) {
      sql += ' AND (provider LIKE ? OR contract_number LIKE ? OR service_type LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += ' ORDER BY end_date IS NULL, end_date ASC';
    const [rows] = await pool.query(sql, params);
    const enriched = rows.map((r) => {
      const days = daysUntil(r.end_date);
      return { ...r, days_left: days, computed_status: statusFromDays(days) };
    });
    const filtered = status ? enriched.filter((r) => r.computed_status === status) : enriched;
    res.render('isp/list', { title: 'Contratos ISP', items: filtered, q: q || '', status: status || '' });
  } catch (err) {
    next(err);
  }
});

router.get('/nuevo', canWrite, (req, res) => {
  res.render('isp/form', { title: 'Nuevo contrato ISP', item: {}, errors: [] });
});

router.post('/nuevo', canWrite, async (req, res, next) => {
  try {
    const data = readForm(req.body);
    if (!data.provider) {
      req.flash('error', 'El proveedor es obligatorio.');
      return res.redirect('/isp/nuevo');
    }
    const cols = Object.keys(data);
    const values = Object.values(data);
    const placeholders = cols.map(() => '?').join(', ');
    await pool.query(
      `INSERT INTO isp_contracts (${cols.join(', ')}, created_by) VALUES (${placeholders}, ?)`,
      [...values, req.session.user.id]
    );
    req.flash('success', 'Contrato ISP registrado correctamente.');
    res.redirect('/isp');
  } catch (err) {
    next(err);
  }
});

router.get('/:id/editar', canWrite, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM isp_contracts WHERE id = ?', [req.params.id]);
    if (!rows[0]) {
      req.flash('error', 'Contrato no encontrado.');
      return res.redirect('/isp');
    }
    res.render('isp/form', { title: 'Editar contrato ISP', item: rows[0], errors: [] });
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
    await pool.query(`UPDATE isp_contracts SET ${setClause} WHERE id = ?`, [...values, req.params.id]);
    req.flash('success', 'Contrato ISP actualizado correctamente.');
    res.redirect('/isp');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/eliminar', canWrite, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM isp_contracts WHERE id = ?', [req.params.id]);
    req.flash('success', 'Contrato ISP eliminado.');
    res.redirect('/isp');
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM isp_contracts WHERE id = ?', [req.params.id]);
    if (!rows[0]) {
      req.flash('error', 'Contrato no encontrado.');
      return res.redirect('/isp');
    }
    const [attachments] = await pool.query(
      'SELECT * FROM attachments WHERE entity_type = "isp_contract" AND entity_id = ? ORDER BY uploaded_at DESC',
      [req.params.id]
    );
    const days = daysUntil(rows[0].end_date);
    res.render('isp/detail', {
      title: rows[0].provider,
      item: { ...rows[0], days_left: days, computed_status: statusFromDays(days) },
      attachments,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
