const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { requireAuth, canWrite } = require('../middleware/auth');
const { moduleRequired } = require('../middleware/modules');
const { verifyCsrfToken } = require('../middleware/csrf');
const employeeService = require('../services/employeeService');
const catalogService = require('../services/catalogService');
const importService = require('../services/importService');
const { importUploader } = require('../services/uploadService');

const router = express.Router();
// verifyCsrfToken NO va a nivel de router: /importar es multipart y
// necesita que multer parsee el body antes de verificar el token (mismo
// motivo que en src/routes/mobileDevices.js). Se aplica explicito en
// cada ruta POST que no sea multipart.
router.use(requireAuth, moduleRequired('empleados'));

// DNI peruano: 8 digitos numericos.
const DNI_REGEX = /^\d{8}$/;

async function loadCatalogOptions() {
  const [sedes, areas] = await Promise.all([
    catalogService.getActive('sede'),
    catalogService.getActive('area'),
  ]);
  return { sedes, areas };
}

const IMPORT_COLUMNS = [
  { header: 'DNI', field: 'dni', required: true },
  { header: 'Nombres', field: 'first_name', required: true },
  { header: 'Apellidos', field: 'last_name', required: true },
  { header: 'Área', field: 'area' },
  { header: 'Sede', field: 'sede' },
  { header: 'Cargo', field: 'cargo' },
  { header: 'Notas', field: 'notes' },
];

router.get('/', async (req, res, next) => {
  try {
    const { q } = req.query;
    const items = await employeeService.list(q);
    res.render('employees/list', { title: 'Empleados', items, q: q || '' });
  } catch (err) {
    next(err);
  }
});

router.get('/nuevo', canWrite, async (req, res, next) => {
  try {
    const catalogs = await loadCatalogOptions();
    res.render('employees/form', { title: 'Nuevo empleado', item: {}, ...catalogs });
  } catch (err) {
    next(err);
  }
});

