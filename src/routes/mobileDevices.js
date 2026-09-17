const express = require('express');
const pool = require('../db/pool');
const { requireAuth, canWrite } = require('../middleware/auth');
const { moduleRequired } = require('../middleware/modules');
const { verifyCsrfToken } = require('../middleware/csrf');
const importService = require('../services/importService');
const { importUploader } = require('../services/uploadService');
const catalogService = require('../services/catalogService');
const employeeService = require('../services/employeeService');

const router = express.Router();
// verifyCsrfToken NO va aca a nivel de router: /importar es multipart y
// necesita que multer parsee el body antes de verificar el token (ver
// src/routes/attachments.js). Se aplica explicito en cada ruta POST.
router.use(requireAuth, moduleRequired('celulares'));

const FIELDS = [
  'imei', 'phone_number', 'has_chip', 'asset_code', 'brand', 'model',
  'area', 'sede', 'status', 'notes',
];

async function loadCatalogOptions() {
  const [sedes, areas, marcas, modelos] = await Promise.all([
    catalogService.getActive('sede'),
    catalogService.getActive('area'),
    catalogService.getActive('marca'),
    catalogService.getActive('modelo'),
  ]);
  return { sedes, areas, marcas, modelos };
}

const IMPORT_COLUMNS = [
  { header: 'IMEI', field: 'imei', required: true },
  { header: 'Número', field: 'phone_number' },
  { header: 'Tiene chip', field: 'has_chip', type: 'bool' },
  { header: 'Código', field: 'asset_code' },
  { header: 'Marca', field: 'brand' },
  { header: 'Modelo', field: 'model' },
  { header: 'Área', field: 'area', required: true },
  { header: 'Sede', field: 'sede' },
  { header: 'Usuario asignado', field: 'holder_name' },
  { header: 'Cargo', field: 'cargo' },
  { header: 'Turno', field: 'turno' },
  { header: 'Fecha de entrega', field: 'assigned_date', type: 'date' },
  { header: 'Observación', field: 'observacion' },
];

function readForm(body) {
  const out = {};
  for (const f of FIELDS) {
    let v = body[f];
    if (v === '') v = null;
    if (f === 'has_chip') v = v ? 1 : 0;
    out[f] = v;
  }
  return out;
}

router.get('/', async (req, res, next) => {
  try {
    const { q, area, sede, status } = req.query;
    let sql = `
      SELECT d.*, a.holder_name, a.cargo, a.turno, a.assigned_date
      FROM mobile_devices d
      LEFT JOIN mobile_device_assignments a ON a.device_id = d.id AND a.returned_date IS NULL
      WHERE 1=1`;
    const params = [];
    if (q) {
      sql += ' AND (d.imei LIKE ? OR d.asset_code LIKE ? OR d.phone_number LIKE ? OR a.holder_name LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (area) {
      sql += ' AND d.area = ?';
      params.push(area);
    }
    if (sede) {
      sql += ' AND d.sede = ?';
      params.push(sede);
    }
    if (status) {
      sql += ' AND d.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY d.area, d.id';
    const [rows] = await pool.query(sql, params);
    const [areaRows] = await pool.query('SELECT DISTINCT area FROM mobile_devices ORDER BY area');
    const [sedeRows] = await pool.query(
      'SELECT DISTINCT sede FROM mobile_devices WHERE sede IS NOT NULL AND sede <> "" ORDER BY sede'
    );
    res.render('mobileDevices/list', {
      title: 'Celulares',
      items: rows,
      areas: areaRows.map((r) => r.area),
      sedes: sedeRows.map((r) => r.sede),
      q: q || '',
      area: area || '',
      sede: sede || '',
      status: status || '',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/nuevo', canWrite, async (req, res, next) => {
  try {
    const catalogs = await loadCatalogOptions();
    res.render('mobileDevices/form', { title: 'Nuevo celular', item: {}, errors: [], ...catalogs });
  } catch (err) {
    next(err);
  }
});

router.post('/nuevo', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const data = readForm(req.body);
    if (!data.imei || !data.area) {
      req.flash('error', 'El IMEI y el área son obligatorios.');
      return res.redirect('/celulares/nuevo');
    }
    const cols = Object.keys(data);
    const values = Object.values(data);
    const placeholders = cols.map(() => '?').join(', ');
    await pool.query(
      `INSERT INTO mobile_devices (${cols.join(', ')}, created_by) VALUES (${placeholders}, ?)`,
      [...values, req.session.user.id]
    );
    req.flash('success', 'Celular registrado correctamente.');
    res.redirect('/celulares');
  } catch (err) {
    next(err);
  }
});

router.get('/:id/editar', canWrite, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM mobile_devices WHERE id = ?', [req.params.id]);
    if (!rows[0]) {
      req.flash('error', 'Celular no encontrado.');
      return res.redirect('/celulares');
    }
    const catalogs = await loadCatalogOptions();
    res.render('mobileDevices/form', { title: 'Editar celular', item: rows[0], errors: [], ...catalogs });
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
    await pool.query(`UPDATE mobile_devices SET ${setClause} WHERE id = ?`, [...values, req.params.id]);
    req.flash('success', 'Celular actualizado correctamente.');
    res.redirect('/celulares');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/eliminar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM mobile_devices WHERE id = ?', [req.params.id]);
    req.flash('success', 'Celular eliminado.');
    res.redirect('/celulares');
  } catch (err) {
    next(err);
  }
});

