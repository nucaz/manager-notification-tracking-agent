const express = require('express');
const pool = require('../db/pool');
const { requireAuth, canWrite } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const { daysUntil, statusFromDays } = require('../services/expirationService');
const exchangeRateService = require('../services/exchangeRateService');
const importService = require('../services/importService');
const { importUploader } = require('../services/uploadService');

const router = express.Router();
// verifyCsrfToken NO va aca a nivel de router: /importar es multipart y
// necesita que multer parsee el body antes de verificar el token (ver
// src/routes/attachments.js). Se aplica explicito en cada ruta POST.
router.use(requireAuth);

const FIELDS = [
  'product_name', 'vendor', 'license_type', 'license_key', 'seats', 'assigned_to',
  'cost', 'currency', 'purchase_date', 'start_date', 'expiration_date', 'auto_renew',
  'site_location', 'glpi_entity_id', 'glpi_computer_id', 'notes',
];

const IMPORT_COLUMNS = [
  { header: 'Producto', field: 'product_name', required: true },
  { header: 'Proveedor', field: 'vendor' },
  { header: 'Tipo de licencia', field: 'license_type' },
  { header: 'Clave de licencia', field: 'license_key' },
  { header: 'Asientos', field: 'seats', type: 'number' },
  { header: 'Asignado a', field: 'assigned_to' },
  { header: 'Costo', field: 'cost', type: 'number' },
  { header: 'Moneda', field: 'currency' },
  { header: 'Fecha de compra', field: 'purchase_date', type: 'date' },
  { header: 'Fecha de inicio', field: 'start_date', type: 'date' },
  { header: 'Fecha de vencimiento', field: 'expiration_date', type: 'date' },
  { header: 'Renovación automática', field: 'auto_renew', type: 'bool' },
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

// Listado con filtros
router.get('/', async (req, res, next) => {
  try {
    const { q, status } = req.query;
    let sql = 'SELECT * FROM software_licenses WHERE 1=1';
    const params = [];
    if (q) {
      sql += ' AND (product_name LIKE ? OR vendor LIKE ? OR assigned_to LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += ' ORDER BY expiration_date IS NULL, expiration_date ASC';
    const [rows] = await pool.query(sql, params);

    const enriched = rows.map((r) => {
      const days = daysUntil(r.expiration_date);
      return { ...r, days_left: days, computed_status: statusFromDays(days) };
    });
    const filtered = status ? enriched.filter((r) => r.computed_status === status) : enriched;

    res.render('licenses/list', {
      title: 'Licencias de software',
      items: filtered,
      q: q || '',
      status: status || '',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/nuevo', canWrite, (req, res) => {
  res.render('licenses/form', { title: 'Nueva licencia', item: {}, errors: [] });
});

router.post('/nuevo', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const data = readForm(req.body);
    if (!data.product_name) {
      req.flash('error', 'El nombre del producto es obligatorio.');
      return res.redirect('/licencias/nuevo');
    }
    const cols = Object.keys(data);
    const values = Object.values(data);
    const placeholders = cols.map(() => '?').join(', ');
    await pool.query(
      `INSERT INTO software_licenses (${cols.join(', ')}, created_by) VALUES (${placeholders}, ?)`,
      [...values, req.session.user.id]
    );
    req.flash('success', 'Licencia registrada correctamente.');
    res.redirect('/licencias');
  } catch (err) {
    next(err);
  }
});

router.get('/:id/editar', canWrite, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM software_licenses WHERE id = ?', [req.params.id]);
    if (!rows[0]) {
      req.flash('error', 'Licencia no encontrada.');
      return res.redirect('/licencias');
    }
    res.render('licenses/form', { title: 'Editar licencia', item: rows[0], errors: [] });
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
    await pool.query(`UPDATE software_licenses SET ${setClause} WHERE id = ?`, [
      ...values,
      req.params.id,
    ]);
    req.flash('success', 'Licencia actualizada correctamente.');
    res.redirect('/licencias');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/eliminar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM software_licenses WHERE id = ?', [req.params.id]);
    req.flash('success', 'Licencia eliminada.');
    res.redirect('/licencias');
  } catch (err) {
    next(err);
  }
});

// Nota: /importar y /importar/plantilla van antes de /:id a proposito
// (ver src/routes/attachments.js) para que Express no confunda "importar"
// con un id.
router.get('/importar', canWrite, (req, res) => {
  res.render('import', {
    title: 'Importar licencias',
    listUrl: '/licencias',
    actionUrl: '/licencias/importar',
    templateUrl: '/licencias/importar/plantilla',
    columns: IMPORT_COLUMNS,
    results: null,
  });
});

router.get('/importar/plantilla', canWrite, async (req, res, next) => {
  try {
    const buffer = await importService.buildTemplateBuffer(IMPORT_COLUMNS);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_licencias.xlsx"');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.post('/importar', canWrite, importUploader.single('file'), verifyCsrfToken, async (req, res, next) => {
  try {
    if (!req.file) {
      req.flash('error', 'Debes seleccionar un archivo.');
      return res.redirect('/licencias/importar');
    }
    const rows = await importService.parseSpreadsheet(req.file.buffer, req.file.originalname);
    const results = await importService.importRows(rows, IMPORT_COLUMNS, {
      table: 'software_licenses',
      userId: req.session.user.id,
    });
    res.render('import', {
      title: 'Importar licencias',
      listUrl: '/licencias',
      actionUrl: '/licencias/importar',
      templateUrl: '/licencias/importar/plantilla',
      columns: IMPORT_COLUMNS,
      results,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM software_licenses WHERE id = ?', [req.params.id]);
    if (!rows[0]) {
      req.flash('error', 'Licencia no encontrada.');
      return res.redirect('/licencias');
    }
    const [attachments] = await pool.query(
      'SELECT * FROM attachments WHERE entity_type = "license" AND entity_id = ? ORDER BY uploaded_at DESC',
      [req.params.id]
    );
    const days = daysUntil(rows[0].expiration_date);
    const exchangeRate = rows[0].currency === 'USD' ? await exchangeRateService.getUsdPenRate() : null;
    res.render('licenses/detail', {
      title: rows[0].product_name,
      item: { ...rows[0], days_left: days, computed_status: statusFromDays(days) },
      attachments,
      exchangeRate,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
