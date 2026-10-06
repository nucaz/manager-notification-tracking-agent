-- Ver sql/schema.sql para la explicacion completa.
--
-- Usuarios de Clinic con tablas propias y claves foraneas: perfiles y sedes
-- de Clinic (con su Id de Clinic), area del catalogo general por id, lo que
-- dice Clinic de cada usuario (1:1), historial de cambios y registro de cada
-- importacion. Convierte el texto que ya hubiera (perfil, sede, area, baja)
-- a las tablas nuevas antes de quitar esas columnas.

CREATE TABLE IF NOT EXISTS clinic_sedes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  clinic_id INT NULL,                           -- IdSede en Clinic
  name VARCHAR(100) NOT NULL,
  address VARCHAR(255) NULL,
  opens_at TIME NULL,
  closes_at TIME NULL,
  sede_item_id INT NULL,                        -- la misma sede en el catalogo general (catalog_items 'sede')
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_clinic_sede_item FOREIGN KEY (sede_item_id) REFERENCES catalog_items(id),
  UNIQUE KEY uniq_clinic_sede_clinic_id (clinic_id),
  UNIQUE KEY uniq_clinic_sede_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS clinic_profiles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  clinic_id INT NULL,                           -- IdPerfil en Clinic
  name VARCHAR(100) NOT NULL,
  area_item_id INT NULL,                        -- area que se asume para sus usuarios (catalog_items 'area')
  description VARCHAR(255) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_clinic_profile_area FOREIGN KEY (area_item_id) REFERENCES catalog_items(id),
  UNIQUE KEY uniq_clinic_profile_clinic_id (clinic_id),
  UNIQUE KEY uniq_clinic_profile_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS clinic_imports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  file_name VARCHAR(255) NOT NULL,
  rows_total INT NOT NULL DEFAULT 0,
  created_count INT NOT NULL DEFAULT 0,
  updated_count INT NOT NULL DEFAULT 0,
  unchanged_count INT NOT NULL DEFAULT 0,
  error_count INT NOT NULL DEFAULT 0,
  summary_json MEDIUMTEXT NULL,                 -- errores y avisos de la importacion
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_clinic_import_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_clinic_import_date (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE clinic_users
  ADD COLUMN IF NOT EXISTS clinic_id INT NULL AFTER id,
  ADD COLUMN IF NOT EXISTS profile_id INT NULL AFTER status,
  ADD COLUMN IF NOT EXISTS sede_id INT NULL AFTER profile_id,
  ADD COLUMN IF NOT EXISTS area_item_id INT NULL AFTER sede_id,
  ADD COLUMN IF NOT EXISTS dni VARCHAR(12) NULL AFTER approved,
  ADD COLUMN IF NOT EXISTS email VARCHAR(150) NULL AFTER dni,
  ADD COLUMN IF NOT EXISTS phone VARCHAR(30) NULL AFTER email;

CREATE TABLE IF NOT EXISTS clinic_user_origin (
  clinic_user_id INT PRIMARY KEY,
  last_login_at DATETIME NULL,
  registered_by VARCHAR(150) NULL,
  registered_at DATETIME NULL,
  edited_by VARCHAR(150) NULL,
  edited_at DATETIME NULL,
  import_id INT NULL,
  imported_at DATETIME NULL,
  CONSTRAINT fk_clinic_origin_user FOREIGN KEY (clinic_user_id) REFERENCES clinic_users(id) ON DELETE CASCADE,
  CONSTRAINT fk_clinic_origin_import FOREIGN KEY (import_id) REFERENCES clinic_imports(id) ON DELETE SET NULL,
  INDEX idx_clinic_origin_login (last_login_at),
  INDEX idx_clinic_origin_registered (registered_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS clinic_user_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  clinic_user_id INT NOT NULL,
  event_type VARCHAR(20) NOT NULL,              -- alta | edicion | baja | reactivacion | importacion
  event_date DATE NOT NULL,
  detail VARCHAR(1000) NULL,
  reason VARCHAR(255) NULL,
  request_id INT NULL,
  import_id INT NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_clinic_event_user FOREIGN KEY (clinic_user_id) REFERENCES clinic_users(id) ON DELETE CASCADE,
  CONSTRAINT fk_clinic_event_request FOREIGN KEY (request_id) REFERENCES service_requests(id) ON DELETE SET NULL,
  CONSTRAINT fk_clinic_event_import FOREIGN KEY (import_id) REFERENCES clinic_imports(id) ON DELETE SET NULL,
  CONSTRAINT fk_clinic_event_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_clinic_event_lookup (clinic_user_id, event_type, event_date),
  INDEX idx_clinic_event_date (event_type, event_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Los perfiles del catalogo generico pasan a su tabla.
INSERT IGNORE INTO clinic_profiles (name, active)
  SELECT value, active FROM catalog_items WHERE catalog_type = 'perfil_clinic';

-- Datos de la version anterior (columnas de texto), solo si existen.
SET @old := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'clinic_users' AND column_name = 'perfil');
EXECUTE IMMEDIATE IF(@old > 0,
  'INSERT IGNORE INTO clinic_profiles (name) SELECT DISTINCT TRIM(perfil) FROM clinic_users WHERE TRIM(COALESCE(perfil, '''')) <> ''''',
  'DO 0');
EXECUTE IMMEDIATE IF(@old > 0,
  'UPDATE clinic_users c JOIN clinic_profiles p ON p.name = TRIM(c.perfil) SET c.profile_id = p.id WHERE c.profile_id IS NULL',
  'DO 0');
EXECUTE IMMEDIATE IF(@old > 0,
  'INSERT IGNORE INTO catalog_items (catalog_type, value) SELECT DISTINCT ''sede'', TRIM(sede) FROM clinic_users WHERE TRIM(COALESCE(sede, '''')) <> ''''',
  'DO 0');
EXECUTE IMMEDIATE IF(@old > 0,
  'INSERT IGNORE INTO clinic_sedes (name, sede_item_id) SELECT DISTINCT TRIM(c.sede), ci.id FROM clinic_users c JOIN catalog_items ci ON ci.catalog_type = ''sede'' AND ci.value = TRIM(c.sede) WHERE TRIM(COALESCE(c.sede, '''')) <> ''''',
  'DO 0');
EXECUTE IMMEDIATE IF(@old > 0,
  'UPDATE clinic_users c JOIN clinic_sedes s ON s.name = TRIM(c.sede) SET c.sede_id = s.id WHERE c.sede_id IS NULL',
  'DO 0');
EXECUTE IMMEDIATE IF(@old > 0,
  'INSERT IGNORE INTO catalog_items (catalog_type, value) SELECT DISTINCT ''area'', TRIM(area) FROM clinic_users WHERE TRIM(COALESCE(area, '''')) <> ''''',
  'DO 0');
EXECUTE IMMEDIATE IF(@old > 0,
  'UPDATE clinic_users c JOIN catalog_items ci ON ci.catalog_type = ''area'' AND ci.value = TRIM(c.area) SET c.area_item_id = ci.id WHERE c.area_item_id IS NULL',
  'DO 0');
EXECUTE IMMEDIATE IF(@old > 0,
  'INSERT IGNORE INTO clinic_user_origin (clinic_user_id, registered_by, registered_at) SELECT id, clinic_registered_by, clinic_registered_at FROM clinic_users WHERE clinic_registered_by IS NOT NULL OR clinic_registered_at IS NOT NULL',
  'DO 0');
EXECUTE IMMEDIATE IF(@old > 0,
  'INSERT INTO clinic_user_events (clinic_user_id, event_type, event_date, detail, request_id, created_by, created_at) SELECT id, ''alta'', DATE(created_at), ''Registrado en el inventario'', request_id, created_by, created_at FROM clinic_users WHERE request_id IS NOT NULL',
  'DO 0');
EXECUTE IMMEDIATE IF(@old > 0,
  'INSERT INTO clinic_user_events (clinic_user_id, event_type, event_date, reason, detail, created_at) SELECT id, ''baja'', COALESCE(baja_date, DATE(updated_at)), baja_reason, ''Baja registrada antes del historial'', updated_at FROM clinic_users WHERE status = ''baja''',
  'DO 0');

DELETE FROM catalog_items WHERE catalog_type = 'perfil_clinic';

-- El usuario ya no es unico (Clinic tiene dos usuarios iguales, uno con un espacio
-- invisible): la clave de Clinic es su IdUsuario (clinic_id).
ALTER TABLE clinic_users
  DROP INDEX IF EXISTS uniq_clinic_username,
  DROP INDEX IF EXISTS idx_clinic_status;
ALTER TABLE clinic_users
  DROP COLUMN IF EXISTS perfil,
  DROP COLUMN IF EXISTS sede,
  DROP COLUMN IF EXISTS area,
  DROP COLUMN IF EXISTS clinic_registered_by,
  DROP COLUMN IF EXISTS clinic_registered_at,
  DROP COLUMN IF EXISTS baja_date,
  DROP COLUMN IF EXISTS baja_reason;
ALTER TABLE clinic_users
  ADD UNIQUE INDEX IF NOT EXISTS uniq_clinic_user_clinic_id (clinic_id),
  ADD INDEX IF NOT EXISTS idx_clinic_username (username),
  ADD INDEX IF NOT EXISTS idx_clinic_status (status),
  ADD INDEX IF NOT EXISTS idx_clinic_profile (profile_id, status),
  ADD INDEX IF NOT EXISTS idx_clinic_sede (sede_id, status),
  ADD INDEX IF NOT EXISTS idx_clinic_area (area_item_id),
  ADD INDEX IF NOT EXISTS idx_clinic_dni (dni);

SET @fk := (SELECT COUNT(*) FROM information_schema.table_constraints
            WHERE table_schema = DATABASE() AND table_name = 'clinic_users' AND constraint_name = 'fk_clinic_user_profile');
EXECUTE IMMEDIATE IF(@fk = 0, 'ALTER TABLE clinic_users ADD CONSTRAINT fk_clinic_user_profile FOREIGN KEY (profile_id) REFERENCES clinic_profiles(id)', 'DO 0');
SET @fk := (SELECT COUNT(*) FROM information_schema.table_constraints
            WHERE table_schema = DATABASE() AND table_name = 'clinic_users' AND constraint_name = 'fk_clinic_user_sede');
EXECUTE IMMEDIATE IF(@fk = 0, 'ALTER TABLE clinic_users ADD CONSTRAINT fk_clinic_user_sede FOREIGN KEY (sede_id) REFERENCES clinic_sedes(id)', 'DO 0');
SET @fk := (SELECT COUNT(*) FROM information_schema.table_constraints
            WHERE table_schema = DATABASE() AND table_name = 'clinic_users' AND constraint_name = 'fk_clinic_user_area');
EXECUTE IMMEDIATE IF(@fk = 0, 'ALTER TABLE clinic_users ADD CONSTRAINT fk_clinic_user_area FOREIGN KEY (area_item_id) REFERENCES catalog_items(id)', 'DO 0');
