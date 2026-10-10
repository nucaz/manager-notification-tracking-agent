const express = require('express');
const path = require('path');
const fs = require('fs');
const pool = require('../db/pool');
const { requireAuth, canWrite, isAdmin } = require('../middleware/auth');
const { moduleRequired } = require('../middleware/modules');
const { verifyCsrfToken } = require('../middleware/csrf');
const { uploader, DIRS } = require('../services/uploadService');
const networkService = require('../services/networkService');
const netToolsService = require('../services/netToolsService');
const omadaService = require('../services/omadaService');
const catalogService = require('../services/catalogService');
const auditService = require('../services/auditService');

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
      tab: 'diagramas',
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

// =====================================================================
// Inventario de red: equipos (PC, AP, switches...), celulares y VLAN.
// =====================================================================
const viewBase = async () => ({ KINDS: networkService.KINDS, SOURCES: networkService.SOURCES });
const lists = async () => ({ sedes: await catalogService.getActive('sede'), areas: await catalogService.getActive('area'), vlanList: await networkService.vlans() });
const fail = (req, res, err, back, next) => {
  if (err.sqlMessage) return next(err);
  req.flash('error', err.message);
  return res.redirect(back);
};
const validKind = (k) => (networkService.KINDS[k] && k !== 'celular' ? k : '');
// Busqueda simple (?q=) sobre los campos visibles.
const search = (req, rows, fields) => {
  const q = String(req.query.q || '').trim().slice(0, 100).toLowerCase();
  return { q, rows: q ? rows.filter((r) => fields.some((f) => r[f] && String(r[f]).toLowerCase().includes(q))) : rows };
};

router.get('/equipos', async (req, res, next) => {
  try {
    const kind = validKind(req.query.tipo);
    const all = await networkService.devices();
    const f = search(req, kind ? all.filter((d) => d.kind === kind) : all, ['name', 'mac', 'mac_wifi', 'ip', 'sede', 'area', 'location', 'brand_model', 'serial', 'notes', 'vlan_names']);
    res.render('network/devices', { title: 'Red — Equipos', tab: 'equipos', ...(await viewBase()), items: f.rows, q: f.q, all, kind,
      ov: await networkService.overview() });
  } catch (err) {
    next(err);
  }
});

router.post('/equipos/traer-pc', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const r = await networkService.importPcs(req.session.user);
    await auditService.log(req, { user: req.session.user, action: 'red_traer_pc', target: 'equipos de red', detail: `${r.created} nuevas, ${r.updated} completadas, ${r.withMac} con MAC` });
    req.flash('success', `PC traídas de GLPI y del directorio activo: ${r.created} nueva(s), ${r.updated} completada(s). ${r.withMac} tienen dirección MAC`
      + (r.created + r.updated === 0 ? ' (no había nada nuevo).' : '; las demás se completan a mano o cuando GLPI las inventaríe.'));
    return res.redirect('/red/equipos?tipo=pc');
  } catch (err) {
    return fail(req, res, err, '/red/equipos', next);
  }
});

router.get('/equipos/nuevo', canWrite, async (req, res, next) => {
  try {
    res.render('network/device_form', { title: 'Red — Nuevo equipo', tab: 'equipos', ...(await viewBase()), ...(await lists()), item: { kind: validKind(req.query.tipo) || 'switch', vlan_ids: [] },
      phone: null, action: '/red/equipos/nuevo' });
  } catch (err) {
    next(err);
  }
});
router.post('/equipos/nuevo', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const id = await networkService.saveDevice(0, req.body, req.session.user);
    await auditService.log(req, { user: req.session.user, action: 'red_equipo_creado', target: req.body.name, detail: `id ${id}, ${req.body.kind}` });
    req.flash('success', 'Equipo registrado.');
    return res.redirect(`/red/equipos?tipo=${validKind(req.body.kind)}`);
  } catch (err) {
    return fail(req, res, err, `/red/equipos/nuevo?tipo=${validKind(req.body.kind)}`, next);
  }
});

