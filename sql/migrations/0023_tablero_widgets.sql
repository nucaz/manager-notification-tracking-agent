-- Ver sql/schema.sql para la explicacion completa.

-- Widgets personalizados del Tablero de celulares y chips.
CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  title VARCHAR(80) NOT NULL,
  config TEXT NOT NULL,                         -- JSON validado por src/services/dashboardService.js (nunca SQL)
  shared TINYINT(1) NOT NULL DEFAULT 0,         -- 1 = lo ven todos; 0 = solo quien lo creo
  position INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_dashboard_widget_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_dashboard_widget_user (user_id, shared)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
