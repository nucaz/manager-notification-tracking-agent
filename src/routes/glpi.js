const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { requireAuth, canWrite } = require('../middleware/auth');
const { moduleRequired } = require('../middleware/modules');
const { verifyCsrfToken } = require('../middleware/csrf');
const glpiClient = require('../services/glpiClient');
const glpiStats = require('../services/glpiStatsService');
const dashboardService = require('../services/dashboardService');

const router = express.Router();
router.use(requireAuth, verifyCsrfToken);

// Prueba de conexion (usada desde la pantalla de Configuracion)
router.post('/probar-conexion', canWrite, async (req, res) => {
  try {
    const result = await glpiClient.testConnection();
    const partes = Object.entries(result.counts || {})
      .map(([k, n]) => `${n === null ? 'sin permiso para ver' : n} ${glpiClient.ASSET_TYPES[k].label.toLowerCase()}`);
    const api = (await glpiClient.apiVersion()) === 'v2' ? 'API v2' : 'API clásica';
    req.flash('success', `Conexión con GLPI exitosa (${api}${result.user ? `, usuario ${result.user}` : ''}). Ve: ${partes.join(', ')}.`);
  } catch (err) {
    req.flash('error', `No se pudo conectar con GLPI: ${err.message}`);
  }
  res.redirect('/configuracion');
});