router.post('/eliminar-multiple', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const ids = [].concat(req.body.ids || []).map((id) => parseInt(id, 10)).filter(Number.isInteger);
    if (ids.length === 0) {
      req.flash('error', 'No seleccionaste ningún celular para eliminar.');
      return res.redirect('/celulares');
    }
    const [result] = await pool.query('DELETE FROM mobile_devices WHERE id IN (?)', [ids]);
    req.flash('success', `${result.affectedRows} celular(es) eliminado(s).`);
    res.redirect('/celulares');
  } catch (err) {
    next(err);
  }
});

// Asigna (o reasigna, si ya habia una asignacion activa) el celular a una
// persona. La persona se identifica por DNI: si ya existe en el
// directorio de empleados se actualiza (por si cambio de area/sede/cargo),
// si no existe se crea. El area/sede del equipo se actualizan tambien,
// para reflejar donde esta realmente hoy.
router.post('/:id/asignar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const { dni, first_name, last_name, area, sede, cargo, turno, assigned_date, observacion } = req.body;
    if (!dni || !first_name || !last_name || !area) {
      req.flash('error', 'DNI, nombres, apellidos y área son obligatorios.');
      return res.redirect(`/celulares/${req.params.id}`);
    }
    const employeeId = await employeeService.upsert(
      { dni, first_name, last_name, area, sede, cargo },
      req.session.user.id
    );
    const holderName = `${first_name} ${last_name}`;

    await pool.query(
      'UPDATE mobile_device_assignments SET returned_date = CURDATE() WHERE device_id = ? AND returned_date IS NULL',
      [req.params.id]
    );
    await pool.query(
      `INSERT INTO mobile_device_assignments
        (device_id, employee_id, holder_name, cargo, turno, assigned_date, observacion, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.params.id,
        employeeId,
        holderName,
        cargo || null,
        turno || null,
        assigned_date || null,
        observacion || null,
        req.session.user.id,
      ]
    );
    await pool.query('UPDATE mobile_devices SET status = "asignado", area = ?, sede = ? WHERE id = ?', [
      area,
      sede || null,
      req.params.id,
    ]);
    req.flash('success', 'Celular asignado correctamente.');
    res.redirect(`/celulares/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// Cierra la asignacion activa sin crear una nueva (vuelve a stock).
router.post('/:id/devolver', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE mobile_device_assignments SET returned_date = CURDATE() WHERE device_id = ? AND returned_date IS NULL',
      [req.params.id]
    );
    await pool.query('UPDATE mobile_devices SET status = "en_stock" WHERE id = ?', [req.params.id]);
    req.flash('success', 'Celular devuelto a stock.');
    res.redirect(`/celulares/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// Nota: /importar, /importar/plantilla y /resumen van antes de /:id a
// proposito (ver src/routes/attachments.js) para que Express no confunda
// esos segmentos con un id.
router.get('/importar', canWrite, (req, res) => {
  res.render('import', {
    title: 'Importar celulares',
    listUrl: '/celulares',
    actionUrl: '/celulares/importar',
    templateUrl: '/celulares/importar/plantilla',
    columns: IMPORT_COLUMNS,
    results: null,
  });
});

router.get('/importar/plantilla', canWrite, async (req, res, next) => {
  try {
    const buffer = await importService.buildTemplateBuffer(IMPORT_COLUMNS);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_celulares.xlsx"');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// Import propio (no el generico importService.importRows): cada fila
// puede generar dos inserts relacionados (el equipo y, si trae
// "Usuario asignado", su asignacion inicial), no uno solo.
router.post('/importar', canWrite, importUploader.single('file'), verifyCsrfToken, async (req, res, next) => {
  try {
    if (!req.file) {
      req.flash('error', 'Debes seleccionar un archivo.');
      return res.redirect('/celulares/importar');
    }
    const rows = await importService.parseSpreadsheet(req.file.buffer, req.file.originalname);
    const errors = [];
    let imported = 0;

    for (let i = 0; i < rows.length; i++) {
      const rowNum = i + 2;
      const row = rows[i];
      const imei = String(row['IMEI'] || '').trim();
      const area = String(row['Área'] || '').trim();
      if (!imei) {
        errors.push({ row: rowNum, message: 'Falta el campo obligatorio "IMEI"' });
        continue;
      }
      if (!area) {
        errors.push({ row: rowNum, message: 'Falta el campo obligatorio "Área"' });
        continue;
      }

      const hasChipRaw = String(row['Tiene chip'] || '').trim().toLowerCase();
      const hasChip = ['si', 'sí', 'yes', 'true', '1'].includes(hasChipRaw) ? 1 : 0;
      const holderName = String(row['Usuario asignado'] || '').trim();

      try {
        const [result] = await pool.query(
          `INSERT INTO mobile_devices
            (imei, phone_number, has_chip, asset_code, brand, model, area, sede, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            imei,
            row['Número'] || null,
            hasChip,
            row['Código'] || null,
            row['Marca'] || null,
            row['Modelo'] || null,
            area,
            row['Sede'] || null,
            holderName ? 'asignado' : 'en_stock',
            req.session.user.id,
          ]
        );
        const deviceId = result.insertId;

        if (holderName) {
          let assignedDate = row['Fecha de entrega'];
          if (assignedDate instanceof Date) assignedDate = assignedDate.toISOString().slice(0, 10);
          await pool.query(
            `INSERT INTO mobile_device_assignments
              (device_id, holder_name, cargo, turno, assigned_date, observacion, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              deviceId,
              holderName,
              row['Cargo'] || null,
              row['Turno'] || null,
              assignedDate || null,
              row['Observación'] || null,
              req.session.user.id,
            ]
          );
        }
        imported += 1;
      } catch (err) {
        errors.push({ row: rowNum, message: err.message });
      }
    }

    res.render('import', {
      title: 'Importar celulares',
      listUrl: '/celulares',
      actionUrl: '/celulares/importar',
      templateUrl: '/celulares/importar/plantilla',
      columns: IMPORT_COLUMNS,
      results: { imported, errors },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/resumen', async (req, res, next) => {
  try {
    const [counts] = await pool.query(
      'SELECT area, COUNT(*) AS total, SUM(status = "asignado") AS asignados FROM mobile_devices GROUP BY area ORDER BY area'
    );
    if (counts.length > 0) {
      const placeholders = counts.map(() => '(?)').join(', ');
      await pool.query(
        `INSERT IGNORE INTO mobile_device_area_audits (area) VALUES ${placeholders}`,
        counts.map((c) => c.area)
      );
    }
    const [audits] = await pool.query('SELECT * FROM mobile_device_area_audits ORDER BY area');
    const auditsByArea = Object.fromEntries(audits.map((a) => [a.area, a]));

    const totalEquipos = counts.reduce((sum, c) => sum + c.total, 0);
    const totalAsignados = counts.reduce((sum, c) => sum + Number(c.asignados || 0), 0);

    res.render('mobileDevices/resumen', {
      title: 'Resumen de celulares',
      counts,
      auditsByArea,
      totalEquipos,
      totalAsignados,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/resumen/:area/actualizar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const { estatus, ultima_fecha, observacion } = req.body;
    await pool.query(
      `INSERT INTO mobile_device_area_audits (area, estatus, ultima_fecha, observacion, updated_by)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE estatus = VALUES(estatus), ultima_fecha = VALUES(ultima_fecha),
         observacion = VALUES(observacion), updated_by = VALUES(updated_by)`,
      [req.params.area, estatus || 'pendiente', ultima_fecha || null, observacion || null, req.session.user.id]
    );
    req.flash('success', `Checklist de "${req.params.area}" actualizado.`);
    res.redirect('/celulares/resumen');
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM mobile_devices WHERE id = ?', [req.params.id]);
    if (!rows[0]) {
      req.flash('error', 'Celular no encontrado.');
      return res.redirect('/celulares');
    }
    const [assignments] = await pool.query(
      `SELECT a.*, e.dni
       FROM mobile_device_assignments a
       LEFT JOIN employees e ON e.id = a.employee_id
       WHERE a.device_id = ? ORDER BY a.created_at DESC`,
      [req.params.id]
    );
    const currentAssignment = assignments.find((a) => !a.returned_date) || null;
    const history = assignments.filter((a) => a.returned_date);
    const [attachments] = await pool.query(
      'SELECT * FROM attachments WHERE entity_type = "mobile_device" AND entity_id = ? ORDER BY uploaded_at DESC',
      [req.params.id]
    );
    const catalogs = await loadCatalogOptions();

    // Busqueda de empleado por DNI (recarga de pagina con ?dni=), para
    // precargar el formulario de asignar/reasignar sin retipear.
    let foundEmployee = null;
    const dniQuery = (req.query.dni || '').trim();
    if (dniQuery) {
      foundEmployee = await employeeService.findByDni(dniQuery);
      if (!foundEmployee) {
        req.flash('error', `No se encontró ningún empleado con DNI "${dniQuery}". Completa los datos para crearlo.`);
      }
    }

    res.render('mobileDevices/detail', {
      title: `Celular ${rows[0].imei}`,
      item: rows[0],
      currentAssignment,
      history,
      attachments,
      areas: catalogs.areas,
      sedes: catalogs.sedes,
      dniQuery,
      foundEmployee,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
