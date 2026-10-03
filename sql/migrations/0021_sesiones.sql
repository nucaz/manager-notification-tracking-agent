-- Ver sql/schema.sql para la explicacion completa.

-- Sesiones en la base de datos: antes vivian en la memoria del proceso y
-- cada reinicio o despliegue cerraba la sesion de todos.
CREATE TABLE IF NOT EXISTS sessions (
  sid VARCHAR(128) NOT NULL PRIMARY KEY,
  expires DATETIME NOT NULL,
  data MEDIUMTEXT NOT NULL,
  INDEX idx_sessions_expires (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
