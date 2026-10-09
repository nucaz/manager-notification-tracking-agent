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

