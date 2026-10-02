// Recibos de operadoras del modulo Celulares: /celulares/recibos. Mismo
// permiso de modulo que Celulares. La lectura de los archivos y el cruce
// contra el inventario viven en src/services/mobileBillService.js.
const express = require('express');
const fs = require('fs');
const { requireAuth, canWrite } = require('../middleware/auth');
const { moduleRequired } = require('../middleware/modules');
const { verifyCsrfToken } = require('../middleware/csrf');
const { billUploader } = require('../services/uploadService');
const auditService = require('../services/auditService');
const billService = require('../services/mobileBillService');

const router = express.Router();
router.use(requireAuth, moduleRequired('celulares'));

const VISTAS = ['lineas', 'equipos', 'inventario'];
const billLabel = (b) => `Recibo ${b.operadora} ${b.recibo_nro}`;
const soles = (n) => `S/ ${Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// El archivo llega como multipart: multer lo deja en memoria y recien
// entonces se puede verificar el token CSRF. Un archivo rechazado (tipo o
// tamano) vuelve a la lista con el motivo, no a la pagina de error.
function upload(req, res, next) {
  billUploader.single('file')(req, res, (err) => {
    if (!err) return next();
    req.flash('error', err.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera el tamaño máximo permitido.' : err.message);
    res.redirect('/celulares/recibos');
  });
}

async function loadBill(req, res, next) {
  try {
    const bill = await billService.getBill(req.params.id);
    if (!bill) {
      req.flash('error', 'Recibo no encontrado.');
      return res.redirect('/celulares/recibos');
    }
    req.bill = bill;
    next();
  } catch (err) {
    next(err);
  }
}

router.get('/', async (req, res, next) => {
  try {
    res.render('mobileBills/list', { title: 'Recibos de operadoras', items: await billService.listBills() });
  } catch (err) {
    next(err);
  }
});

router.post('/subir', canWrite, upload, verifyCsrfToken, async (req, res, next) => {
  try {
    if (!req.file) {
      req.flash('error', 'Seleccione el archivo del recibo (PDF o Excel).');
      return res.redirect('/celulares/recibos');
    }
    const { id, replaced, parsed } = await billService.importBill({
      buffer: req.file.buffer, filename: req.file.originalname, userId: req.session.user.id,
    });
    const equipos = parsed.charges.filter((c) => c.imei).length;
    await auditService.log(req, {
      user: req.session.user, action: replaced ? 'recibo_celulares_reemplazado' : 'recibo_celulares_cargado', target: billLabel(parsed),
      detail: `${parsed.lines.length} líneas, ${equipos} equipos con cuota, total ${soles(parsed.total_pagar)} (${parsed.origen}: ${req.file.originalname})`,
    });
    req.flash('success', `${replaced ? 'Recibo reemplazado' : 'Recibo cargado'}: ${parsed.lines.length} líneas y ${equipos} equipos con cuota.`);
    res.redirect(`/celulares/recibos/${id}`);
  } catch (err) {
    if (!(err instanceof billService.BillFormatError)) return next(err);
    req.flash('error', err.message);
    res.redirect('/celulares/recibos');
  }
});

router.get('/:id(\\d+)', loadBill, async (req, res, next) => {
  try {
    const rec = await billService.reconcile(req.bill);
    const vista = VISTAS.includes(req.query.vista) ? req.query.vista : 'lineas';
    const resultado = billService.RESULTS.includes(req.query.resultado) ? req.query.resultado : '';
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    let rows = rec[vista];
    if (resultado) rows = rows.filter((r) => r.resultado === resultado);
    if (q) {
      rows = rows.filter((r) => [r.phone_number, r.imei, r.plan, r.modelo, r.folio, r.holder, r.area, r.sede, r.asset_code, r.detalle]
        .some((v) => v && String(v).toLowerCase().includes(q)));
    }
    res.render('mobileBills/detail', {
      title: billLabel(req.bill), bill: req.bill, stats: rec.stats, otrosCargos: rec.otrosCargos, rows, vista, resultado, q,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id(\\d+)/exportar.xlsx', loadBill, async (req, res, next) => {
  try {
    const buffer = await billService.buildWorkbook(req.bill, await billService.reconcile(req.bill));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="conciliacion_${req.bill.operadora.toLowerCase()}_${req.bill.recibo_nro}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    next(err);
  }
});

router.get('/:id(\\d+)/archivo', loadBill, (req, res) => {
  const file = billService.storedPath(req.bill);
  if (!file || !fs.existsSync(file)) {
    req.flash('error', 'El archivo original de este recibo ya no está guardado.');
    return res.redirect(`/celulares/recibos/${req.bill.id}`);
  }
  res.download(file, req.bill.archivo_nombre || `recibo_${req.bill.recibo_nro}`);
});

// Crea como chips en stock los numeros facturados que no estan en el
// inventario: todos, o solo los marcados en la tabla (campo `numbers`,
// separados por coma: una sola variable, sin limite de cantidad de campos).
router.post('/:id(\\d+)/crear-chips', canWrite, verifyCsrfToken, loadBill, async (req, res, next) => {
  try {
    const todos = req.body.todos === '1';
    const numbers = todos ? null : String(req.body.numbers || '').split(',').map((n) => n.trim()).filter((n) => /^\d+$/.test(n));
    if (!todos && !numbers.length) {
      req.flash('error', 'Marque al menos un número para registrarlo como chip.');
      return res.redirect(`/celulares/recibos/${req.bill.id}?vista=lineas&resultado=faltante`);
    }
    const created = await billService.createMissingLines(req.bill, numbers, req.session.user.id);
    if (created) {
      await auditService.log(req, {
        user: req.session.user, action: 'chips_creados_desde_recibo', target: billLabel(req.bill),
        detail: `${created} chip(s) registrados en stock con operadora, plan y costo del recibo`,
      });
    }
    req.flash('success', created
      ? `${created} chip(s) registrados en stock, con la operadora, el plan y el costo mensual del recibo.`
      : 'No había números faltantes que registrar.');
    res.redirect(`/celulares/recibos/${req.bill.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/actualizar-planes', canWrite, verifyCsrfToken, loadBill, async (req, res, next) => {
  try {
    const changed = await billService.syncPlans(req.bill);
    if (changed) {
      await auditService.log(req, {
        user: req.session.user, action: 'chips_actualizados_desde_recibo', target: billLabel(req.bill),
        detail: `${changed} chip(s): plan, costo mensual y operadora (si estaba vacía) tomados del recibo`,
      });
    }
    req.flash('success', changed
      ? `${changed} chip(s) actualizados con el plan y el costo mensual de este recibo.`
      : 'Los chips ya tenían el plan y el costo de este recibo.');
    res.redirect(`/celulares/recibos/${req.bill.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/eliminar', canWrite, verifyCsrfToken, loadBill, async (req, res, next) => {
  try {
    await billService.deleteBill(req.bill.id);
    await auditService.log(req, {
      user: req.session.user, action: 'recibo_celulares_eliminado', target: billLabel(req.bill),
      detail: `Total ${soles(req.bill.total_pagar)}; los chips y celulares del inventario no se tocan`,
    });
    req.flash('success', `${billLabel(req.bill)} eliminado. El inventario no cambió.`);
    res.redirect('/celulares/recibos');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
