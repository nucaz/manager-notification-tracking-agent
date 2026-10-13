// Permisos por modulo, en dos niveles:
//
// 1. Por PERFIL (tabla role_modules, pantalla Permisos): que modulos puede
//    ABRIR cada perfil configurable (admin, editor, lector). El superadmin
//    siempre ve todo y nunca aparece en la tabla, para que nunca pueda
//    bloquearse a si mismo. Dentro de un modulo, lo que se puede ESCRIBIR lo
//    decide el perfil (canWrite / isAdmin): un lector no escribe.
//
// 2. Por USUARIO (tabla user_modules, ficha del usuario): un permiso especial
//    en un modulo que MANDA sobre su perfil: sin acceso, solo ver, o ver y
//    editar. Asi un lector puede editar en un modulo concreto, o un editor
//    quedar solo de consulta en otro. No aplica al superadmin. "Ver y editar"
//    nunca da las acciones de administrador (isAdmin sigue pidiendo ese perfil).
//
// moduleRequired deja en la peticion el permiso especial (req.moduleOverride)
// y el perfil con el que se comporta en ese modulo (req.effectiveRole, y
// currentUser.role en las vistas, que deciden que botones mostrar).
const pool = require('../db/pool');

const MODULES = {
  licencias: 'Licencias',
  dominios: 'Dominios',
  isp: 'Contratos ISP',
  servidores: 'Servidores y Activos TI',
  certificados: 'Certificados TLS',
  celulares: 'Celulares',
  empleados: 'Empleados',
  solicitudes: 'Solicitudes (quién pidió qué, en todos los módulos)',
  clinic: 'Usuarios de Clinic',
  m365: 'Cuentas de Microsoft 365',
  directorio: 'Directorio activo (usuarios, grupos, equipos y DNS del dominio)',
  red: 'Red (diagramas, equipos, VLAN y herramientas)',
  glpi_inventario: 'Inventario GLPI',
  reportes: 'Reportes',
  asistente: 'Asistente IA (preguntas a Gemini)',
  devops: 'DevOps Sidecar (repositorios, respaldos y auditoría de código)',
};

const CONFIGURABLE_ROLES = ['admin', 'editor', 'lector'];
const ACCESS = { none: 'Sin acceso', view: 'Solo ver', edit: 'Ver y editar' };

// Que podia abrir cada rol ANTES de que existiera este sistema: hoy
// cualquier usuario autenticado puede ENTRAR a ver cualquier modulo (las
// rutas de escritura ya estaban protegidas aparte). Por eso el default es
// "todo habilitado" para editor y lector - instalar esta tabla no le
// quita acceso a nadie hasta que un admin desmarque algo en /permisos.
const DEFAULT_MODULE_ACCESS = Object.keys(MODULES).reduce((acc, key) => {
  acc[key] = { admin: true, editor: true, lector: true };
  return acc;
}, {});
// DevOps es la excepcion: dentro de ese modulo no hay roles (quien entra
// puede restaurar o borrar), y antes solo lo veia un administrador. Queda
// apagado hasta que un admin lo habilite a proposito.
DEFAULT_MODULE_ACCESS.devops = { admin: false, editor: false, lector: false };
// El directorio activo muestra quien es administrador del dominio: apagado
// para editor y lector hasta que un superadmin lo habilite.
DEFAULT_MODULE_ACCESS.directorio = { admin: true, editor: false, lector: false };

async function moduleEnabled(role, moduleKey) {
  if (role === 'superadmin') return true;
  if (!CONFIGURABLE_ROLES.includes(role)) return false;
  const [rows] = await pool.query(
    'SELECT enabled FROM role_modules WHERE role = ? AND module = ? LIMIT 1',
    [role, moduleKey]
  );
  if (rows.length > 0) return !!rows[0].enabled;
  return !!(DEFAULT_MODULE_ACCESS[moduleKey] || {})[role];
}

// Permisos especiales de un usuario: { modulo: 'none' | 'view' | 'edit' }.
async function userOverrides(userId) {
  const out = {};
  if (!Number(userId)) return out;
  const [rows] = await pool.query('SELECT module, access FROM user_modules WHERE user_id = ?', [Number(userId)]);
  for (const r of rows) if (MODULES[r.module] && ACCESS[r.access]) out[r.module] = r.access;
  return out;
}

// Lo que un usuario puede hacer en un modulo: { level: 'none'|'view'|'edit', override }.
// override es su permiso especial (o null si manda el perfil).
async function moduleAccess(user, moduleKey, overrides) {
  if (!user) return { level: 'none', override: null };
  if (user.role === 'superadmin') return { level: 'edit', override: null };
  const ov = (overrides || await userOverrides(user.id))[moduleKey] || null;
  if (ov) return { level: ov, override: ov };
  // Por module.exports: una prueba puede reemplazar moduleEnabled.
  if (!(await module.exports.moduleEnabled(user.role, moduleKey))) return { level: 'none', override: null };
  return { level: user.role === 'lector' ? 'view' : 'edit', override: null };
}
async function moduleAllowed(user, moduleKey, overrides) {
  return (await moduleAccess(user, moduleKey, overrides)).level !== 'none';
}
// El perfil con el que el usuario se comporta dentro de un modulo donde tiene permiso especial.
function effectiveRole(role, override) {
  if (override === 'view') return 'lector';
  if (override === 'edit' && role === 'lector') return 'editor';
  return role;
}

function moduleRequired(moduleKey) {
  return async function (req, res, next) {
    if (!req.session.user) {
      req.flash('error', 'Debes iniciar sesion para continuar.');
      return res.redirect('/login');
    }
    try {
      const user = req.session.user;
      const a = await moduleAccess(user, moduleKey);
      if (a.level === 'none') {
        req.flash('error', 'No tienes acceso a este módulo. Pide a un administrador que te lo habilite en Permisos.');
        return res.redirect('/');
      }
      req.moduleKey = moduleKey;
      req.moduleOverride = a.override;
      req.effectiveRole = effectiveRole(user.role, a.override);
      // Las vistas deciden los botones por currentUser.role: dentro del modulo ven el perfil efectivo.
      if (a.override && res.locals.currentUser) res.locals.currentUser = { ...res.locals.currentUser, role: req.effectiveRole };
      next();
    } catch (err) {
      next(err);
    }
  };
}

// realModuleEnabled: la misma funcion, para quien necesite la original aunque
// otra parte (una prueba) reemplace moduleEnabled.
module.exports = { MODULES, CONFIGURABLE_ROLES, DEFAULT_MODULE_ACCESS, ACCESS, moduleEnabled, moduleRequired, realModuleEnabled: moduleEnabled,
  userOverrides, moduleAccess, moduleAllowed, effectiveRole };