router.get('/equipos/:id(\\d+)', canWrite, async (req, res, next) => {
  try {
    const item = await networkService.device(req.params.id);
    if (!item || item.kind === 'celular') {
      req.flash('error', 'El equipo ya no existe.');
      return res.redirect('/red/equipos');
    }
    return res.render('network/device_form', { title: `Red — ${item.name}`, tab: 'equipos', ...(await viewBase()), ...(await lists()), item, phone: null,
      action: `/red/equipos/${item.id}` });
  } catch (err) {
    return next(err);
  }
});
router.post('/equipos/:id(\\d+)', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    await networkService.saveDevice(req.params.id, req.body, req.session.user);
    await auditService.log(req, { user: req.session.user, action: 'red_equipo_modificado', target: req.body.name, detail: `id ${req.params.id}` });
    req.flash('success', 'Equipo actualizado.');
    return res.redirect(`/red/equipos?tipo=${validKind(req.body.kind)}`);
  } catch (err) {
    return fail(req, res, err, `/red/equipos/${req.params.id}`, next);
  }
});
router.post('/equipos/:id(\\d+)/eliminar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const item = await networkService.device(req.params.id);
    if (await networkService.deleteDevice(req.params.id)) {
      await auditService.log(req, { user: req.session.user, action: 'red_equipo_eliminado', target: item ? item.name : `id ${req.params.id}`,
        detail: item ? `${item.kind} ${item.mac || ''} ${item.ip || ''}` : '' });
      req.flash('success', 'Equipo eliminado del inventario de red.');
    }
    return res.redirect('/red/equipos');
  } catch (err) {
    return next(err);
  }
});

// Celulares: los del modulo Celulares, con su MAC, IP, ubicacion y VLAN.
router.get('/celulares', async (req, res, next) => {
  try {
    const all = await networkService.phones();
    const f = search(req, all, ['asset_code', 'imei', 'brand', 'model', 'mac', 'ip', 'location', 'sede', 'area', 'holder_name', 'phone_number', 'vlan_names']);
    res.render('network/phones', { title: 'Red — Celulares', tab: 'celulares', ...(await viewBase()), items: f.rows, q: f.q, total: all.length, withMac: all.filter((x) => x.mac).length });
  } catch (err) {
    next(err);
  }
});
router.get('/celulares/:id(\\d+)', canWrite, async (req, res, next) => {
  try {
    const p = await networkService.phone(req.params.id);
    if (!p) {
      req.flash('error', 'El celular ya no existe en el inventario.');
      return res.redirect('/red/celulares');
    }
    return res.render('network/device_form', { title: `Red — ${p.mobile.asset_code || p.mobile.imei}`, tab: 'celulares', ...(await viewBase()), ...(await lists()),
      item: p.device || { kind: 'celular', vlan_ids: [] }, phone: p.mobile, action: `/red/celulares/${p.mobile.id}` });
  } catch (err) {
    return next(err);
  }
});
router.post('/celulares/:id(\\d+)', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    await networkService.savePhone(req.params.id, req.body, req.session.user);
    await auditService.log(req, { user: req.session.user, action: 'red_celular_modificado', target: `celular ${req.params.id}`,
      detail: `MAC ${req.body.mac || '—'}, ubicación ${req.body.location || '—'}` });
    req.flash('success', 'Datos de red del celular guardados.');
    return res.redirect('/red/celulares');
  } catch (err) {
    return fail(req, res, err, `/red/celulares/${req.params.id}`, next);
  }
});

