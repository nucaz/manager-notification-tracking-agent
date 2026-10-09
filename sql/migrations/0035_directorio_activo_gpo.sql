-- Directorio activo: directivas de grupo (GPO), solo lectura por LDAP.
-- Se reemplazan en cada lectura del dominio (como el DNS): que GPO existen,
-- que tipo de configuracion traen (extensiones), donde estan vinculadas, en
-- que orden y si la herencia esta bloqueada. El contenido de cada directiva
-- vive en SYSVOL y no se lee aqui. Ver src/services/adGpoService.js.

CREATE TABLE IF NOT EXISTS ad_gpos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  gpo_guid CHAR(36) NOT NULL,                   -- el nombre del objeto, sin llaves
  name VARCHAR(255) NOT NULL,
  dn VARCHAR(700) NOT NULL,
  sysvol_path VARCHAR(500) NULL,
  computer_version INT NOT NULL DEFAULT 0,      -- veces que se cambio la parte de equipo
  user_version INT NOT NULL DEFAULT 0,
  computer_enabled TINYINT(1) NOT NULL DEFAULT 1,
  user_enabled TINYINT(1) NOT NULL DEFAULT 1,
  computer_ext TEXT NULL,                       -- GUID de las extensiones (CSE) con configuracion, separados por coma
  user_ext TEXT NULL,
  wmi_filter VARCHAR(255) NULL,
  wmi_query TEXT NULL,
  software_json TEXT NULL,                      -- paquetes de instalacion de software: [{ name, path, scope }]
  when_created DATETIME NULL,
  when_changed DATETIME NULL,
  UNIQUE KEY uniq_ad_gpo_guid (gpo_guid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Vinculos: en que dominio, unidad organizativa o sitio se aplica cada GPO.
-- gpo_id NULL = el vinculo apunta a una GPO que ya no existe (vinculo huerfano).
CREATE TABLE IF NOT EXISTS ad_gpo_links (
  id INT AUTO_INCREMENT PRIMARY KEY,
  gpo_id INT NULL,
  gpo_guid CHAR(36) NOT NULL,
  target_dn VARCHAR(700) NOT NULL,
  target_kind VARCHAR(10) NOT NULL,             -- dominio | ou | sitio
  target_name VARCHAR(255) NOT NULL,
  link_order INT NOT NULL,                      -- 1 = el que gana dentro de ese contenedor
  enforced TINYINT(1) NOT NULL DEFAULT 0,       -- "Exigido": no lo frena un bloqueo de herencia
  link_enabled TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT fk_ad_gpo_link_gpo FOREIGN KEY (gpo_id) REFERENCES ad_gpos(id) ON DELETE CASCADE,
  INDEX idx_ad_gpo_link_gpo (gpo_id),
  INDEX idx_ad_gpo_link_target (target_dn(255))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Unidades con la herencia de directivas bloqueada (gPOptions = 1).
ALTER TABLE ad_ous ADD COLUMN IF NOT EXISTS gp_block TINYINT(1) NOT NULL DEFAULT 0 AFTER groups_count;
