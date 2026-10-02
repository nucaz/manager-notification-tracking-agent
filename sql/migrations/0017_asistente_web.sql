-- Ver sql/schema.sql para la explicacion completa.

-- El asistente dentro de la aplicacion registra sus preguntas y respuestas
-- en el mismo historial que WhatsApp y Telegram, como canal 'web', con el
-- correo del usuario como contacto (por eso el campo crece).
ALTER TABLE agent_message_log
  MODIFY channel ENUM('whatsapp','telegram','web') NOT NULL,
  MODIFY contact VARCHAR(100) NOT NULL;
ALTER TABLE agent_message_log_archive
  MODIFY channel ENUM('whatsapp','telegram','web') NOT NULL,
  MODIFY contact VARCHAR(100) NOT NULL;
