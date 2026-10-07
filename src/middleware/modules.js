// Permisos por modulo: que modulos puede ABRIR cada rol configurable
// (editor, lector). admin siempre ve todo - nunca aparece en la tabla,
// para que nunca pueda auto-bloquearse la pantalla de Permisos.
//
// Esto SOLO protege las rutas de vista de cada modulo. Las rutas de
// escritura (crear/editar/eliminar) siguen con su propio canWrite/isAdmin
// de siempre, sin tocar - este sistema nunca amplia lo que un rol ya
// podia hacer, solo decide que pantallas puede abrir. Un lector con un
// modulo habilitado sigue sin poder escribir nada en el (canWrite se lo
// sigue negando); un editor al que se le apaga un modulo simplemente ya
// no puede ni entrar a verlo.
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
  red: 'Red (topologías y diagramas)',
  glpi_inventario: 'Inventario GLPI',
  reportes: 'Reportes',
  asistente: 'Asistente IA (preguntas a Gemini)',
  devops: 'DevOps Sidecar (repositorios, respaldos y auditoría de código)',
};

const CONFIGURABLE_ROLES = ['editor', 'lector'];

// Que podia abrir cada rol ANTES de que existiera este sistema: hoy
// cualquier usuario autenticado puede ENTRAR a ver cualquier modulo (las
// rutas de escritura ya estaban protegidas aparte). Por eso el default es
// "todo habilitado" para editor y lector - instalar esta tabla no le
// quita acceso a nadie hasta que un admin desmarque algo en /permisos.
const DEFAULT_MODULE_ACCESS = Object.keys(MODULES).reduce((acc, key) => {
  acc[key] = { editor: true, lector: true };
  return acc;
}, {});
// DevOps es la excepcion: dentro de ese modulo no hay roles (quien entra
// puede restaurar o borrar), y antes solo lo veia un administrador. Queda
// apagado hasta que un admin lo habilite a proposito.
DEFAULT_MODULE_ACCESS.devops = { editor: false, lector: false };
// El directorio activo muestra quien es administrador del dominio: apagado
// para editor y lector hasta que un superadmin lo habilite.
DEFAULT_MODULE_ACCESS.directorio = { editor: false, lector: false };

async function moduleEnabled(role, moduleKey) {
  if (role === 'superadmin') return true;
  // admin: todos los modulos menos DevOps Sidecar (dentro guarda credenciales y restaura).
  if (role === 'admin') return moduleKey !== 'devops';
  if (!CONFIGURABLE_ROLES.includes(role)) return false;
  const [rows] = await pool.query(
    'SELECT enabled FROM role_modules WHERE role = ? AND module = ? LIMIT 1',
    [role, moduleKey]
  );
  if (rows.length > 0) return !!rows[0].enabled;
  return !!(DEFAULT_MODULE_ACCESS[moduleKey] || {})[role];
}

function moduleRequired(moduleKey) {
  return async function (req, res, next) {
    if (!req.session.user) {
      req.flash('error', 'Debes iniciar sesion para continuar.');
      return res.redirect('/login');
    }
    try {
      const allowed = await moduleEnabled(req.session.user.role, moduleKey);
      if (!allowed) {
        req.flash('error', 'No tienes acceso a este módulo. Pide a un administrador que te lo habilite en Permisos.');
        return res.redirect('/');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// realModuleEnabled: la misma funcion, para quien necesite la original aunque
// otra parte (una prueba) reemplace moduleEnabled.
module.exports = { MODULES, CONFIGURABLE_ROLES, DEFAULT_MODULE_ACCESS, moduleEnabled, moduleRequired, realModuleEnabled: moduleEnabled };