// Busqueda de equipos GLPI (usada por el autocompletar en los formularios, via fetch/JSON)
router.get('/api/equipos', async (req, res) => {
  try {
    const results = await glpiClient.searchComputers(req.query.q || '', 15);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.get('/api/entidades', async (req, res) => {
  try {
    const results = await glpiClient.listEntities(100);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Inventario de GLPI (solo lectura): computadoras, monitores e impresoras
// (?tipo=), con busqueda por nombre, serie o n. de inventario, paginacion y
// exportacion a Excel. No requiere canWrite - es de consulta. moduleRequired
// se aplica solo a estas rutas (no a nivel de router), porque el resto del
// router (sincronizar, autocompletar equipos/entidades) no es "el modulo
// Inventario GLPI" y no debe quedar gateado por el mismo permiso.
const TIPOS = glpiClient.ASSET_TYPES;
const tipoOf = (value) => (TIPOS[value] ? value : 'computadoras');
// Registros por pagina (?por=): uno de estos, o "todos".
const POR_PAGINA = [10, 20, 30, 40, 50, 100];
const porOf = (value) => (value === 'todos' ? 'todos' : (POR_PAGINA.includes(Number(value)) ? Number(value) : 20));
// Orden por columna (clic en el encabezado, ver public/js/tablas.js): lo hace GLPI.
const ordenOf = (tipo, value) => (value === 'id' || TIPOS[tipo].columns.some((c) => c.key === value) ? value : '');
const dirOf = (value) => (value === 'desc' ? 'desc' : 'asc');

// Con copia local (la renueva cada 30 minutos src/jobs/syncExternal.js) la lista
// sale de ahi: rapida, con filtros por columna como en Excel y con columnas
// derivadas (generacion del procesador, tipo de memoria). Sin copia, se
// consulta GLPI en vivo como antes (sin filtros por columna).
const localOrden = (tipo, value) => (glpiStats.columnsOf(tipo).some((c) => c.key === value) ? value : '');
const filterQuery = (query) => Object.fromEntries(Object.entries(query).filter(([k, v]) => /^f_[a-z_]+$/.test(k) && v));

async function localList(tipo, query) {
  const data = await glpiStats.rows(tipo);
  const f = glpiStats.filterList(tipo, data.rows, query);
  const orden = localOrden(tipo, query.orden);
  return { ...data, ...f, orden, sorted: glpiStats.sortList(f.rows, orden, dirOf(query.dir)), filters: filterQuery(query) };
}

router.get('/inventario', moduleRequired('glpi_inventario'), async (req, res) => {
  const tipo = tipoOf(req.query.tipo);
  const q = (req.query.q || '').trim();
  const por = porOf(req.query.por);
  const page = por === 'todos' ? 1 : Math.max(parseInt(req.query.page, 10) || 1, 1);
  const dir = dirOf(req.query.dir);
  const base = { title: 'Inventario GLPI', tipo, tipos: TIPOS, type: TIPOS[tipo], q, page, por, porPagina: POR_PAGINA, dir, local: null };
  try {
    if (await glpiStats.hasCopy(tipo)) {
      const l = await localList(tipo, req.query);
      const total = l.sorted.length;
      const totalPages = por === 'todos' ? 1 : Math.max(Math.ceil(total / por), 1);
      const items = por === 'todos' ? l.sorted : l.sorted.slice((page - 1) * por, page * por);
      return res.render('glpi/inventario', { ...base, orden: l.orden, items, total, totalPages, connectionError: null, extras: null,
        local: { syncedAt: l.syncedAt, warnings: l.warnings, columns: l.columns, options: l.options, active: l.active, filters: l.filters } });
    }
    const orden = ordenOf(tipo, req.query.orden);
    const sortOpts = orden ? { sort: orden, dir } : {};
    if (por === 'todos') {
      const items = await glpiClient.listAllItems(tipo, { query: q, ...sortOpts });
      return res.render('glpi/inventario', { ...base, orden, items, total: items.length, totalPages: 1, connectionError: null, extras: items.extras || null });
    }
    const { items, total, extras } = await glpiClient.listItems(tipo, { query: q, start: (page - 1) * por, limit: por, ...sortOpts });
    res.render('glpi/inventario', {
      ...base, orden, items, total, totalPages: Math.max(Math.ceil(total / por), 1), connectionError: null, extras: extras || null,
    });
  } catch (err) {
    res.render('glpi/inventario', { ...base, orden: '', items: [], total: 0, totalPages: 1, connectionError: err.message, extras: null });
  }
});

router.get('/inventario/exportar.xlsx', moduleRequired('glpi_inventario'), async (req, res) => {
  const tipo = tipoOf(req.query.tipo);
  const type = TIPOS[tipo];
  try {
    let columns = type.columns;
    let rows;
    if (await glpiStats.hasCopy(tipo)) {
      // Lo mismo que se ve en pantalla: busqueda, filtros por columna y orden; con las columnas derivadas.
      const l = await localList(tipo, req.query);
      columns = l.columns;
      rows = l.sorted;
    } else {
      const orden = ordenOf(tipo, req.query.orden);
      rows = await glpiClient.listAllItems(tipo, { query: (req.query.q || '').trim(), ...(orden ? { sort: orden, dir: dirOf(req.query.dir) } : {}) });
    }
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(type.label);
    sheet.addRow(['ID GLPI', ...columns.map((c) => c.label)]);
    rows.forEach((r) => sheet.addRow([Number(r.id), ...columns.map((c) => r[c.key] || '')]));
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length + 1 } };
    sheet.columns.forEach((col, i) => { col.width = i === 0 ? 9 : 20; });
    columns.forEach((c, i) => { if (['os', 'processor', 'ip', 'entity', 'memory_type', 'cpu_generation'].includes(c.key)) sheet.getColumn(i + 2).width = 34; });
    const buffer = await workbook.xlsx.writeBuffer();
    const fecha = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="glpi_${tipo}_${fecha}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    req.flash('error', `No se pudo exportar desde GLPI: ${err.message}`);
    res.redirect(`/glpi/inventario?tipo=${tipo}`);
  }
});

// --- Tablero del inventario: indicadores y widgets (ver dashboardService, tablero "glpi") ---
const BOARD = {
  boardBase: '/glpi/inventario/tablero', boardTitle: 'Tablero del inventario GLPI',
  boardIntro: 'Estadísticas de computadoras, monitores e impresoras: procesador (familia, generación, antigüedad, Windows 11), memoria, marcas y sedes. Haga clic en una cifra para ver qué equipos hay detrás.',
  boardLinks: [['/glpi/inventario', 'Lista del inventario']], boardPlaceholder: 'Ej. Lenovo por generación del procesador',
  boardExamples: 'Ejemplos: <em>Computadoras · Procesador: generación · filtro Marca = Lenovo</em> (qué generaciones tiene cada marca); '
    + '<em>Computadoras · Memoria total · filtro Memoria: tipo = DDR3</em> (cuánta memoria tienen los equipos más viejos); '
    + '<em>Computadoras · Sede · filtro Procesador compatible con Windows 11 = No</em> (dónde están los equipos a renovar).',
};
router.get('/inventario/tablero', moduleRequired('glpi_inventario'), async (req, res, next) => {
  try {
    const warnings = [];
    for (const t of Object.keys(TIPOS)) {
      if (!(await glpiStats.hasCopy(t))) warnings.push(`Todavía no hay copia local de ${TIPOS[t].label.toLowerCase()}: se cuenta cuando termine la primera lectura de GLPI (cada 30 minutos).`);
    }
    const board = await dashboardService.board(req.session.user, 'glpi');
    res.render('mobileDevices/board', { title: 'Tablero del inventario GLPI', ...board, ...BOARD, boardWarnings: warnings, charts: dashboardService.CHARTS, detailUrl: dashboardService.detailUrl });
  } catch (err) {
    next(err);
  }
});
router.get('/inventario/tablero/detalle', moduleRequired('glpi_inventario'), async (req, res) => {
  try {
    const d = await dashboardService.detail(req.query, 'glpi');
    res.render('mobileDevices/boardDetail', { title: `${d.config.title}: ${d.label}`, d, boardBase: BOARD.boardBase,
      excelUrl: `${req.originalUrl.replace('/tablero/detalle?', '/tablero/detalle.xlsx?')}` });
  } catch (err) {
    req.flash('error', err.message);
    res.redirect(BOARD.boardBase);
  }
});
router.get('/inventario/tablero/detalle.xlsx', moduleRequired('glpi_inventario'), async (req, res) => {
  try {
    const d = await dashboardService.detail(req.query, 'glpi');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Detalle');
    ws.addRow([`${d.config.title}: ${d.label}`]).font = { bold: true, size: 13 };
    ws.addRow([`${d.rows.length} registro(s)${d.config.filter ? ` · solo ${d.dataset.fields[d.config.filter.field]} = ${d.config.filter.value}` : ''}`]);
    ws.addRow([]);
    ws.addRow(d.dataset.columns.map((c) => c[1])).font = { bold: true };
    d.rows.forEach((r) => ws.addRow(d.dataset.columns.map(([k]) => (r[k] === null || r[k] === undefined ? '' : String(r[k])))));
    ws.views = [{ state: 'frozen', ySplit: 4 }];
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: d.dataset.columns.length } };
    ws.columns.forEach((c) => { c.width = 20; });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="tablero_glpi_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(await wb.xlsx.writeBuffer());
  } catch (err) {
    req.flash('error', err.message);
    res.redirect(BOARD.boardBase);
  }
});
router.post('/inventario/tablero/widgets', moduleRequired('glpi_inventario'), async (req, res) => {
  try {
    const b = req.body;
    // Compartir con todos solo quien puede editar en el modulo; un lector arma widgets para si.
    const shared = b.shared === '1' && (req.effectiveRole || req.session.user.role) !== 'lector';
    const config = await dashboardService.addWidget(req.session.user, {
      title: b.title, dataset: b.dataset, groupBy: b.groupBy, metric: b.metric, chart: b.chart, top: b.top,
      filter: b.filter_field ? { field: b.filter_field, value: b.filter_value } : null,
    }, shared, 'glpi');
    req.flash('success', `Widget "${config.title}" agregado${shared ? ' y compartido con todos' : ''}.`);
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect(`${BOARD.boardBase}#widgets_propios`);
});
router.post('/inventario/tablero/widgets/:id(\\d+)/quitar', moduleRequired('glpi_inventario'), async (req, res) => {
  const ok = await dashboardService.removeWidget(req.session.user, req.params.id);
  req.flash(ok ? 'success' : 'error', ok ? 'Widget quitado del tablero.' : 'Ese widget no se puede quitar (no es suyo).');
  res.redirect(`${BOARD.boardBase}#widgets_propios`);
});

async function renderAsset(res, tipo, id) {
  const type = TIPOS[tipo];
  try {
    const [detail, connections, software] = await Promise.all([
      glpiClient.getItemDetail(tipo, id),
      glpiClient.getConnections(tipo, id),
      tipo === 'computadoras' ? glpiClient.getComputerSoftware(id) : Promise.resolve(null),
    ]);
    res.render('glpi/asset', { title: detail.name, tipo, type, id, detail, connections, software, connectionError: null });
  } catch (err) {
    res.render('glpi/asset', { title: type.singular, tipo, type, id, detail: null, connections: [], software: null, connectionError: err.message });
  }
}

// Detalle de una computadora (ruta de siempre) o de un monitor/impresora.
router.get('/inventario/:id(\\d+)', moduleRequired('glpi_inventario'), (req, res) => renderAsset(res, 'computadoras', req.params.id));
router.get('/inventario/:tipo/:id(\\d+)', moduleRequired('glpi_inventario'), (req, res, next) => {
  if (!TIPOS[req.params.tipo]) return next();
  return renderAsset(res, req.params.tipo, req.params.id);
});

const ENTITY_TABLES = {
  license: { table: 'software_licenses' },
  domain: { table: 'domains' },
  isp_contract: { table: 'isp_contracts' },
  server: { table: 'servers' },
  certificate: { table: 'certificates' },
};

// Sincroniza un registro local (licencia/dominio/contrato ISP/servidor/certificado) como Contrato en GLPI
router.post('/sincronizar/:entityType/:id', canWrite, async (req, res, next) => {
  try {
    const { entityType, id } = req.params;
    const config = ENTITY_TABLES[entityType];
    if (!config) {
      req.flash('error', 'Tipo de entidad invalido.');
      return res.redirect('back');
    }
    const [rows] = await pool.query(`SELECT * FROM ${config.table} WHERE id = ?`, [id]);
    const item = rows[0];
    if (!item) {
      req.flash('error', 'Registro no encontrado.');
      return res.redirect('back');
    }

    let name, beginDate, notes;
    if (entityType === 'license') {
      name = `Licencia: ${item.product_name}`;
      beginDate = item.start_date || item.purchase_date;
      notes = item.notes || '';
    } else if (entityType === 'domain') {
      name = `Dominio: ${item.domain_name}`;
      beginDate = item.registration_date;
      notes = item.notes || '';
    } else if (entityType === 'server') {
      name = `Activo TI: ${item.name}`;
      beginDate = item.purchase_date;
      notes = item.notes || '';
    } else if (entityType === 'certificate') {
      name = `Certificado TLS: ${item.common_name}`;
      beginDate = item.issue_date;
      notes = item.notes || '';
    } else {
      name = `Contrato ISP: ${item.provider} (${item.contract_number || 's/n'})`;
      beginDate = item.start_date;
      notes = item.notes || '';
    }

    const result = await glpiClient.createContract({ name, notes, begin_date: beginDate });
    const glpiId = result && result.id;
    if (glpiId) {
      await pool.query(`UPDATE ${config.table} SET glpi_contract_id = ? WHERE id = ?`, [glpiId, id]);
    }
    req.flash('success', `Registrado en GLPI como contrato #${glpiId || '?'}.`);
    res.redirect('back');
  } catch (err) {
    req.flash('error', `Error al sincronizar con GLPI: ${err.message}`);
    res.redirect('back');
  }
});

module.exports = router;
