const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const env = require('./config/env');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const licenseRoutes = require('./routes/licenses');
const domainRoutes = require('./routes/domains');
const ispRoutes = require('./routes/isp');
const attachmentRoutes = require('./routes/attachments');
const networkRoutes = require('./routes/network');
const glpiRoutes = require('./routes/glpi');
const settingsRoutes = require('./routes/settings');
const reportRoutes = require('./routes/reports');
const usersRoutes = require('./routes/users');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(
  session({
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 8, // 8 horas
      secure: env.nodeEnv === 'production' && env.appBaseUrl.startsWith('https'),
    },
  })
);
app.use(flash());

// Variables disponibles en todas las vistas
app.use(async (req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.successMessages = req.flash('success');
  res.locals.errorMessages = req.flash('error');
  res.locals.currentPath = req.path;
  try {
    const settingsService = require('./services/settingsService');
    res.locals.appName = (await settingsService.get('app_name')) || 'Gestion de Licencias';
  } catch (_) {
    res.locals.appName = 'Gestion de Licencias';
  }
  next();
});

app.use('/', authRoutes);
app.use('/', dashboardRoutes);
app.use('/licencias', licenseRoutes);
app.use('/dominios', domainRoutes);
app.use('/isp', ispRoutes);
app.use('/adjuntos', attachmentRoutes);
app.use('/red', networkRoutes);
app.use('/glpi', glpiRoutes);
app.use('/configuracion', settingsRoutes);
app.use('/usuarios', usersRoutes);
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
