// Mantenimiento de la base de datos (solo administradores): estado de
// tablas e indices, ANALYZE/OPTIMIZE y retencion de historicos.
const express = require('express');
const { requireAuth, isSuperAdmin } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const auditService = require('../services/auditService');
const backupService = require('../services/backupService');
const maintenanceService = require('../services/maintenanceService');

const router = express.Router();
router.use(requireAuth, isSuperAdmin, verifyCsrfToken);

// Borrar historial es irreversible: se pide escribir esta frase (no basta un clic).
const PURGE_CONFIRMATION_PHRASE = 'BORRAR HISTORIAL';

router.get('/', async (req, res, next) => {
  try {
    const months = await maintenanceService.retentionMonths();
    const tables = await maintenanceService.tableStatus();
    res.render('maintenance/index', {
      title: 'Mantenimiento de base de datos',
      tables,
      totals: {
        rows: tables.reduce((s, t) => s + t.rows, 0),
        dataBytes: tables.reduce((s, t) => s + t.dataBytes, 0),
        indexBytes: tables.reduce((s, t) => s + t.indexBytes, 0),
        freeBytes: tables.reduce((s, t) => s + t.freeBytes, 0),
        indexes: tables.reduce((s, t) => s + t.indexes.length, 0),
      },
      limits: { max: maintenanceService.MAX_COLUMNS, warn: maintenanceService.WARN_COLUMNS, maxMonths: maintenanceService.MAX_RETENTION_MONTHS },
      months,
      histories: await maintenanceService.historyStatus(months),
      phrase: PURGE_CONFIRMATION_PHRASE,
      results: req.session.maintenanceResults || null,
    });
    delete req.session.maintenanceResults;
  } catch (err) {
    next(err);
  }
});

// action = analizar | optimizar; tabla = una tabla, o vacio para todas.
router.post('/tablas/:action', async (req, res) => {
  const action = req.params.action;
  const table = String(req.body.tabla || '').trim();
  try {
    const results = await maintenanceService.runMaintenance(action, table ? [table] : null);
    const failed = results.filter((r) => !r.ok);
    await auditService.log(req, {
      user: req.session.user, action: `db_${action}`, target: table || 'todas las tablas',
      detail: `${results.length - failed.length} correcta(s), ${failed.length} con error`,
    });
    req.session.maintenanceResults = { action, results };
    if (failed.length) req.flash('error', `${failed.length} tabla(s) con error al ${action}: ${failed.map((f) => f.table).join(', ')}.`);
    else req.flash('success', `Listo: ${results.length} tabla(s) ${action === 'optimizar' ? 'optimizada(s) (tabla e índices reconstruidos)' : 'analizada(s) (estadísticas de índices al día)'}.`);
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/mantenimiento');
});

router.post('/retencion', async (req, res) => {
  try {
    const months = await maintenanceService.setRetentionMonths(req.body.meses);
    await auditService.log(req, { user: req.session.user, action: 'history_retention_set', detail: `${months} mes(es)` });
    req.flash('success', months === 0
      ? 'Retención desactivada: los históricos ya no se borran solos.'
      : `Los históricos se conservarán ${months} mes(es); lo más antiguo se borra cada madrugada.`);
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/mantenimiento#historicos');
});

// Borrado a demanda: frase exacta + copia de seguridad automatica antes.
router.post('/historicos/borrar', async (req, res) => {
  try {
    if (String(req.body.confirmacion || '').trim() !== PURGE_CONFIRMATION_PHRASE) {
      req.flash('error', `Para borrar escriba exactamente la frase: ${PURGE_CONFIRMATION_PHRASE}`);
      return res.redirect('/mantenimiento#historicos');
    }
    const months = parseInt(req.body.meses, 10);
    if (!Number.isInteger(months) || months < 0 || months > maintenanceService.MAX_RETENTION_MONTHS) {
      req.flash('error', 'Indique cuántos meses conservar (0 borra todo el historial).');
      return res.redirect('/mantenimiento#historicos');
    }
    const snapshot = await backupService.snapshot('antes_de_borrar_historial');
    const deleted = await maintenanceService.purgeHistory(months);
    const detail = Object.entries(deleted).map(([k, n]) => `${k}: ${n}`).join(', ');
    await auditService.log(req, {
      user: req.session.user, action: 'history_purged',
      target: months === 0 ? 'todo el historial' : `anterior a ${months} mes(es)`, detail: `${detail}; copia previa: ${snapshot}`,
    });
    req.flash('success', `Historial borrado (${detail}). Antes se guardó una copia de la base en el servidor: uploads/pre_restore_backups/${snapshot}.`);
  } catch (err) {
    req.flash('error', `No se borró nada: ${err.message}`);
  }
  res.redirect('/mantenimiento#historicos');
});

module.exports = router;
