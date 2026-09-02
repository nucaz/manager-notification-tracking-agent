function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  req.flash('error', 'Debes iniciar sesion para continuar.');
  return res.redirect('/login');
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      req.flash('error', 'Debes iniciar sesion para continuar.');
      return res.redirect('/login');
    }
    if (!roles.includes(req.session.user.role)) {
      req.flash('error', 'No tienes permisos para realizar esta accion.');
      return res.redirect('/');
    }
    return next();
  };
}

// El rol "lector" solo puede ver; "editor" y "admin" pueden crear/editar; solo "admin" administra usuarios/config
const canWrite = requireRole('admin', 'editor');
const isAdmin = requireRole('admin');

module.exports = { requireAuth, requireRole, canWrite, isAdmin };
