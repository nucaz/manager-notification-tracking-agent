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
router.use(requireAuth, moduleRequired('isp'));

const FIELDS = [
  'provider', 'contract_number', 'service_type', 'bandwidth_down', 'bandwidth_up',
  'monthly_cost', 'currency', 'start_date', 'end_date', 'auto_renew', 'sla_notes',
  'contact_name', 'contact_phone', 'contact_email', 'site_location', 'notes',
];

const IMPORT_COLUMNS = [
  { header: 'Proveedor (ISP)', field: 'provider', required: true },
  { header: 'N° de contrato', field: 'contract_number' },
  { header: 'Tipo de servicio', field: 'service_type' },
  { header: 'Ancho de banda bajada', field: 'bandwidth_down' },
  { header: 'Ancho de banda subida', field: 'bandwidth_up' },
  { header: 'Costo mensual', field: 'monthly_cost', type: 'number' },
  { header: 'Moneda', field: 'currency' },
  { header: 'Fecha de inicio', field: 'start_date', type: 'date' },
  { header: 'Fecha de vencimiento', field: 'end_date', type: 'date' },
  { header: 'Renovación automática', field: 'auto_renew', type: 'bool' },
  { header: 'Notas de SLA', field: 'sla_notes' },
  { header: 'Contacto (nombre)', field: 'contact_name' },
  { header: 'Contacto (teléfono)', field: 'contact_phone' },
  { header: 'Contacto (correo)', field: 'contact_email' },
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

router.post('/nuevo', canWrite, verifyCsrfToken, async (req, res, next) => {
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

router.post('/:id/editar', canWrite, verifyCsrfToken, async (req, res, next) => {
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

router.post('/:id/eliminar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM isp_contracts WHERE id = ?', [req.params.id]);
    req.flash('success', 'Contrato ISP eliminado.');
    res.redirect('/isp');
  } catch (err) {
    next(err);
  }
});

// Nota: /importar y /importar/plantilla van antes de /:id a proposito
// (ver src/routes/attachments.js) para que Express no confunda "importar"
// con un id.
router.get('/importar', canWrite, (req, res) => {
  res.render('import', {
    title: 'Importar contratos ISP',
    listUrl: '/isp',
    actionUrl: '/isp/importar',
    templateUrl: '/isp/importar/plantilla',
    columns: IMPORT_COLUMNS,
    results: null,
  });
});

router.get('/importar/plantilla', canWrite, async (req, res, next) => {
  try {
    const buffer = await importService.buildTemplateBuffer(IMPORT_COLUMNS);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_isp.xlsx"');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.post('/importar', canWrite, importUploader.single('file'), verifyCsrfToken, async (req, res, next) => {
  try {
    if (!req.file) {
      req.flash('error', 'Debes seleccionar un archivo.');
      return res.redirect('/isp/importar');
    }
    const rows = await importService.parseSpreadsheet(req.file.buffer, req.file.originalname);
    const results = await importService.importRows(rows, IMPORT_COLUMNS, {
      table: 'isp_contracts',
      userId: req.session.user.id,
    });
    res.render('import', {
      title: 'Importar contratos ISP',
      listUrl: '/isp',
      actionUrl: '/isp/importar',
      templateUrl: '/isp/importar/plantilla',
      columns: IMPORT_COLUMNS,
      results,
    });
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
    const exchangeRate = rows[0].currency === 'USD' ? await exchangeRateService.getUsdPenRate() : null;
    res.render('isp/detail', {
      title: rows[0].provider,
      item: { ...rows[0], days_left: days, computed_status: statusFromDays(days) },
      attachments,
      exchangeRate,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
