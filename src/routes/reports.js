const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { moduleRequired } = require('../middleware/modules');
const reportService = require('../services/reportService');
const { buildPdf } = require('../services/reportPdf');

const router = express.Router();
router.use(requireAuth, moduleRequired('reportes'));

// El reporte pedido (?modulo=), entre los que este usuario puede abrir.
function pick(req, res) {
  const reports = reportService.available(req.session.user, res.locals.enabledModules);
  const mod = reports[req.query.modulo] ? req.query.modulo : Object.keys(reports)[0];
  return { reports, mod, report: reports[mod] };
}

// Parametros que acompanan a los enlaces de exportacion: los mismos
// filtros que se estan viendo.
function exportQuery(mod, query, selects) {
  const p = new URLSearchParams({ modulo: mod });
  ['q', 'from', 'to', 'status', 'barras'].forEach((k) => { if (query[k]) p.set(k, String(query[k])); });
  selects.forEach((s) => { if (s.value) p.set(s.name, s.value); });
  return p.toString();
}

router.get('/', async (req, res, next) => {
  try {
    const { reports, mod, report } = pick(req, res);
    const base = {
      title: 'Reportes y consultas', reports, mod, report,
      filters: { q: req.query.q || '', from: req.query.from || '', to: req.query.to || '', status: req.query.status || '' },
    };
    let result;
    try {
      result = await reportService.run(report, req.query);
    } catch (err) {
      // GLPI o el sidecar no respondieron: la pantalla se muestra igual, con el motivo.
      return res.render('reports/index', {
        ...base, rows: [], selects: [], barcode: null, summary: { total: 0, groups: [] }, loadError: err.message, exportQuery: `modulo=${mod}`,
      });
    }
    res.render('reports/index', { ...base, ...result, loadError: null, exportQuery: exportQuery(mod, req.query, result.selects) });
  } catch (err) {
    next(err);
  }
});

const FORMATS = {
  csv: {
    type: 'text/csv; charset=utf-8',
    build: (report, result) => reportService.buildCsv(report, result.rows),
  },
  xlsx: {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    build: (report, result, meta) => reportService.buildWorkbook(report, result, meta),
  },
  pdf: {
    type: 'application/pdf',
    build: (report, result, meta) => buildPdf({
      title: `Reporte: ${report.label}`, appName: meta.appName, generatedBy: meta.generatedBy, generatedAt: meta.generatedAt,
      filtersText: result.filtersText, summary: result.summary, columns: report.print, rows: result.rows, barcode: result.barcode,
    }),
  },
};

router.get('/exportar.:formato', async (req, res, next) => {
  const format = FORMATS[req.params.formato];
  if (!format) return next();
  const { mod, report } = pick(req, res);
  try {
    const result = await reportService.run(report, req.query);
    const user = req.session.user || {};
    const meta = { appName: res.locals.appName || 'Gestión de Licencias', generatedBy: user.full_name || user.email || 'usuario', generatedAt: reportService.now() };
    const body = await format.build(report, result, meta);
    res.setHeader('Content-Type', format.type);
    res.setHeader('Content-Disposition', `attachment; filename="reporte_${mod}_${new Date().toISOString().slice(0, 10)}.${req.params.formato}"`);
    res.send(body);
  } catch (err) {
    req.flash('error', `No se pudo generar el reporte "${report.label}": ${err.message}`);
    res.redirect(`/reportes?modulo=${encodeURIComponent(mod)}`);
  }
});

module.exports = router;
