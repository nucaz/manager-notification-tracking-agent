-- Red > Switches y AP: catalogo relacional de marcas y modelos, credencial de
-- acceso del equipo (cifrada), estado (en uso / en stock...) y monitoreo de
-- actividad. Ver src/services/networkService.js y netMonitorService.js.

-- Marcas de equipos de red.
CREATE TABLE IF NOT EXISTS network_brands (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_net_brand_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_net_brand_user (created_by),
  UNIQUE KEY uniq_net_brand (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Modelos de cada marca, con lo que es propio del modelo: tipo, puertos, PoE y velocidad.
CREATE TABLE IF NOT EXISTS network_models (
  id INT AUTO_INCREMENT PRIMARY KEY,
  brand_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  kind VARCHAR(12) NOT NULL DEFAULT 'switch',   -- switch | ap
  port_count SMALLINT UNSIGNED NULL,
  poe VARCHAR(10) NULL,
  speed VARCHAR(10) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_net_model_brand FOREIGN KEY (brand_id) REFERENCES network_brands(id) ON DELETE CASCADE,
  CONSTRAINT fk_net_model_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_net_model_user (created_by),
  UNIQUE KEY uniq_net_model (brand_id, name),
  INDEX idx_net_model_kind (kind, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- La ficha del equipo apunta a su modelo del catalogo; suma el estado y la credencial de acceso.
ALTER TABLE network_device_specs ADD COLUMN IF NOT EXISTS model_id INT NULL AFTER device_id;
ALTER TABLE network_device_specs ADD COLUMN IF NOT EXISTS state VARCHAR(12) NOT NULL DEFAULT 'en_uso' AFTER protocols; -- en_uso | stock | reparacion | baja
ALTER TABLE network_device_specs ADD COLUMN IF NOT EXISTS mgmt_user VARCHAR(80) NULL AFTER state;
ALTER TABLE network_device_specs ADD COLUMN IF NOT EXISTS mgmt_password TEXT NULL AFTER mgmt_user;                    -- cifrada (cryptoService)
ALTER TABLE network_device_specs ADD INDEX IF NOT EXISTS idx_net_spec_model (model_id);
ALTER TABLE network_device_specs ADD INDEX IF NOT EXISTS idx_net_spec_state (state);
ALTER TABLE network_device_specs ADD INDEX IF NOT EXISTS idx_net_spec_brand (brand, model);
ALTER TABLE network_device_specs ADD INDEX IF NOT EXISTS idx_net_spec_floor (floor);
ALTER TABLE network_device_specs ADD CONSTRAINT fk_net_spec_model FOREIGN KEY IF NOT EXISTS (model_id) REFERENCES network_models(id) ON DELETE SET NULL;
ALTER TABLE network_devices ADD INDEX IF NOT EXISTS idx_net_device_sede_area (sede, area);

-- Marcas habituales, para empezar; y las que ya estaban escritas en las fichas.
INSERT IGNORE INTO network_brands (name) VALUES ('TP-Link'), ('Cisco'), ('Ubiquiti'), ('MikroTik'), ('HPE Aruba'), ('D-Link'), ('Huawei'), ('Ruijie'), ('Fortinet'), ('Netgear');
INSERT IGNORE INTO network_brands (name) SELECT DISTINCT TRIM(brand) FROM network_device_specs WHERE brand IS NOT NULL AND TRIM(brand) <> '';
INSERT IGNORE INTO network_models (brand_id, name, kind, port_count, poe, speed)
  SELECT b.id, TRIM(sp.model), MIN(d.kind), MAX(sp.port_count), MAX(sp.poe), MAX(sp.speed)
  FROM network_device_specs sp JOIN network_devices d ON d.id = sp.device_id JOIN network_brands b ON b.name = TRIM(sp.brand)
  WHERE sp.model IS NOT NULL AND TRIM(sp.model) <> '' GROUP BY b.id, TRIM(sp.model);
UPDATE network_device_specs sp JOIN network_brands b ON b.name = TRIM(sp.brand) JOIN network_models m ON m.brand_id = b.id AND m.name = TRIM(sp.model)
  SET sp.model_id = m.id WHERE sp.model_id IS NULL;

-- Monitoreo de actividad de cada equipo (1:1): como se comprueba y el ultimo resultado.
CREATE TABLE IF NOT EXISTS network_device_monitor (
  device_id INT NOT NULL PRIMARY KEY,
  method VARCHAR(6) NOT NULL DEFAULT 'auto',    -- auto (Omada, ping, puertos habituales) | tcp | snmp | no
  port SMALLINT UNSIGNED NULL,                  -- puerto TCP (metodo tcp) o UDP (snmp; por defecto 161)
  community TEXT NULL,                          -- comunidad SNMP v2c, cifrada
  status VARCHAR(8) NULL,                       -- up | down | NULL = sin comprobar
  detail VARCHAR(160) NULL,
  latency_ms INT NULL,
  checked_at DATETIME NULL,
  changed_at DATETIME NULL,                     -- desde cuando esta en ese estado
  CONSTRAINT fk_net_monitor_device FOREIGN KEY (device_id) REFERENCES network_devices(id) ON DELETE CASCADE,
  INDEX idx_net_monitor_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
