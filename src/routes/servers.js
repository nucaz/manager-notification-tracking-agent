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
  'name', 'asset_type', 'environment', 'criticality', 'ip_address', 'operating_system',
  'provider', 'responsible', 'site_location', 'purchase_date', 'support_expiration_date',
  'cost', 'currency', 'status', 'dependencies', 'glpi_computer_id', 'notes',
];

const IMPORT_COLUMNS = [
  { header: 'Nombre / hostname', field: 'name', required: true },
  { header: 'Tipo de activo', field: 'asset_type' },
  { header: 'Ambiente', field: 'environment' },
  { header: 'Criticidad', field: 'criticality' },
  { header: 'Dirección IP', field: 'ip_address' },
  { header: 'Sistema operativo', field: 'operating_system' },
  { header: 'Proveedor / fabricante', field: 'provider' },
  { header: 'Responsable', field: 'responsible' },
  { header: 'Local / sede / datacenter', field: 'site_location' },
  { header: 'Fecha de compra', field: 'purchase_date', type: 'date' },
  { header: 'Vencimiento de soporte/garantía', field: 'support_expiration_date', type: 'date' },
  { header: 'Costo', field: 'cost', type: 'number' },
  { header: 'Moneda', field: 'currency' },
  { header: 'Estado operativo', field: 'status' },
  { header: 'Dependencias', field: 'dependencies' },
  { header: 'Notas', field: 'notes' },
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

router.post('/nuevo', canWrite, verifyCsrfToken, async (req, res, next) => {
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

router.post('/:id/editar', canWrite, verifyCsrfToken, async (req, res, next) => {
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

router.post('/:id/eliminar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM servers WHERE id = ?', [req.params.id]);
    req.flash('success', 'Activo eliminado.');
    res.redirect('/servidores');
  } catch (err) {
    next(err);
  }
});

// Nota: /importar y /importar/plantilla van antes de /:id a proposito
// (ver src/routes/attachments.js) para que Express no confunda "importar"
// con un id.
router.get('/importar', canWrite, (req, res) => {
  res.render('import', {
    title: 'Importar servidores y activos TI',
    listUrl: '/servidores',
    actionUrl: '/servidores/importar',
    templateUrl: '/servidores/importar/plantilla',
    columns: IMPORT_COLUMNS,
    results: null,
  });
});

router.get('/importar/plantilla', canWrite, async (req, res, next) => {
  try {
    const buffer = await importService.buildTemplateBuffer(IMPORT_COLUMNS);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_servidores.xlsx"');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.post('/importar', canWrite, importUploader.single('file'), verifyCsrfToken, async (req, res, next) => {
  try {
    if (!req.file) {
      req.flash('error', 'Debes seleccionar un archivo.');
      return res.redirect('/servidores/importar');
    }
    const rows = await importService.parseSpreadsheet(req.file.buffer, req.file.originalname);
    const results = await importService.importRows(rows, IMPORT_COLUMNS, {
      table: 'servers',
      userId: req.session.user.id,
    });
    res.render('import', {
      title: 'Importar servidores y activos TI',
      listUrl: '/servidores',
      actionUrl: '/servidores/importar',
      templateUrl: '/servidores/importar/plantilla',
      columns: IMPORT_COLUMNS,
      results,
    });
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
    const exchangeRate = rows[0].currency === 'USD' ? await exchangeRateService.getUsdPenRate() : null;
    res.render('servers/detail', {
      title: rows[0].name,
      item: { ...rows[0], days_left: days, computed_status: statusFromDays(days) },
      attachments,
      exchangeRate,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
