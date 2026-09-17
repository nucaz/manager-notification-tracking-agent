const express = require('express');
const path = require('path');
const fs = require('fs');
const pool = require('../db/pool');
const { requireAuth, canWrite } = require('../middleware/auth');
const { moduleRequired } = require('../middleware/modules');
const { verifyCsrfToken } = require('../middleware/csrf');
const { uploader, DIRS } = require('../services/uploadService');

const router = express.Router();
router.use(requireAuth, moduleRequired('red'));

const CATEGORIES = [
  { value: 'arquitectura_web', label: 'Arquitectura web' },
  { value: 'infraestructura_ti', label: 'Infraestructura TI' },
  { value: 'datacenter', label: 'Datacenter' },
  { value: 'networking', label: 'Networking' },
  { value: 'azure', label: 'Microsoft Azure' },
  { value: 'aws', label: 'Amazon AWS' },
  { value: 'vps_hosting', label: 'VPS / Hosting' },
  { value: 'housing', label: 'Housing' },
  { value: 'otro', label: 'Otro' },
];

const upload = uploader('red');

router.get('/', async (req, res, next) => {
  try {
    const { category } = req.query;
    let sql =
      'SELECT nd.*, u.full_name AS uploaded_by_name FROM network_diagrams nd ' +
      'LEFT JOIN users u ON u.id = nd.uploaded_by WHERE 1=1';
    const params = [];
    if (category) {
      sql += ' AND nd.category = ?';
      params.push(category);
    }
    sql += ' ORDER BY nd.uploaded_at DESC';
    const [rows] = await pool.query(sql, params);
    res.render('network/list', {
      title: 'Red — Topologías y arquitecturas',
      items: rows,
      categories: CATEGORIES,
      category: category || '',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/nuevo', canWrite, (req, res) => {
  res.render('network/form', { title: 'Nuevo diagrama', categories: CATEGORIES, errors: [] });
});

router.post('/nuevo', canWrite, upload.single('file'), verifyCsrfToken, async (req, res, next) => {
  try {
    if (!req.file) {
      req.flash('error', 'Debes seleccionar un archivo.');
      return res.redirect('/red/nuevo');
    }
    const { category, title, description } = req.body;
    await pool.query(
      `INSERT INTO network_diagrams
        (category, title, description, original_name, stored_path, mime_type, size_bytes, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        category,
        title,
        description || null,
        req.file.originalname,
        req.file.filename,
        req.file.mimetype,
        req.file.size,
        req.session.user.id,
      ]
    );
    req.flash('success', 'Diagrama subido correctamente.');
    res.redirect('/red');
  } catch (err) {
    next(err);
  }
});

// Nueva version de un diagrama existente (mantiene historial)
router.post('/:id/nueva-version', canWrite, upload.single('file'), verifyCsrfToken, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM network_diagrams WHERE id = ?', [req.params.id]);
    const previous = rows[0];
    if (!previous) {
      req.flash('error', 'Diagrama no encontrado.');
      return res.redirect('/red');
    }
    if (!req.file) {
      req.flash('error', 'Debes seleccionar un archivo.');
      return res.redirect('/red');
    }
    await pool.query(
      `INSERT INTO network_diagrams
        (category, title, description, original_name, stored_path, mime_type, size_bytes, version, replaces_id, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        previous.category,
        previous.title,
        req.body.description || previous.description,
        req.file.originalname,
        req.file.filename,
        req.file.mimetype,
        req.file.size,
        previous.version + 1,
        previous.id,
        req.session.user.id,
      ]
    );
    req.flash('success', 'Nueva version del diagrama subida correctamente.');
    res.redirect('/red');
  } catch (err) {
    next(err);
  }
});

router.get('/descargar/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM network_diagrams WHERE id = ?', [req.params.id]);
    const diagram = rows[0];
    if (!diagram) {
      req.flash('error', 'Diagrama no encontrado.');
      return res.redirect('/red');
    }
    const filePath = path.join(DIRS.red, diagram.stored_path);
    if (!fs.existsSync(filePath)) {
      req.flash('error', 'El archivo ya no existe en el servidor.');
      return res.redirect('/red');
    }
    res.download(filePath, diagram.original_name);
  } catch (err) {
    next(err);
  }
});

router.post('/eliminar/:id', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM network_diagrams WHERE id = ?', [req.params.id]);
    const diagram = rows[0];
    if (!diagram) {
      req.flash('error', 'Diagrama no encontrado.');
      return res.redirect('/red');
    }
    const filePath = path.join(DIRS.red, diagram.stored_path);
    await pool.query('DELETE FROM network_diagrams WHERE id = ?', [req.params.id]);
    fs.promises.unlink(filePath).catch(() => {});
    req.flash('success', 'Diagrama eliminado.');
    res.redirect('/red');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
