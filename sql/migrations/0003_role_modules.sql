-- Ver sql/schema.sql para la explicacion completa de esta tabla.
CREATE TABLE IF NOT EXISTS role_modules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  role ENUM('editor','lector') NOT NULL,
  module VARCHAR(32) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uniq_role_module (role, module)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
