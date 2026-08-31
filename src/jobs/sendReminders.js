// Job de recordatorios de vencimiento.
// Revisa licencias, dominios y contratos ISP; cuando el numero de dias
// restantes coincide exactamente con uno de los umbrales configurados
// (ej. 90, 60, 30, 15, 7, 1), envia un correo y registra el envio en
// `reminder_log` para no repetirlo el mismo dia/umbral.
const cron = require('node-cron');
const pool = require('../db/pool');
const mailer = require('../services/mailer');
const settingsService = require('../services/settingsService');
const { daysUntil } = require('../services/expirationService');

const MODULES = [
  { type: 'license', table: 'software_licenses', dateField: 'expiration_date', nameField: 'product_name', label: 'Licencia de software' },
  { type: 'domain', table: 'domains', dateField: 'expiration_date', nameField: 'domain_name', label: 'Dominio' },
  { type: 'isp_contract', table: 'isp_contracts', dateField: 'end_date', nameField: 'provider', label: 'Contrato ISP' },
];

function buildEmail(items) {
  const rows = items
    .map(
      (i) => `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${i.label}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${i.name}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${i.expiration_date}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:bold;">${i.days_left} dia(s)</td>
      </tr>`
    )
    .join('');

  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;">
      <h2>Recordatorio de vencimientos próximos</h2>
      <p>Los siguientes elementos están próximos a vencer o vencieron hoy:</p>
      <table style="border-collapse:collapse;width:100%;max-width:640px;">
        <thead>
          <tr style="background:#f4f4f4;text-align:left;">
            <th style="padding:6px 10px;">Tipo</th>
            <th style="padding:6px 10px;">Nombre</th>
            <th style="padding:6px 10px;">Fecha de vencimiento</th>
            <th style="padding:6px 10px;">Días restantes</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:16px;color:#666;">
        Este correo fue generado automáticamente por la aplicación de Gestión de Licencias, Dominios y Contratos.
      </p>
    </div>`;

  return html;
}

async function checkAndSend({ dryRun = false } = {}) {
  const settings = await settingsService.getAll();
  const thresholds = settingsService.thresholds(settings);
  const recipients = settingsService.recipients(settings);

  if (thresholds.length === 0) {
    console.log('[recordatorios] No hay umbrales configurados. Nada que hacer.');
    return { sent: 0, matched: [] };
  }
  if (recipients.length === 0) {
    console.log('[recordatorios] No hay destinatarios configurados (reminder_recipients). Nada que enviar.');
    return { sent: 0, matched: [] };
  }

  const matched = [];

  for (const mod of MODULES) {
    const [rows] = await pool.query(`SELECT * FROM ${mod.table}`);
    for (const row of rows) {
      const dateValue = row[mod.dateField];
      if (!dateValue) continue;
      const days = daysUntil(dateValue);
      if (!thresholds.includes(days)) continue;

      const [already] = await pool.query(
        'SELECT id FROM reminder_log WHERE entity_type = ? AND entity_id = ? AND threshold_days = ?',
        [mod.type, row.id, days]
      );
      if (already.length > 0) continue; // ya se envio para este umbral

      matched.push({
        type: mod.type,
        label: mod.label,
        name: row[mod.nameField],
        expiration_date: dateValue,
        days_left: days,
        entityId: row.id,
        threshold: days,
      });
    }
  }

  if (matched.length === 0) {
    console.log('[recordatorios] No hay vencimientos que coincidan con los umbrales hoy.');
    return { sent: 0, matched: [] };
  }

  if (dryRun) {
    console.log(`[recordatorios] (dry-run) Se enviaria un correo con ${matched.length} elemento(s).`);
    return { sent: 0, matched };
  }

  const html = buildEmail(matched);
  await mailer.sendMail({
    to: recipients.join(','),
    subject: `[Recordatorio] ${matched.length} vencimiento(s) próximo(s)`,
    html,
  });

  for (const item of matched) {
    await pool.query(
      'INSERT IGNORE INTO reminder_log (entity_type, entity_id, threshold_days, recipients) VALUES (?, ?, ?, ?)',
      [item.type, item.entityId, item.threshold, recipients.join(',')]
    );
  }

  console.log(`[recordatorios] Correo enviado a ${recipients.join(', ')} con ${matched.length} elemento(s).`);
  return { sent: matched.length, matched };
}

function startScheduler() {
  // Se ejecuta todos los dias a las 08:00 (hora del servidor). Ajustable
  // cambiando la expresion cron si se requiere otro horario.
  cron.schedule('0 8 * * *', () => {
    checkAndSend().catch((err) => console.error('[recordatorios] Error:', err.message));
  });
  console.log('[recordatorios] Tarea programada activa (todos los dias a las 08:00).');
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  checkAndSend({ dryRun })
    .then((result) => {
      console.log(`Listo. Coincidencias: ${result.matched.length}, enviados: ${result.sent}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Error ejecutando recordatorios:', err.message);
      process.exit(1);
    });
}

module.exports = { checkAndSend, startScheduler };
