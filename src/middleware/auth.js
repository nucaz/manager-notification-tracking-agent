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

// Roles de la aplicacion:
//   lector     -> ve toda la aplicacion, no cambia nada
//   editor     -> crea y edita en los modulos
//   admin      -> gestiona los modulos (catalogos, auditoria, solicitudes...),
//                 pero NO lo critico: credenciales de conexion, usuarios,
//                 permisos, respaldos, mantenimiento de la base, DevOps
//   superadmin -> todo el control de la aplicacion
const ROLES = {
  superadmin: 'Superadministrador', admin: 'Administrador', editor: 'Editor', lector: 'Lector',
};
const ADMIN_ROLES = ['superadmin', 'admin'];
const isAdminRole = (role) => ADMIN_ROLES.includes(role);
const isSuperRole = (role) => role === 'superadmin';
const canWrite = requireRole('superadmin', 'admin', 'editor');
const isAdmin = requireRole(...ADMIN_ROLES);
const isSuperAdmin = requireRole('superadmin');

module.exports = { requireAuth, requireRole, canWrite, isAdmin, isSuperAdmin, ROLES, ADMIN_ROLES, isAdminRole, isSuperRole };
