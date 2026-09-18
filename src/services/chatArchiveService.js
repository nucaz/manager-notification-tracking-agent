// Archiva y comprime la conversacion de un dia cerrado de
// agent_message_log: agrupa por (canal, contacto), junta los mensajes de
// ese dia en un JSON, lo comprime con gzip y lo guarda en
// agent_message_log_archive - despues borra las filas crudas de ese dia
// para no dejar crecer la tabla principal sin limite. Se conserva TODO
// el contenido (nada se pierde), solo cambia el formato de guardado.
const zlib = require('zlib');
const { promisify } = require('util');
const pool = require('../db/pool');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

function dayBounds(dateStr) {
  return [`${dateStr} 00:00:00`, `${dateStr} 23:59:59`];
}

// Archiva un dia especifico (formato 'YYYY-MM-DD'). Se puede correr mas
// de una vez para el mismo dia sin perder nada: si ya existe un archivo
// previo para (canal, contacto, dia) -ej. se corrio a mano a media tarde
// y despues llegaron mas mensajes ese mismo dia-, se DESCOMPRIME y se
// MEZCLA con los mensajes nuevos antes de volver a comprimir, nunca se
// reemplaza a secas (eso perderia los mensajes ya archivados).
async function archiveDay(dateStr) {
  const [desde, hasta] = dayBounds(dateStr);
  const [pairs] = await pool.query(
    'SELECT DISTINCT channel, contact FROM agent_message_log WHERE created_at BETWEEN ? AND ?',
    [desde, hasta]
  );

  let archivedPairs = 0;
  let archivedMessages = 0;

  for (const { channel, contact } of pairs) {
    const [rows] = await pool.query(
      `SELECT user_id, direction, message_text, created_at
       FROM agent_message_log
       WHERE channel = ? AND contact = ? AND created_at BETWEEN ? AND ?
       ORDER BY created_at ASC`,
      [channel, contact, desde, hasta]
    );
    if (rows.length === 0) continue;

    let payload = rows.map((r) => ({
      direction: r.direction,
      message_text: r.message_text,
      created_at: r.created_at,
    }));
    let userId = rows.find((r) => r.user_id)?.user_id || null;

    const previo = await getArchivedDay(channel, contact, dateStr);
    if (previo) {
      payload = previo.messages.concat(payload).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      userId = userId || previo.userId;
    }

    const compressed = await gzip(Buffer.from(JSON.stringify(payload), 'utf8'));

    await pool.query(
      `INSERT INTO agent_message_log_archive (channel, contact, user_id, log_date, message_count, compressed_data)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), message_count = VALUES(message_count), compressed_data = VALUES(compressed_data)`,
      [channel, contact, userId, dateStr, payload.length, compressed]
    );

    await pool.query(
      'DELETE FROM agent_message_log WHERE channel = ? AND contact = ? AND created_at BETWEEN ? AND ?',
      [channel, contact, desde, hasta]
    );

    archivedPairs += 1;
    archivedMessages += rows.length;
  }

  return { date: dateStr, pairs: archivedPairs, messages: archivedMessages };
}

// Devuelve los mensajes de un dia ya archivado (descomprimidos), o null
// si no hay archivo para esa combinacion.
async function getArchivedDay(channel, contact, dateStr) {
  const [rows] = await pool.query(
    'SELECT * FROM agent_message_log_archive WHERE channel = ? AND contact = ? AND log_date = ? LIMIT 1',
    [channel, contact, dateStr]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const decompressed = await gunzip(row.compressed_data);
  return {
    channel: row.channel,
    contact: row.contact,
    userId: row.user_id,
    logDate: row.log_date,
    messageCount: row.message_count,
    messages: JSON.parse(decompressed.toString('utf8')),
  };
}

// Lista los dias archivados disponibles (para el buscador de la vista),
// opcionalmente filtrando por canal/contacto.
async function listArchivedDays({ channel, contact } = {}) {
  let sql = `SELECT a.channel, a.contact, a.log_date, a.message_count, u.full_name
             FROM agent_message_log_archive a
             LEFT JOIN users u ON u.id = a.user_id
             WHERE 1=1`;
  const params = [];
  if (channel) {
    sql += ' AND a.channel = ?';
    params.push(channel);
  }
  if (contact) {
    sql += ' AND a.contact = ?';
    params.push(contact);
  }
  sql += ' ORDER BY a.log_date DESC LIMIT 200';
  const [rows] = await pool.query(sql, params);
  return rows;
}

module.exports = { archiveDay, getArchivedDay, listArchivedDays };
