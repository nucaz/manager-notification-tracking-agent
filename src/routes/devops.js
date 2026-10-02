// Entrada a DevOps Sidecar con el usuario de esta aplicacion (acceso
// unico). Quien ya inicio sesion aqui (con captcha y 2FA) y tiene el
// permiso recibe un pase firmado de un solo uso, que el navegador entrega
// al sidecar con un formulario (POST: el pase no queda en la URL).
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const modules = require('../middleware/modules');
const auditService = require('../services/auditService');
const ssoService = require('../services/ssoService');

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  const user = req.session.user;
  try {
    // Se consulta el permiso directamente (no el resumen que usa el menu).
    if (!(await modules.moduleEnabled(user.role, 'devops'))) {
      req.flash('error', 'No tienes acceso a DevOps. Pide a un administrador que te lo habilite en Permisos.');
      return res.redirect('/');
    }
  } catch (err) {
    return next(err);
  }
  const sidecarUrl = ssoService.sidecarPublicUrl(req);
  // Sin secreto compartido (instalacion anterior): el sidecar pide su propio usuario y contrasena.
  if (!ssoService.enabled()) return res.redirect(sidecarUrl);

  const appUrl = `${req.protocol}://${req.get('host')}`;
  await auditService.log(req, { user, action: 'devops_sso', target: sidecarUrl });
  res.setHeader('Cache-Control', 'no-store');
  res.render('devops/entrar', { title: 'Entrando a DevOps', action: `${sidecarUrl}/sso`, token: ssoService.userPass(user, appUrl), layout: false });
});

module.exports = router;
