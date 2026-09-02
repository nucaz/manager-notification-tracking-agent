const crypto = require('crypto');

// Genera (una vez por sesion) y expone el token CSRF a las vistas.
// Se monta globalmente en src/app.js, antes de los routers.
function ensureCsrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

// Verifica el token CSRF en solicitudes que modifican estado. No se monta
// globalmente: en las rutas con multer (subida de archivos) debe ir DESPUES
// de upload.single(...), porque el body multipart recien queda parseado ahi.
function verifyCsrfToken(req, res, next) {
  if (req.method !== 'POST') return next();

  const sessionToken = req.session.csrfToken;
  const bodyToken = req.body && req.body._csrf;

  if (
    typeof sessionToken === 'string' &&
    typeof bodyToken === 'string' &&
    sessionToken.length === bodyToken.length &&
    crypto.timingSafeEqual(Buffer.from(sessionToken), Buffer.from(bodyToken))
  ) {
    return next();
  }

  req.flash('error', 'Tu sesión expiró o la solicitud no es válida. Intenta de nuevo.');
  return res.redirect('back');
}

module.exports = { ensureCsrfToken, verifyCsrfToken };
