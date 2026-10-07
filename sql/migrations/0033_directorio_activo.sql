-- Ver sql/schema.sql para la explicacion completa.
--
-- Directorio activo (fase 1: solo lectura). Foto del dominio que se renueva
-- en cada lectura por LDAPS (adService.sync): usuarios, grupos y sus
-- miembros, unidades organizativas, computadoras, registros DNS integrados,
-- papelera y el registro de cada lectura. Usuarios, grupos, OUs y equipos
-- se identifican por objectGUID; lo que deja de verse queda con removed_at
-- (no se borra: sirve de historial).
CREATE TABLE IF NOT EXISTS ad_users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  object_guid CHAR(36) NOT NULL,
  sam VARCHAR(64) NOT NULL,
  upn VARCHAR(255) NULL,
  display_name VARCHAR(255) NULL,
  mail VARCHAR(255) NULL,
  title VARCHAR(150) NULL,
  department VARCHAR(150) NULL,
  description VARCHAR(500) NULL,
  dn VARCHAR(700) NOT NULL,
  ou_dn VARCHAR(700) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  locked TINYINT(1) NOT NULL DEFAULT 0,
  pwd_never_expires TINYINT(1) NOT NULL DEFAULT 0,
  pwd_last_set DATETIME NULL,
  last_logon_ts DATETIME NULL,                  -- lastLogonTimestamp (replicado, hasta ~14 dias de desfase)
  last_logon DATETIME NULL,                     -- lastLogon mas reciente entre todos los DC consultados
  when_created DATETIME NULL,
  admin_count TINYINT(1) NOT NULL DEFAULT 0,
  privileged_groups VARCHAR(500) NULL,          -- grupos privilegiados (directos o anidados); vacio = no privilegiado
  employee_id INT NULL,                         -- empleado con el mismo DNI (atributo employeeID)
  seen_at DATETIME NULL,
  removed_at DATETIME NULL,
  CONSTRAINT fk_ad_user_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_ad_user_guid (object_guid),
  INDEX idx_ad_user_sam (sam),
  INDEX idx_ad_user_upn (upn),
  INDEX idx_ad_user_state (removed_at, enabled),
  INDEX idx_ad_user_logon (last_logon_ts),
  INDEX idx_ad_user_ou (ou_dn(255))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_groups (
  id INT AUTO_INCREMENT PRIMARY KEY,
  object_guid CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  sam VARCHAR(255) NULL,
  sid VARCHAR(100) NULL,
  dn VARCHAR(700) NOT NULL,
  ou_dn VARCHAR(700) NULL,
  scope VARCHAR(12) NULL,                       -- global | local | universal
  kind VARCHAR(12) NULL,                        -- seguridad | distribucion
  description VARCHAR(500) NULL,
  member_count INT NOT NULL DEFAULT 0,
  privileged VARCHAR(60) NULL,                  -- clave del grupo privilegiado conocido (por SID), si lo es
  seen_at DATETIME NULL,
  removed_at DATETIME NULL,
  UNIQUE KEY uniq_ad_group_guid (object_guid),
  INDEX idx_ad_group_name (name),
  INDEX idx_ad_group_state (removed_at, privileged)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Miembros directos de cada grupo (se reemplazan en cada lectura).
CREATE TABLE IF NOT EXISTS ad_group_members (
  id INT AUTO_INCREMENT PRIMARY KEY,
  group_id INT NOT NULL,
  member_hash CHAR(40) NOT NULL,                -- SHA-1 del DN del miembro (unico por grupo)
  member_dn VARCHAR(700) NOT NULL,
  member_kind VARCHAR(10) NOT NULL,             -- usuario | grupo | equipo | otro
  user_id INT NULL,
  CONSTRAINT fk_ad_member_group FOREIGN KEY (group_id) REFERENCES ad_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_ad_member_user FOREIGN KEY (user_id) REFERENCES ad_users(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_ad_member (group_id, member_hash),
  INDEX idx_ad_member_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_ous (
  id INT AUTO_INCREMENT PRIMARY KEY,
  object_guid CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  dn VARCHAR(700) NOT NULL,
  parent_dn VARCHAR(700) NULL,
  kind VARCHAR(12) NOT NULL DEFAULT 'ou',       -- ou | contenedor
  description VARCHAR(500) NULL,
  users_count INT NOT NULL DEFAULT 0,
  computers_count INT NOT NULL DEFAULT 0,
  groups_count INT NOT NULL DEFAULT 0,
  seen_at DATETIME NULL,
  removed_at DATETIME NULL,
  UNIQUE KEY uniq_ad_ou_guid (object_guid),
  INDEX idx_ad_ou_parent (parent_dn(255))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_computers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  object_guid CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  dns_host VARCHAR(255) NULL,
  os VARCHAR(255) NULL,
  os_version VARCHAR(100) NULL,
  description VARCHAR(500) NULL,
  dn VARCHAR(700) NOT NULL,
  ou_dn VARCHAR(700) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  is_dc TINYINT(1) NOT NULL DEFAULT 0,
  last_logon_ts DATETIME NULL,
  last_logon DATETIME NULL,
  pwd_last_set DATETIME NULL,
  when_created DATETIME NULL,
  ips VARCHAR(255) NULL,                        -- de los registros DNS del equipo
  seen_at DATETIME NULL,
  removed_at DATETIME NULL,
  UNIQUE KEY uniq_ad_computer_guid (object_guid),
  INDEX idx_ad_computer_name (name),
  INDEX idx_ad_computer_state (removed_at, enabled),
  INDEX idx_ad_computer_logon (last_logon_ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Registros DNS de las zonas integradas en AD (se reemplazan en cada lectura).
CREATE TABLE IF NOT EXISTS ad_dns_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  zone VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  rtype VARCHAR(10) NOT NULL,
  data VARCHAR(500) NULL,
  ttl INT NULL,
  record_ts DATETIME NULL,                      -- registro dinamico: ultima actualizacion; NULL = estatico
  computer_id INT NULL,
  CONSTRAINT fk_ad_dns_computer FOREIGN KEY (computer_id) REFERENCES ad_computers(id) ON DELETE SET NULL,
  INDEX idx_ad_dns_name (zone, name),
  INDEX idx_ad_dns_computer (computer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Papelera de AD (CN=Deleted Objects), se reemplaza en cada lectura.
CREATE TABLE IF NOT EXISTS ad_deleted (
  id INT AUTO_INCREMENT PRIMARY KEY,
  object_guid CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  object_class VARCHAR(30) NULL,
  sam VARCHAR(255) NULL,
  last_known_parent VARCHAR(700) NULL,
  deleted_at DATETIME NULL,
  UNIQUE KEY uniq_ad_deleted_guid (object_guid),
  INDEX idx_ad_deleted_date (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cada lectura del dominio: cuando, contra que DC, resultado y resumen
-- (nivel funcional, papelera, politica de contrasenas, DC, certificado).
CREATE TABLE IF NOT EXISTS ad_sync_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'en_curso', -- en_curso | ok | con_avisos | error
  dc VARCHAR(255) NULL,
  summary_json MEDIUMTEXT NULL,
  error VARCHAR(1000) NULL,
  created_by INT NULL,
  CONSTRAINT fk_ad_sync_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_ad_sync_date (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