// VLAN
router.get('/vlan', async (req, res, next) => {
  try {
    const edit = req.query.editar ? await networkService.vlan(req.query.editar) : null;
    res.render('network/vlans', { title: 'Red — VLAN', tab: 'vlan', ...(await viewBase()), items: await networkService.vlans(), edit, sedes: await catalogService.getActive('sede') });
  } catch (err) {
    next(err);
  }
});
router.post('/vlan', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const id = await networkService.saveVlan(Number(req.body.id) || 0, req.body, req.session.user);
    await auditService.log(req, { user: req.session.user, action: 'red_vlan_guardada', target: `VLAN ${req.body.vlan_number} ${req.body.name}`, detail: `id ${id}` });
    req.flash('success', 'VLAN guardada.');
    return res.redirect('/red/vlan');
  } catch (err) {
    return fail(req, res, err, Number(req.body.id) ? `/red/vlan?editar=${Number(req.body.id)}` : '/red/vlan', next);
  }
});
router.post('/vlan/:id(\\d+)/eliminar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const v = await networkService.vlan(req.params.id);
    if (await networkService.deleteVlan(req.params.id)) {
      await auditService.log(req, { user: req.session.user, action: 'red_vlan_eliminada', target: v ? `VLAN ${v.vlan_number} ${v.name}` : `id ${req.params.id}` });
      req.flash('success', 'VLAN eliminada (los equipos que la tenían quedan sin ella).');
    }
    return res.redirect('/red/vlan');
  } catch (err) {
    return next(err);
  }
});

// ---------------- Omada (controladores TP-Link, solo lectura) ----------------
// Ver y buscar: quien tenga el modulo Red. Configurar, probar y leer ahora:
// administradores. Registrar equipos en el inventario: quien pueda escribir.
const omadaBase = async (req) => {
  const sites = await omadaService.sites();
  const site = sites.find((s) => s.id === Number(req.query.sitio)) || null;
  return { tab: 'omada', sites, site, STATUS: omadaService.STATUS, OKINDS: omadaService.KINDS, fmtBps: omadaService.fmtBps, fmtBytes: omadaService.fmtBytes,
    controllers: await omadaService.controllers() };
};

router.get('/omada', async (req, res, next) => {
  try {
    const b = await omadaBase(req);
    const hours = omadaService.RANGES[req.query.h] ? Number(req.query.h) : 24;
    res.render('network/omada', { title: 'Red — Omada', sub: 'resumen', ...b, hours, RANGES: omadaService.RANGES,
      d: await omadaService.dashboard({ siteId: b.site ? b.site.id : 0, hours }) });
  } catch (err) {
    next(err);
  }
});

router.get('/omada/equipos', async (req, res, next) => {
  try {
    const b = await omadaBase(req);
    const all = await omadaService.devices({ siteId: b.site ? b.site.id : 0 });
    const kind = omadaService.KINDS[req.query.tipo] ? req.query.tipo : '';
    const f = search(req, kind ? all.filter((x) => x.kind === kind) : all, ['name', 'mac', 'ip', 'model', 'serial', 'firmware', 'site_name', 'uplink_name']);
    res.render('network/omada_devices', { title: 'Red — Omada: equipos', sub: 'equipos', ...b, all, items: f.rows, q: f.q, kind });
  } catch (err) {
    next(err);
  }
});

router.post('/omada/equipos/registrar', canWrite, verifyCsrfToken, async (req, res, next) => {
  try {
    const r = await omadaService.registerInInventory(req.session.user);
    await auditService.log(req, { user: req.session.user, action: 'red_omada_registrar_equipos', target: 'equipos de red', detail: `${r.created} equipos nuevos de ${r.total} en Omada` });
    req.flash('success', r.created ? `${r.created} equipo(s) de Omada registrados en la pestaña Equipos. Complete ahí la sede, el área y las notas.` : 'Todos los equipos de Omada ya estaban en la pestaña Equipos.');
    return res.redirect('/red/omada/equipos');
  } catch (err) {
    return next(err);
  }
});

router.get('/omada/clientes', async (req, res, next) => {
  try {
    const b = await omadaBase(req);
    const view = ['wifi', 'cable', 'todos', 'bloqueados'].includes(req.query.ver) ? req.query.ver : '';
    const everyone = await omadaService.clients({ siteId: b.site ? b.site.id : 0, onlyActive: false });
    const all = everyone.filter((c) => c.active);
    const rows = view === 'wifi' ? all.filter((c) => c.wireless) : view === 'cable' ? all.filter((c) => !c.wireless) : view === 'todos' ? everyone
      : view === 'bloqueados' ? everyone.filter((c) => c.blocked) : all;
    const f = search(req, rows, ['name', 'mac', 'ip', 'vendor', 'device_type', 'ssid', 'via_name', 'site_name', 'inventory_name']);
    res.render('network/omada_clients', { title: 'Red — Omada: clientes', sub: 'clientes', ...b, all, items: f.rows, q: f.q, view, blockedCount: everyone.filter((c) => c.blocked).length });
  } catch (err) {
    next(err);
  }
});

