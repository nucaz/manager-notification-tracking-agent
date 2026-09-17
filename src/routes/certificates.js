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
router.use(requireAuth, moduleRequired('certificados'));

const FIELDS = [
  'common_name', 'certificate_type', 'issuer', 'domain_id', 'issue_date', 'expiration_date',
  'auto_renew', 'cost', 'currency', 'responsible', 'site_location', 'notes',
];

// domain_id no se importa por lote (requeriria resolver el nombre del
// dominio a un id) - se puede vincular despues editando el registro.
const IMPORT_COLUMNS = [
  { header: 'Nombre común', field: 'common_name', required: true },
  { header: 'Tipo de certificado', field: 'certificate_type' },
  { header: 'Entidad certificadora', field: 'issuer' },
  { header: 'Fecha de emisión', field: 'issue_date', type: 'date' },
  { header: 'Fecha de vencimiento', field: 'expiration_date', type: 'date' },
  { header: 'Renovación automática', field: 'auto_renew', type: 'bool' },
  { header: 'Costo', field: 'cost', type: 'number' },
  { header: 'Moneda', field: 'currency' },
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

router.post('/nuevo', canWrite, verifyCsrfToken, async (req, res, next) => {
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

router.post('/:id/editar', canWrite, verifyCsrfToken, async (req, res, next) => {
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

router.post('/:id/eliminar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM certificates WHERE id = ?', [req.params.id]);
    req.flash('success', 'Certificado eliminado.');
    res.redirect('/certificados');
  } catch (err) {
    next(err);
  }
});

// Nota: /importar y /importar/plantilla van antes de /:id a proposito
// (ver src/routes/attachments.js) para que Express no confunda "importar"
// con un id.
router.get('/importar', canWrite, (req, res) => {
  res.render('import', {
    title: 'Importar certificados TLS',
    listUrl: '/certificados',
    actionUrl: '/certificados/importar',
    templateUrl: '/certificados/importar/plantilla',
    columns: IMPORT_COLUMNS,
    results: null,
  });
});

router.get('/importar/plantilla', canWrite, async (req, res, next) => {
  try {
    const buffer = await importService.buildTemplateBuffer(IMPORT_COLUMNS);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_certificados.xlsx"');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.post('/importar', canWrite, importUploader.single('file'), verifyCsrfToken, async (req, res, next) => {
  try {
    if (!req.file) {
      req.flash('error', 'Debes seleccionar un archivo.');
      return res.redirect('/certificados/importar');
    }
    const rows = await importService.parseSpreadsheet(req.file.buffer, req.file.originalname);
    const results = await importService.importRows(rows, IMPORT_COLUMNS, {
      table: 'certificates',
      userId: req.session.user.id,
    });
    res.render('import', {
      title: 'Importar certificados TLS',
      listUrl: '/certificados',
      actionUrl: '/certificados/importar',
      templateUrl: '/certificados/importar/plantilla',
      columns: IMPORT_COLUMNS,
      results,
    });
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
    const exchangeRate = rows[0].currency === 'USD' ? await exchangeRateService.getUsdPenRate() : null;
    res.render('certificates/detail', {
      title: rows[0].common_name,
      item: { ...rows[0], days_left: days, computed_status: statusFromDays(days) },
      attachments,
      exchangeRate,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
