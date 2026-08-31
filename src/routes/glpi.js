const express = require('express');
const pool = require('../db/pool');
const { requireAuth, canWrite } = require('../middleware/auth');
const glpiClient = require('../services/glpiClient');

const router = express.Router();
router.use(requireAuth);

// Prueba de conexion (usada desde la pantalla de Configuracion)
router.post('/probar-conexion', canWrite, async (req, res) => {
  try {
    await glpiClient.testConnection();
    req.flash('success', 'Conexion con GLPI exitosa.');
  } catch (err) {
    req.flash('error', `No se pudo conectar con GLPI: ${err.message}`);
  }
  res.redirect('/configuracion');
});

// Busqueda de equipos GLPI (usada por el autocompletar en los formularios, via fetch/JSON)
router.get('/api/equipos', async (req, res) => {
  try {
    const results = await glpiClient.searchComputers(req.query.q || '', 15);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.get('/api/entidades', async (req, res) => {
  try {
    const results = await glpiClient.listEntities(100);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

const ENTITY_TABLES = {
  license: { table: 'software_licenses' },
  domain: { table: 'domains' },
  isp_contract: { table: 'isp_contracts' },
};

// Sincroniza un registro local (licencia/dominio/contrato ISP) como Contrato en GLPI
router.post('/sincronizar/:entityType/:id', canWrite, async (req, res, next) => {
  try {
    const { entityType, id } = req.params;
    const config = ENTITY_TABLES[entityType];
    if (!config) {
      req.flash('error', 'Tipo de entidad invalido.');
      return res.redirect('back');
    }
    const [rows] = await pool.query(`SELECT * FROM ${config.table} WHERE id = ?`, [id]);
    const item = rows[0];
    if (!item) {
      req.flash('error', 'Registro no encontrado.');
      return res.redirect('back');
    }

    let name, beginDate, notes;
    if (entityType === 'license') {
      name = `Licencia: ${item.product_name}`;
      beginDate = item.start_date || item.purchase_date;
      notes = item.notes || '';
    } else if (entityType === 'domain') {
      name = `Dominio: ${item.domain_name}`;
      beginDate = item.registration_date;
      notes = item.notes || '';
    } else {
      name = `Contrato ISP: ${item.provider} (${item.contract_number || 's/n'})`;
      beginDate = item.start_date;
      notes = item.notes || '';
    }

    const result = await glpiClient.createContract({ name, notes, begin_date: beginDate });
    const glpiId = result && result.id;
    if (glpiId) {
      await pool.query(`UPDATE ${config.table} SET glpi_contract_id = ? WHERE id = ?`, [glpiId, id]);
    }
    req.flash('success', `Registrado en GLPI como contrato #${glpiId || '?'}.`);
    res.redirect('back');
  } catch (err) {
    req.flash('error', `Error al sincronizar con GLPI: ${err.message}`);
    res.redirect('back');
  }
});

module.exports = router;
