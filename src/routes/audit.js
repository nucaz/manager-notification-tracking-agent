const express = require('express');
const pool = require('../db/pool');
const { requireAuth, isAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, isAdmin);

router.get('/', async (req, res, next) => {
  try {
    const { action, email, desde, hasta } = req.query;
    let sql = 'SELECT * FROM audit_log WHERE 1=1';
    const params = [];
    if (action) {
      sql += ' AND action = ?';
      params.push(action);
    }
    if (email) {
      sql += ' AND user_email LIKE ?';
      params.push(`%${email}%`);
    }
    if (desde) {
      sql += ' AND created_at >= ?';
      params.push(`${desde} 00:00:00`);
    }
    if (hasta) {
      sql += ' AND created_at <= ?';
      params.push(`${hasta} 23:59:59`);
    }
    sql += ' ORDER BY created_at DESC LIMIT 300';
    const [rows] = await pool.query(sql, params);
    const [actionRows] = await pool.query('SELECT DISTINCT action FROM audit_log ORDER BY action');

    res.render('audit/list', {
      title: 'Auditoría',
      items: rows,
      actions: actionRows.map((r) => r.action),
      action: action || '',
      email: email || '',
      desde: desde || '',
      hasta: hasta || '',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
