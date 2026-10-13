-- Permisos: el perfil Administrador pasa a ser configurable por modulo, y cada
-- usuario puede tener un permiso especial por modulo que manda sobre su perfil.
-- Ver src/middleware/modules.js.
ALTER TABLE role_modules MODIFY role ENUM('admin','editor','lector') NOT NULL;

-- Permiso especial de un usuario en un modulo. Sin fila = lo que diga su perfil.
CREATE TABLE IF NOT EXISTS user_modules (
  user_id INT NOT NULL,
  module VARCHAR(32) NOT NULL,
  access VARCHAR(5) NOT NULL,                   -- none = sin acceso | view = solo ver | edit = ver y editar
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, module),
  CONSTRAINT fk_user_modules_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
