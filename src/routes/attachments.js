const express = require('express');
const path = require('path');
const fs = require('fs');
const pool = require('../db/pool');
const { requireAuth, canWrite } = require('../middleware/auth');
const { uploader, DIRS } = require('../services/uploadService');
const geminiClient = require('../services/geminiClient');

const router = express.Router();
router.use(requireAuth);

const ENTITY_TABLES = {
  license: { table: 'software_licenses', redirectBase: '/licencias' },
  domain: { table: 'domains', redirectBase: '/dominios' },
  isp_contract: { table: 'isp_contracts', redirectBase: '/isp' },
};

// Campos del registro principal que "Aplicar al registro" puede completar
// con los datos extraidos por IA. Solo se llenan si el campo esta vacio.
const APPLY_MAP = {
  license: { amountField: 'cost', dateField: 'expiration_date', providerField: 'vendor' },
  domain: { amountField: 'renewal_cost', dateField: 'expiration_date', providerField: 'registrar' },
  isp_contract: { amountField: 'monthly_cost', dateField: 'end_date', providerField: null },
};

const upload = uploader('adjuntos');

// Nota: esta ruta vive bajo /subir/ (en vez de /:entityType/:entityId a secas)
// a proposito, para que su forma de 3 segmentos nunca choque con rutas de 2
// segmentos como /:id/extraer, /:id/aplicar o /eliminar/:id — Express hace
// coincidir por orden de registro, no por especificidad, asi que dos rutas
// con la misma forma (parametro/parametro) pueden "taparse" entre si.
router.post('/subir/:entityType/:entityId', canWrite, upload.single('file'), async (req, res, next) => {
  try {
    const { entityType, entityId } = req.params;
    const config = ENTITY_TABLES[entityType];
    if (!config) {
      req.flash('error', 'Tipo de entidad invalido.');
      return res.redirect('/');
    }
    const [exists] = await pool.query(`SELECT id FROM ${config.table} WHERE id = ?`, [entityId]);
    if (!exists[0]) {
      req.flash('error', 'El registro asociado no existe.');
      return res.redirect(config.redirectBase);
    }
    if (!req.file) {
      req.flash('error', 'Debes seleccionar un archivo.');
      return res.redirect(`${config.redirectBase}/${entityId}`);
    }
    await pool.query(
      `INSERT INTO attachments
        (entity_type, entity_id, doc_type, original_name, stored_path, mime_type, size_bytes, description, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entityType,
        entityId,
        req.body.doc_type || 'otro',
        req.file.originalname,
        req.file.filename,
        req.file.mimetype,
        req.file.size,
        req.body.description || null,
        req.session.user.id,
      ]
    );
    req.flash('success', 'Archivo adjuntado correctamente.');
    res.redirect(`${config.redirectBase}/${entityId}`);
  } catch (err) {
    next(err);
  }
});

router.get('/descargar/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM attachments WHERE id = ?', [req.params.id]);
    const attachment = rows[0];
    if (!attachment) {
      req.flash('error', 'Archivo no encontrado.');
      return res.redirect('/');
    }
    const filePath = path.join(DIRS.adjuntos, attachment.stored_path);
    if (!fs.existsSync(filePath)) {
      req.flash('error', 'El archivo ya no existe en el servidor.');
      return res.redirect('/');
    }
    res.download(filePath, attachment.original_name);
  } catch (err) {
    next(err);
  }
});

// Extrae datos de una factura/recibo ya adjunto usando IA (Gemini)
router.post('/:id/extraer', canWrite, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM attachments WHERE id = ?', [req.params.id]);
    const attachment = rows[0];
    if (!attachment) {
      req.flash('error', 'Archivo no encontrado.');
      return res.redirect('back');
    }
    const config = ENTITY_TABLES[attachment.entity_type];
    const redirectTo = `${config.redirectBase}/${attachment.entity_id}`;
    const filePath = path.join(DIRS.adjuntos, attachment.stored_path);
    if (!fs.existsSync(filePath)) {
      req.flash('error', 'El archivo ya no existe en el servidor.');
      return res.redirect(redirectTo);
    }

    try {
      const buffer = await fs.promises.readFile(filePath);
      const data = await geminiClient.extractInvoiceData(buffer, attachment.mime_type);
      await pool.query(
        `UPDATE attachments SET
           extraction_status = 'completado', extraction_error = NULL,
           extracted_amount = ?, extracted_currency = ?, extracted_concept = ?,
           extracted_provider = ?, extracted_invoice_number = ?, extracted_tax_id = ?,
           extracted_issue_date = ?, extracted_due_date = ?, extracted_site = ?,
           extracted_at = NOW()
         WHERE id = ?`,
        [
          data.monto, data.moneda, data.concepto, data.proveedor,
          data.numero_factura, data.ruc_proveedor, data.fecha_emision,
          data.fecha_vencimiento, data.local, attachment.id,
        ]
      );
      req.flash('success', 'Datos extraídos con IA correctamente. Revisa y aplica al registro si están correctos.');
    } catch (err) {
      await pool.query(
        `UPDATE attachments SET extraction_status = 'error', extraction_error = ? WHERE id = ?`,
        [err.message, attachment.id]
      );
      req.flash('error', `No se pudo extraer los datos con IA: ${err.message}`);
    }
    res.redirect(redirectTo);
  } catch (err) {
    next(err);
  }
});

// Copia los datos extraidos por IA al registro principal (solo campos vacios)
router.post('/:id/aplicar', canWrite, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM attachments WHERE id = ?', [req.params.id]);
    const attachment = rows[0];
    if (!attachment) {
      req.flash('error', 'Archivo no encontrado.');
      return res.redirect('back');
    }
    const config = ENTITY_TABLES[attachment.entity_type];
    const mapping = APPLY_MAP[attachment.entity_type];
    const redirectTo = `${config.redirectBase}/${attachment.entity_id}`;

    if (attachment.extraction_status !== 'completado') {
      req.flash('error', 'Este adjunto todavía no tiene datos extraídos por IA.');
      return res.redirect(redirectTo);
    }

    const [entityRows] = await pool.query(`SELECT * FROM ${config.table} WHERE id = ?`, [
      attachment.entity_id,
    ]);
    const entity = entityRows[0];
    if (!entity) {
      req.flash('error', 'El registro asociado ya no existe.');
      return res.redirect(config.redirectBase);
    }

    const updates = {};
    if (mapping.amountField && !entity[mapping.amountField] && attachment.extracted_amount !== null) {
      updates[mapping.amountField] = attachment.extracted_amount;
      if (attachment.extracted_currency && !entity.currency) {
        updates.currency = attachment.extracted_currency;
      }
    }
    if (mapping.dateField && !entity[mapping.dateField] && attachment.extracted_due_date) {
      updates[mapping.dateField] = attachment.extracted_due_date;
    }
    if (
      mapping.providerField &&
      !entity[mapping.providerField] &&
      attachment.extracted_provider
    ) {
      updates[mapping.providerField] = attachment.extracted_provider;
    }
    if ('site_location' in entity && !entity.site_location && attachment.extracted_site) {
      updates.site_location = attachment.extracted_site;
    }

    if (Object.keys(updates).length === 0) {
      req.flash(
        'error',
        'No hay campos vacíos que completar (el registro ya tiene esos datos, o la IA no extrajo valores nuevos).'
      );
      return res.redirect(redirectTo);
    }

    const cols = Object.keys(updates);
    const values = Object.values(updates);
    const setClause = cols.map((c) => `${c} = ?`).join(', ');
    await pool.query(`UPDATE ${config.table} SET ${setClause} WHERE id = ?`, [
      ...values,
      attachment.entity_id,
    ]);
    await pool.query('UPDATE attachments SET applied_at = NOW() WHERE id = ?', [attachment.id]);

    req.flash('success', `Datos aplicados al registro: ${cols.join(', ')}.`);
    res.redirect(redirectTo);
  } catch (err) {
    next(err);
  }
});

router.post('/eliminar/:id', canWrite, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM attachments WHERE id = ?', [req.params.id]);
    const attachment = rows[0];
    if (!attachment) {
      req.flash('error', 'Archivo no encontrado.');
      return res.redirect('back');
    }
    const filePath = path.join(DIRS.adjuntos, attachment.stored_path);
    await pool.query('DELETE FROM attachments WHERE id = ?', [req.params.id]);
    fs.promises.unlink(filePath).catch(() => {});
    req.flash('success', 'Archivo eliminado.');
    const config = ENTITY_TABLES[attachment.entity_type];
    res.redirect(`${config.redirectBase}/${attachment.entity_id}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