// Lo unico que cambia algo en Omada: solo administradores, con el controlador habilitado para acciones, y auditado.
router.post('/omada/clientes/:id(\\d+)/accion', isAdmin, verifyCsrfToken, async (req, res, next) => {
  const back = `/red/omada/clientes${/^\?[\w=&%.:-]{0,200}$/.test(String(req.body.volver || '')) ? req.body.volver : ''}`;
  try {
    const r = await omadaService.clientAction(req.params.id, String(req.body.accion || ''));
    await auditService.log(req, { user: req.session.user, action: 'red_omada_cliente_accion', target: `${r.name} (${r.mac})`.slice(0, 250), detail: `${r.done} · sitio ${r.site}${r.ip ? ` · IP ${r.ip}` : ''}` });
    req.flash('success', `${r.name} (${r.mac}): ${r.done} en Omada.`);
    return res.redirect(back);
  } catch (err) {
    return fail(req, res, err, back, next);
  }
});

router.get('/omada/configuracion', isAdmin, async (req, res, next) => {
  try {
    const b = await omadaBase(req);
    const edit = req.query.editar ? await omadaService.controller(req.query.editar) : null;
    const draft = req.session.omadaDraft || null;
    delete req.session.omadaDraft;
    res.render('network/omada_config', { title: 'Red — Omada: configuración', sub: 'configuracion', ...b, edit, draft });
  } catch (err) {
    next(err);
  }
});

router.post('/omada/configuracion', isAdmin, verifyCsrfToken, async (req, res, next) => {
  const id = Number(req.body.id) || 0;
  try {
    const saved = await omadaService.saveController(id, req.body, req.session.user);
    await auditService.log(req, { user: req.session.user, action: 'red_omada_controlador_guardado', target: String(req.body.name || '').slice(0, 100), detail: `id ${saved}` });
    // Se prueba de inmediato: asi se sabe si las credenciales sirven.
    try {
      const t = await omadaService.test(saved);
      req.flash('success', `Controlador guardado y conexión correcta. Sitios visibles: ${t.sites.join(', ') || 'ninguno'}.`);
      await omadaService.syncController(saved);
    } catch (err) {
      req.flash('error', `Controlador guardado, pero la prueba de conexión falló: ${err.message}`);
    }
    return res.redirect('/red/omada/configuracion');
  } catch (err) {
    // Lo escrito vuelve al formulario, menos el secreto.
    const { client_secret: _s, _csrf, ...rest } = req.body; // eslint-disable-line no-unused-vars
    req.session.omadaDraft = rest;
    return fail(req, res, err, id ? `/red/omada/configuracion?editar=${id}` : '/red/omada/configuracion', next);
  }
});

router.post('/omada/configuracion/:id(\\d+)/probar', isAdmin, verifyCsrfToken, async (req, res, next) => {
  try {
    const t = await omadaService.test(req.params.id);
    req.flash('success', `Conexión correcta. Sitios visibles: ${t.sites.join(', ') || 'ninguno'}.`);
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', `La prueba falló: ${err.message}`);
  }
  return res.redirect('/red/omada/configuracion');
});

router.post('/omada/configuracion/:id(\\d+)/eliminar', isAdmin, verifyCsrfToken, async (req, res, next) => {
  try {
    const c = await omadaService.controller(req.params.id);
    if (await omadaService.deleteController(req.params.id)) {
      await auditService.log(req, { user: req.session.user, action: 'red_omada_controlador_eliminado', target: c ? c.name : `id ${req.params.id}` });
      req.flash('success', 'Controlador quitado, con lo que se había leído de él. En Omada no se cambió nada.');
    }
    return res.redirect('/red/omada/configuracion');
  } catch (err) {
    return next(err);
  }
});

