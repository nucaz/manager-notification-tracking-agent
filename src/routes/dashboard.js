const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { daysUntil, statusFromDays } = require('../services/expirationService');

const router = express.Router();

function enrich(rows, dateField, type, label, url) {
  return rows.map((r) => {
    const days = daysUntil(r[dateField]);
    return {
      type,
      label,
      name: r.product_name || r.domain_name || r.provider,
      days_left: days,
      computed_status: statusFromDays(days),
      expiration_date: r[dateField],
      url: `${url}/${r.id}`,
    };
  });
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const [licenses] = await pool.query('SELECT * FROM software_licenses');
    const [domains] = await pool.query('SELECT * FROM domains');
    const [isp] = await pool.query('SELECT * FROM isp_contracts');

    const all = [
      ...enrich(licenses, 'expiration_date', 'license', 'Licencia', '/licencias'),
      ...enrich(domains, 'expiration_date', 'domain', 'Dominio', '/dominios'),
      ...enrich(isp, 'end_date', 'isp_contract', 'Contrato ISP', '/isp'),
    ];

    const counts = {
      total: all.length,
      vencido: all.filter((i) => i.computed_status === 'vencido').length,
      por_vencer: all.filter((i) => i.computed_status === 'por_vencer').length,
      activo: all.filter((i) => i.computed_status === 'activo').length,
      licenses: licenses.length,
      domains: domains.length,
      isp: isp.length,
    };

    const upcoming = all
      .filter((i) => i.computed_status === 'vencido' || i.computed_status === 'por_vencer')
      .sort((a, b) => (a.days_left ?? 9999) - (b.days_left ?? 9999))
      .slice(0, 15);

    const [diagramCountRows] = await pool.query('SELECT COUNT(*) AS c FROM network_diagrams');

    res.render('dashboard', {
      title: 'Panel principal',
      counts,
      upcoming,
      diagramCount: diagramCountRows[0].c,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
