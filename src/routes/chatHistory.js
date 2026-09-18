const express = require('express');
const { requireAuth, isAdmin } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const chatArchiveService = require('../services/chatArchiveService');
const { runArchival } = require('../jobs/archiveChatLogs');
const pool = require('../db/pool');

const router = express.Router();
router.use(requireAuth, isAdmin);

router.get('/', async (req, res, next) => {
  try {
    const { channel, contact } = req.query;
    const dias = await chatArchiveService.listArchivedDays({ channel, contact });
    const [pendientes] = await pool.query(
      "SELECT channel, contact, COUNT(*) AS total FROM agent_message_log GROUP BY channel, contact ORDER BY total DESC"
    );
    res.render('chatHistory/index', {
      title: 'Historial de chat (WhatsApp/Telegram)',
      dias,
      pendientes,
      channel: channel || '',
      contact: contact || '',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/ver', async (req, res, next) => {
  try {
    const { channel, contact, fecha } = req.query;
    if (!channel || !contact || !fecha) {
      req.flash('error', 'Faltan datos para ver la conversación.');
      return res.redirect('/historial-chat');
    }
    const data = await chatArchiveService.getArchivedDay(channel, contact, fecha);
    if (!data) {
      req.flash('error', 'No hay una conversación archivada con esos datos.');
      return res.redirect('/historial-chat');
    }
    res.render('chatHistory/ver', { title: `Conversación — ${fecha}`, data });
  } catch (err) {
    next(err);
  }
});

// Ve los mensajes de HOY (o de cualquier dia que aun no se haya
// archivado) directo de la tabla en vivo agent_message_log - antes solo
// se podia ver una conversacion ya archivada, y los mensajes recientes
// del dia en curso no tenian ninguna pantalla para leerlos.
router.get('/ver-vivo', async (req, res, next) => {
  try {
    const { channel, contact } = req.query;
    if (!channel || !contact) {
      req.flash('error', 'Faltan datos para ver la conversación.');
      return res.redirect('/historial-chat');
    }
    const [rows] = await pool.query(
      `SELECT direction, message_text, created_at FROM agent_message_log
       WHERE channel = ? AND contact = ? ORDER BY created_at ASC`,
      [channel, contact]
    );
    if (rows.length === 0) {
      req.flash('error', 'No hay mensajes en vivo (todavía sin archivar) con esos datos.');
      return res.redirect('/historial-chat');
    }
    const data = {
      channel,
      contact,
      logDate: 'hoy (en vivo, aún sin archivar)',
      messageCount: rows.length,
      messages: rows,
    };
    res.render('chatHistory/ver', { title: 'Conversación — en vivo', data });
  } catch (err) {
    next(err);
  }
});

// Dispara el archivado de un dia especifico a mano (por defecto, ayer) -
// util para probar sin esperar a las 00:30, o para cerrar un dia viejo
// que quedo sin procesar (ej. el servidor estuvo apagado esa noche).
router.post('/archivar-ahora', verifyCsrfToken, async (req, res) => {
  try {
    const fecha = req.body.fecha || undefined;
    const result = await runArchival(fecha);
    req.flash(
      'success',
      `Archivado ${result.date}: ${result.pairs} conversación(es), ${result.messages} mensaje(s) comprimido(s).`
    );
  } catch (err) {
    req.flash('error', `No se pudo archivar: ${err.message}`);
  }
  res.redirect('/historial-chat');
});

module.exports = router;
