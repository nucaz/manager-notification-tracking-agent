-- Ver sql/schema.sql para la explicacion completa.
CREATE TABLE IF NOT EXISTS agent_message_log_archive (
  id INT AUTO_INCREMENT PRIMARY KEY,
  channel ENUM('whatsapp','telegram') NOT NULL,
  contact VARCHAR(32) NOT NULL,
  user_id INT NULL,
  log_date DATE NOT NULL,
  message_count INT NOT NULL,
  compressed_data LONGBLOB NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_agent_log_archive_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uq_agent_log_archive (channel, contact, log_date),
  INDEX idx_agent_log_archive_date (log_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
