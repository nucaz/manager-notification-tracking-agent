const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { moduleRequired } = require('../middleware/modules');
const { daysUntil, statusFromDays } = require('../services/expirationService');

const router = express.Router();
router.use(requireAuth, moduleRequired('reportes'));

const MODULES = {
  license: {
    label: 'Licencias de software',
    table: 'software_licenses',
    dateField: 'expiration_date',
    nameField: 'product_name',
    columns: ['product_name', 'vendor', 'assigned_to', 'seats', 'cost', 'currency', 'expiration_date'],
  },
  domain: {
    label: 'Dominios',
    table: 'domains',
    dateField: 'expiration_date',
    nameField: 'domain_name',
    columns: ['domain_name', 'registrar', 'responsible', 'renewal_cost', 'currency', 'expiration_date'],
  },
  isp_contract: {
    label: 'Contratos ISP',
    table: 'isp_contracts',
    dateField: 'end_date',
    nameField: 'provider',
    columns: ['provider', 'contract_number', 'bandwidth_down', 'bandwidth_up', 'monthly_cost', 'currency', 'end_date'],
  },
  server: {
    label: 'Servidores y Activos TI',
    table: 'servers',
    dateField: 'support_expiration_date',
    nameField: 'name',
    columns: ['name', 'asset_type', 'environment', 'criticality', 'responsible', 'status', 'support_expiration_date'],
  },
  certificate: {
    label: 'Certificados TLS',
    table: 'certificates',
    dateField: 'expiration_date',
    nameField: 'common_name',
    columns: ['common_name', 'certificate_type', 'issuer', 'responsible', 'cost', 'currency', 'expiration_date'],
  },
};

async function fetchModule(mod, { from, to, status }) {
  const cfg = MODULES[mod];
  const [rows] = await pool.query(`SELECT * FROM ${cfg.table}`);
  let enriched = rows.map((r) => {
    const days = daysUntil(r[cfg.dateField]);
    return { ...r, days_left: days, computed_status: statusFromDays(days) };
  });
  if (from) enriched = enriched.filter((r) => r[cfg.dateField] && r[cfg.dateField] >= from);
  if (to) enriched = enriched.filter((r) => r[cfg.dateField] && r[cfg.dateField] <= to);
  if (status) enriched = enriched.filter((r) => r.computed_status === status);
  enriched.sort((a, b) => (a.days_left ?? 9999) - (b.days_left ?? 9999));
  return { cfg, rows: enriched };
}

router.get('/', async (req, res, next) => {
  try {
    const mod = MODULES[req.query.modulo] ? req.query.modulo : 'license';
    const { from = '', to = '', status = '' } = req.query;
    const { cfg, rows } = await fetchModule(mod, { from, to, status });
    res.render('reports/index', {
      title: 'Reportes y consultas',
      modules: MODULES,
      mod,
      cfg,
      rows,
      filters: { from, to, status },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/exportar.csv', async (req, res, next) => {
  try {
    const mod = MODULES[req.query.modulo] ? req.query.modulo : 'license';
    const { from = '', to = '', status = '' } = req.query;
    const { cfg, rows } = await fetchModule(mod, { from, to, status });

    const headers = [...cfg.columns, 'dias_restantes', 'estado'];
    const lines = [headers.join(',')];
    for (const r of rows) {
      const values = cfg.columns.map((c) => csvEscape(r[c]));
      values.push(csvEscape(r.days_left));
      values.push(csvEscape(r.computed_status));
      lines.push(values.join(','));
    }
    const csv = '﻿' + lines.join('\n'); // BOM para acentos en Excel

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reporte_${mod}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

module.exports = router;