let omadaManual = 0; // una lectura manual por minuto, entre todos
router.post('/omada/leer', isAdmin, verifyCsrfToken, async (req, res, next) => {
  try {
    if (Date.now() - omadaManual < 60000) {
      req.flash('error', 'Se acaba de leer hace menos de un minuto. Espere un momento.');
      return res.redirect('/red/omada');
    }
    omadaManual = Date.now();
    const r = await omadaService.sync();
    const bad = r.results.filter((x) => !x.ok);
    if (r.skipped) req.flash('error', 'Ya hay una lectura en curso.');
    else if (!r.results.length) req.flash('error', 'No hay controladores habilitados. Agregue uno en Configuración.');
    else if (bad.length) req.flash('error', bad.map((x) => `${x.name}: ${x.detail}`).join(' — ').slice(0, 600));
    else req.flash('success', `Lectura completa: ${r.results.map((x) => x.detail).join(' · ')}`.slice(0, 600));
    return res.redirect('/red/omada');
  } catch (err) {
    return next(err);
  }
});

// Herramientas de diagnostico: solo administradores, con tope por usuario y auditoria.
router.get('/herramientas', isAdmin, async (req, res, next) => {
  try {
    res.render('network/tools', { title: 'Red — Herramientas', tab: 'herramientas', ...(await viewBase()), TOOLS: netToolsService.TOOLS, COMMON_PORTS: netToolsService.COMMON_PORTS,
      MAX_PORTS: netToolsService.MAX_PORTS, host: String(req.query.host || '').slice(0, 253), tool: netToolsService.TOOLS[req.query.h] ? req.query.h : 'ping' });
  } catch (err) {
    next(err);
  }
});
const toolHits = new Map(); // userId -> marcas de tiempo
const overLimit = (req) => {
  const id = req.session.user.id;
  const recent = (toolHits.get(id) || []).filter((t) => t > Date.now() - 5 * 60000);
  if (recent.length >= 40) return true;
  toolHits.set(id, [...recent, Date.now()]);
  return false;
};
const auditTool = (req, tool, r) => auditService.log(req, { user: req.session.user, action: 'red_herramienta', target: r.host,
  detail: `${tool}${tool === 'puertos' ? ` (${r.rows.length} puertos)` : ''}: ${r.summary}`.slice(0, 500) });

router.post('/herramientas/ejecutar', isAdmin, verifyCsrfToken, async (req, res) => {
  if (overLimit(req)) return res.status(429).json({ error: 'Demasiadas consultas seguidas. Espere unos minutos.' });
  const tool = String(req.body.tool || '');
  try {
    const r = await netToolsService.execute(tool, req.body.host, req.body.ports);
    await auditTool(req, tool, r);
    return res.json(r);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// La misma prueba, pero enviando cada linea en cuanto sale (para la ventana de
// terminal). Formato de eventos del servidor: {t:'out', s} por linea y al
// final {t:'end', r} o {t:'error', s}. Si quien mira cierra o pulsa Detener,
// se corta el proceso.
router.post('/herramientas/flujo', isAdmin, verifyCsrfToken, async (req, res) => {
  if (overLimit(req)) return res.status(429).json({ error: 'Demasiadas consultas seguidas. Espere unos minutos.' });
  const tool = String(req.body.tool || '');
  res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  const stop = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) stop.abort(); });
  try {
    const r = await netToolsService.execute(tool, req.body.host, req.body.ports, { emit: (s) => send({ t: 'out', s }), signal: stop.signal });
    await auditTool(req, tool, r).catch(() => {});
    // El resultado completo (saltos, puertos) para la tarjeta de resultados; la salida ya se envio linea por linea.
    send({ t: 'end', r: { tool, ok: r.ok, summary: r.summary, host: r.host, ip: r.ip || null, hops: r.hops || null, rows: r.rows || null } });
  } catch (err) {
    send({ t: 'error', s: err.message });
  }
  finished = true;
  return res.end();
});

module.exports = router;

