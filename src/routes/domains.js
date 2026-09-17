const express = require('express');
const pool = require('../db/pool');
const { requireAuth, canWrite } = require('../middleware/auth');
const { moduleRequired } = require('../middleware/modules');
const { verifyCsrfToken } = require('../middleware/csrf');
const { daysUntil, statusFromDays } = require('../services/expirationService');
const exchangeRateService = require('../services/exchangeRateService');
const importService = require('../services/importService');
const { importUploader } = require('../services/uploadService');

const router = express.Router();
// verifyCsrfToken NO va aca a nivel de router: /importar es multipart y
// necesita que multer parsee el body antes de verificar el token (ver
// src/routes/attachments.js). Se aplica explicito en cada ruta POST.
router.use(requireAuth, moduleRequired('dominios'));

const FIELDS = [
  'domain_name', 'registrar', 'dns_provider', 'registration_date', 'expiration_date',
  'renewal_cost', 'currency', 'auto_renew', 'responsible', 'site_location', 'notes',
];

const IMPORT_COLUMNS = [
  { header: 'Nombre de dominio', field: 'domain_name', required: true },
  { header: 'Registrador', field: 'registrar' },
  { header: 'Proveedor DNS', field: 'dns_provider' },
  { header: 'Fecha de registro', field: 'registration_date', type: 'date' },
  { header: 'Fecha de vencimiento', field: 'expiration_date', type: 'date' },
  { header: 'Costo de renovación', field: 'renewal_cost', type: 'number' },
  { header: 'Moneda', field: 'currency' },
  { header: 'Renovación automática', field: 'auto_renew', type: 'bool' },
  { header: 'Responsable', field: 'responsible' },
  { header: 'Local / sede', field: 'site_location' },
  { header: 'Notas', field: 'notes' },
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

router.post('/nuevo', canWrite, verifyCsrfToken, async (req, res, next) => {
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

router.post('/:id/editar', canWrite, verifyCsrfToken, async (req, res, next) => {
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

router.post('/:id/eliminar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM domains WHERE id = ?', [req.params.id]);
    req.flash('success', 'Dominio eliminado.');
    res.redirect('/dominios');
  } catch (err) {
    next(err);
  }
});

// Nota: /importar y /importar/plantilla van antes de /:id a proposito
// (ver src/routes/attachments.js) para que Express no confunda "importar"
// con un id.
router.get('/importar', canWrite, (req, res) => {
  res.render('import', {
    title: 'Importar dominios',
    listUrl: '/dominios',
    actionUrl: '/dominios/importar',
    templateUrl: '/dominios/importar/plantilla',
    columns: IMPORT_COLUMNS,
    results: null,
  });
});

router.get('/importar/plantilla', canWrite, async (req, res, next) => {
  try {
    const buffer = await importService.buildTemplateBuffer(IMPORT_COLUMNS);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_dominios.xlsx"');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.post('/importar', canWrite, importUploader.single('file'), verifyCsrfToken, async (req, res, next) => {
  try {
    if (!req.file) {
      req.flash('error', 'Debes seleccionar un archivo.');
      return res.redirect('/dominios/importar');
    }
    const rows = await importService.parseSpreadsheet(req.file.buffer, req.file.originalname);
    const results = await importService.importRows(rows, IMPORT_COLUMNS, {
      table: 'domains',
      userId: req.session.user.id,
    });
    res.render('import', {
      title: 'Importar dominios',
      listUrl: '/dominios',
      actionUrl: '/dominios/importar',
      templateUrl: '/dominios/importar/plantilla',
      columns: IMPORT_COLUMNS,
      results,
    });
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
    const exchangeRate = rows[0].currency === 'USD' ? await exchangeRateService.getUsdPenRate() : null;
    res.render('domains/detail', {
      title: rows[0].domain_name,
      item: { ...rows[0], days_left: days, computed_status: statusFromDays(days) },
      attachments,
      exchangeRate,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
