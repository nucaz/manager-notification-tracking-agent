// Directorio activo (fase 1: solo lectura). Ver src/services/adService.js.
//   - Ver el modulo: permiso "directorio" (apagado por defecto para editor y lector).
//   - Leer el dominio ahora: administradores.
//   - Conexion (servidor, cuenta de servicio, CA): solo superadmin.
const express = require('express');
const { requireAuth, isAdmin, isSuperAdmin } = require('../middleware/auth');
const { moduleRequired } = require('../middleware/modules');
const { verifyCsrfToken } = require('../middleware/csrf');
const adService = require('../services/adService');
const clinicService = require('../services/clinicService');
const settingsService = require('../services/settingsService');
const auditService = require('../services/auditService');

const router = express.Router();
router.use(requireAuth, moduleRequired('directorio'));

const bucket = (d) => clinicService.bucketLabel(clinicService.bucketOf(d));
const VIEW = { bucket, BUCKETS: clinicService.BUCKETS, PRIVILEGED_LABEL: adService.PRIVILEGED_LABEL, IDLE_DAYS: adService.IDLE_DAYS };

async function base() {
  const [run, cfg] = await Promise.all([adService.lastRun(), adService.config()]);
  return { run, configured: !!(cfg.url && cfg.bindUser && cfg.password && cfg.caPem), lastResult: cfg.lastResult };
}

router.get('/', async (req, res, next) => {
  try {
    const [b, ov] = await Promise.all([base(), adService.overview()]);
    // Antiguedad de la ultima conexion de los usuarios habilitados.
    const tramos = Object.fromEntries(clinicService.BUCKETS.map((x) => [x.key, 0]));
    ov.lastSeen.forEach((u) => { tramos[clinicService.bucketOf(u.last_seen)] += 1; });
    res.render('ad/index', { title: 'Directorio activo', tab: 'resumen', ...b, ov, tramos, ...VIEW });
  } catch (err) {
    next(err);
  }
});

router.get('/usuarios', async (req, res, next) => {
  try {
    res.render('ad/users', { title: 'Directorio activo: usuarios', tab: 'usuarios', ...(await base()), items: await adService.users(), ...VIEW });
  } catch (err) {
    next(err);
  }
});

router.get('/usuarios/:id(\\d+)', async (req, res, next) => {
  try {
    const item = await adService.user(req.params.id);
    if (!item) {
      req.flash('error', 'Usuario no encontrado en la última lectura del dominio.');
      return res.redirect('/ad/usuarios');
    }
    res.render('ad/user', { title: `Directorio activo: ${item.sam}`, tab: 'usuarios', ...(await base()), item, ...VIEW });
  } catch (err) {
    next(err);
  }
});

router.get('/grupos', async (req, res, next) => {
  try {
    res.render('ad/groups', { title: 'Directorio activo: grupos', tab: 'grupos', ...(await base()), items: await adService.groups(), ...VIEW });
  } catch (err) {
    next(err);
  }
});

router.get('/grupos/:id(\\d+)', async (req, res, next) => {
  try {
    const item = await adService.group(req.params.id);
    if (!item) {
      req.flash('error', 'Grupo no encontrado en la última lectura del dominio.');
      return res.redirect('/ad/grupos');
    }
    res.render('ad/group', { title: `Directorio activo: ${item.name}`, tab: 'grupos', ...(await base()), item, ...VIEW });
  } catch (err) {
    next(err);
  }
});

router.get('/unidades', async (req, res, next) => {
  try {
    res.render('ad/ous', { title: 'Directorio activo: unidades organizativas', tab: 'unidades', ...(await base()), items: await adService.ous(), ...VIEW });
  } catch (err) {
    next(err);
  }
});

router.get('/equipos', async (req, res, next) => {
  try {
    res.render('ad/computers', { title: 'Directorio activo: equipos', tab: 'equipos', ...(await base()), items: await adService.computers(), ...VIEW });
  } catch (err) {
    next(err);
  }
});

router.get('/dns', async (req, res, next) => {
  try {
    res.render('ad/dns', { title: 'Directorio activo: DNS', tab: 'dns', ...(await base()), items: await adService.dns(), ...VIEW });
  } catch (err) {
    next(err);
  }
});

router.get('/papelera', async (req, res, next) => {
  try {
    res.render('ad/deleted', { title: 'Directorio activo: papelera', tab: 'papelera', ...(await base()), items: await adService.deleted(), ...VIEW });
  } catch (err) {
    next(err);
  }
});

// Leer el dominio ahora (solo lectura): administradores.
router.post('/sincronizar', isAdmin, verifyCsrfToken, async (req, res) => {
  try {
    const r = await adService.sync(req.session.user);
    await auditService.log(req, { user: req.session.user, action: 'ad_lectura', target: r.domain, detail: r.result });
    req.flash('success', `Dominio leído: ${r.result}`);
  } catch (err) {
    await auditService.log(req, { user: req.session.user, action: 'ad_lectura_error', target: 'directorio activo', detail: err.message });
    req.flash('error', `No se pudo leer el dominio: ${err.message}`);
  }
  res.redirect(req.get('referer') && /\/ad(\/|$)/.test(req.get('referer')) ? req.get('referer') : '/ad');
});

// ------------------------------ conexion (solo superadmin) ------------------------------
router.get('/configuracion', isSuperAdmin, async (req, res, next) => {
  try {
    const cfg = await adService.config();
    res.render('ad/config', { title: 'Directorio activo: conexión', tab: 'configuracion', ...(await base()),
      cfg: { ...cfg, password: cfg.password ? 'set' : '' }, test: null });
  } catch (err) {
    next(err);
  }
});

router.post('/configuracion', isSuperAdmin, verifyCsrfToken, async (req, res, next) => {
  const clean = (v, max = 5000) => String(v || '').trim().slice(0, max);
  try {
    const current = await adService.config();
    const next = {
      url: clean(req.body.ad_url, 255), baseDn: clean(req.body.ad_base_dn, 700), bindUser: clean(req.body.ad_bind_user, 255),
      password: req.body.ad_bind_password ? String(req.body.ad_bind_password) : current.password,
      caPem: clean(req.body.ad_ca_pem, 20000), allDcs: req.body.ad_all_dcs === '1',
    };
    adService.validateConfig(next);
    // Se prueba ANTES de guardar: una conexion que no valida el certificado no se guarda.
    const test = await adService.test(next);
    const pairs = { ad_url: next.url, ad_base_dn: next.baseDn, ad_bind_user: next.bindUser, ad_ca_pem: next.caPem, ad_all_dcs: next.allDcs ? '1' : '0' };
    if (req.body.ad_bind_password) pairs.ad_bind_password = next.password;
    await settingsService.setMany(pairs);
    await auditService.log(req, { user: req.session.user, action: 'ad_configuracion', target: next.url,
      detail: `cuenta ${next.bindUser}${req.body.ad_bind_password ? ', contraseña cambiada' : ''}; certificado ${test.cert && test.cert.subject} vence ${test.cert && test.cert.validTo ? test.cert.validTo.toISOString().slice(0, 10) : '?'}` });
    req.flash('success', `Conexión verificada y guardada: ${test.dc} (${test.baseDn}).`);
    res.redirect('/ad/configuracion');
  } catch (err) {
    if (err.sqlMessage) return next(err);
    req.flash('error', err.message);
    res.redirect('/ad/configuracion');
  }
});

module.exports = router;
