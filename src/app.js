const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const flash = require('connect-flash');
const env = require('./config/env');
const { ensureCsrfToken } = require('./middleware/csrf');

const authRoutes = require('./routes/auth');
const twoFactorRoutes = require('./routes/twoFactor');
const dashboardRoutes = require('./routes/dashboard');
const licenseRoutes = require('./routes/licenses');
const domainRoutes = require('./routes/domains');
const ispRoutes = require('./routes/isp');
const serverRoutes = require('./routes/servers');
const certificateRoutes = require('./routes/certificates');
const mobileDeviceRoutes = require('./routes/mobileDevices');
const employeeRoutes = require('./routes/employees');
const attachmentRoutes = require('./routes/attachments');
const networkRoutes = require('./routes/network');
const glpiRoutes = require('./routes/glpi');
const settingsRoutes = require('./routes/settings');
const catalogRoutes = require('./routes/catalogs');
const reportRoutes = require('./routes/reports');
const usersRoutes = require('./routes/users');
const auditRoutes = require('./routes/audit');
const permissionsRoutes = require('./routes/permissions');
const accountRoutes = require('./routes/account');
const whatsappWebhookRoutes = require('./routes/whatsappWebhook');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);

// Webhook de WhatsApp: montado ANTES de los parsers globales, con su
// propio parser que ademas guarda el body crudo (req.rawBody) - hace
// falta sin modificar para verificar la firma HMAC de Meta. No lleva
// sesion/CSRF: lo llama Meta, no un usuario logueado.
app.use(
  '/webhook/whatsapp',
  express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }),
  whatsappWebhookRoutes
);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(
  session({
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 8, // 8 horas
      secure: env.nodeEnv === 'production' && env.appBaseUrl.startsWith('https'),
    },
  })
);
app.use(flash());
app.use(ensureCsrfToken);

// Variables disponibles en todas las vistas
app.use(async (req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.successMessages = req.flash('success');
  res.locals.errorMessages = req.flash('error');
  res.locals.currentPath = req.path;
  res.locals.currentHost = req.hostname;
  try {
    const settingsService = require('./services/settingsService');
    res.locals.appName = (await settingsService.get('app_name')) || 'Gestion de Licencias';
  } catch (_) {
    res.locals.appName = 'Gestion de Licencias';
  }

  // Para ocultar del menu los modulos que este rol no tiene habilitados
  // (moduleRequired ya protege la ruta en si; esto es solo para no
  // mostrar un link muerto). admin siempre ve todo.
  res.locals.enabledModules = {};
  if (req.session.user) {
    const { MODULES, moduleEnabled } = require('./middleware/modules');
    if (req.session.user.role === 'admin') {
      for (const key of Object.keys(MODULES)) res.locals.enabledModules[key] = true;
    } else {
      try {
        await Promise.all(
          Object.keys(MODULES).map(async (key) => {
            res.locals.enabledModules[key] = await moduleEnabled(req.session.user.role, key);
          })
        );
      } catch (_) {
        // si falla la consulta, no ocultar nada de mas - moduleRequired sigue protegiendo la ruta real
        for (const key of Object.keys(MODULES)) res.locals.enabledModules[key] = true;
      }
    }
  }

  next();
});

app.use('/', authRoutes);
app.use('/2fa', twoFactorRoutes);
app.use('/', dashboardRoutes);
app.use('/licencias', licenseRoutes);
app.use('/dominios', domainRoutes);
app.use('/isp', ispRoutes);
app.use('/servidores', serverRoutes);
app.use('/certificados', certificateRoutes);
app.use('/celulares', mobileDeviceRoutes);
app.use('/empleados', employeeRoutes);
app.use('/adjuntos', attachmentRoutes);
app.use('/red', networkRoutes);
app.use('/glpi', glpiRoutes);
app.use('/configuracion/catalogos', catalogRoutes);
app.use('/configuracion', settingsRoutes);
app.use('/usuarios', usersRoutes);
app.use('/auditoria', auditRoutes);
app.use('/permisos', permissionsRoutes);
app.use('/mi-cuenta', accountRoutes);
app.use('/reportes', reportRoutes);

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Pagina no encontrada',
    message: 'La pagina que buscas no existe.',
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', {
    title: 'Error',
    message: env.nodeEnv === 'production' ? 'Ocurrio un error inesperado.' : err.message,
  });
});

module.exports = app;