router.post('/nuevo', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const { dni, first_name, last_name, area, sede, cargo, notes } = req.body;
    if (!dni || !first_name || !last_name) {
      req.flash('error', 'DNI, nombres y apellidos son obligatorios.');
      return res.redirect('/empleados/nuevo');
    }
    if (!DNI_REGEX.test(dni)) {
      req.flash('error', 'El DNI debe tener exactamente 8 dígitos numéricos.');
      return res.redirect('/empleados/nuevo');
    }
    await pool.query(
      `INSERT INTO employees (dni, first_name, last_name, area, sede, cargo, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [dni, first_name, last_name, area || null, sede || null, cargo || null, notes || null, req.session.user.id]
    );
    req.flash('success', 'Empleado registrado correctamente.');
    res.redirect('/empleados');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'Ya existe un empleado con ese DNI.');
      return res.redirect('/empleados/nuevo');
    }
    next(err);
  }
});

router.get('/:id/editar', canWrite, async (req, res, next) => {
  try {
    const item = await employeeService.get(req.params.id);
    if (!item) {
      req.flash('error', 'Empleado no encontrado.');
      return res.redirect('/empleados');
    }
    const catalogs = await loadCatalogOptions();
    res.render('employees/form', { title: 'Editar empleado', item, ...catalogs });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/editar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const { dni, first_name, last_name, area, sede, cargo, notes } = req.body;
    if (!dni || !first_name || !last_name) {
      req.flash('error', 'DNI, nombres y apellidos son obligatorios.');
      return res.redirect(`/empleados/${req.params.id}/editar`);
    }
    if (!DNI_REGEX.test(dni)) {
      req.flash('error', 'El DNI debe tener exactamente 8 dígitos numéricos.');
      return res.redirect(`/empleados/${req.params.id}/editar`);
    }
    await employeeService.update(req.params.id, { dni, first_name, last_name, area, sede, cargo, notes });
    req.flash('success', 'Empleado actualizado correctamente.');
    res.redirect('/empleados');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'Ya existe otro empleado con ese DNI.');
      return res.redirect(`/empleados/${req.params.id}/editar`);
    }
    next(err);
  }
});

router.post('/:id/eliminar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    await employeeService.remove(req.params.id);
    req.flash('success', 'Empleado eliminado.');
    res.redirect('/empleados');
  } catch (err) {
    next(err);
  }
});

// Nota: /importar y /exportar.xlsx van antes de /:id a proposito (mismo
// motivo que en src/routes/mobileDevices.js) para que Express no confunda
// esos segmentos con un id.
router.get('/importar', canWrite, (req, res) => {
  res.render('import', {
    title: 'Importar empleados',
    listUrl: '/empleados',
    actionUrl: '/empleados/importar',
    templateUrl: '/empleados/importar/plantilla',
    columns: IMPORT_COLUMNS,
    results: null,
  });
});

router.get('/importar/plantilla', canWrite, async (req, res, next) => {
  try {
    const buffer = await importService.buildTemplateBuffer(IMPORT_COLUMNS);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_empleados.xlsx"');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.post('/importar', canWrite, importUploader.single('file'), verifyCsrfToken, async (req, res, next) => {
  try {
    if (!req.file) {
      req.flash('error', 'Debes seleccionar un archivo.');
      return res.redirect('/empleados/importar');
    }
    const rows = await importService.parseSpreadsheet(req.file.buffer, req.file.originalname);
    const results = await importService.importRows(rows, IMPORT_COLUMNS, {
      table: 'employees',
      userId: req.session.user.id,
    });
    res.render('import', {
      title: 'Importar empleados',
      listUrl: '/empleados',
      actionUrl: '/empleados/importar',
      templateUrl: '/empleados/importar/plantilla',
      columns: IMPORT_COLUMNS,
      results,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/exportar.xlsx', async (req, res, next) => {
  try {
    const items = await employeeService.list(req.query.q);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Empleados');
    sheet.addRow(['DNI', 'Nombres', 'Apellidos', 'Área', 'Sede', 'Cargo', 'Notas']);
    for (const e of items) {
      sheet.addRow([e.dni, e.first_name, e.last_name, e.area || '', e.sede || '', e.cargo || '', e.notes || '']);
    }
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach((c) => { c.width = 20; });

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="empleados.xlsx"');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// Asigna un celular EN STOCK a este empleado (mismo efecto que
// /celulares/:id/asignar pero elegido desde el lado del empleado: aca se
// parte de la persona y se elige que equipo darle, en vez de partir del
// equipo y buscar a la persona).
router.post('/:id/asignar-celular', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const employee = await employeeService.get(req.params.id);
    if (!employee) {
      req.flash('error', 'Empleado no encontrado.');
      return res.redirect('/empleados');
    }
    const { device_id, turno, assigned_date, observacion } = req.body;
    const [[device]] = await pool.query(
      'SELECT * FROM mobile_devices WHERE id = ? AND status = "en_stock"',
      [device_id]
    );
    if (!device) {
      req.flash('error', 'Selecciona un celular disponible (en stock).');
      return res.redirect(`/empleados/${req.params.id}`);
    }
    const holderName = `${employee.first_name} ${employee.last_name}`;
    await pool.query(
      'UPDATE mobile_device_assignments SET returned_date = CURDATE() WHERE device_id = ? AND returned_date IS NULL',
      [device_id]
    );
    await pool.query(
      `INSERT INTO mobile_device_assignments
        (device_id, employee_id, holder_name, cargo, turno, assigned_date, observacion, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [device_id, employee.id, holderName, employee.cargo || null, turno || null, assigned_date || null, observacion || null, req.session.user.id]
    );
    await pool.query('UPDATE mobile_devices SET status = "asignado", area = ?, sede = ? WHERE id = ?', [
      employee.area || device.area,
      employee.sede || device.sede,
      device_id,
    ]);
    req.flash('success', 'Celular asignado correctamente.');
    res.redirect(`/empleados/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const employee = await employeeService.get(req.params.id);
    if (!employee) {
      req.flash('error', 'Empleado no encontrado.');
      return res.redirect('/empleados');
    }
    const [currentDevices] = await pool.query(
      `SELECT d.*, a.id AS assignment_id, a.assigned_date
       FROM mobile_devices d
       JOIN mobile_device_assignments a ON a.device_id = d.id AND a.returned_date IS NULL
       WHERE a.employee_id = ?
       ORDER BY a.assigned_date DESC`,
      [req.params.id]
    );
    const [assignmentHistory] = await pool.query(
      `SELECT a.*, d.imei, d.asset_code
       FROM mobile_device_assignments a
       JOIN mobile_devices d ON d.id = a.device_id
       WHERE a.employee_id = ?
       ORDER BY a.created_at DESC`,
      [req.params.id]
    );
    const [incidents] = await pool.query(
      `SELECT i.*, d.imei, d.asset_code
       FROM mobile_device_incidents i
       JOIN mobile_devices d ON d.id = i.device_id
       WHERE i.device_id IN (SELECT DISTINCT device_id FROM mobile_device_assignments WHERE employee_id = ?)
       ORDER BY i.fecha DESC, i.id DESC`,
      [req.params.id]
    );
    const [availableDevices] = await pool.query(
      'SELECT id, imei, asset_code, brand, model FROM mobile_devices WHERE status = "en_stock" ORDER BY imei'
    );
    res.render('employees/detail', {
      title: `${employee.first_name} ${employee.last_name}`,
      employee,
      currentDevices,
      assignmentHistory,
      incidents,
      availableDevices,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
