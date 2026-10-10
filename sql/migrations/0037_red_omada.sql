-- Modulo Red > Omada: lectura de los controladores TP-Link Omada (Open API,
-- solo lectura): sitios, equipos (AP, switches, gateway), clientes conectados
-- y muestras de consumo. Ver src/services/omadaService.js.

-- Un controlador (cada OC300 o controlador por software tiene su propio
-- identificador y su propia aplicacion Open API). El secreto se guarda cifrado.
CREATE TABLE IF NOT EXISTS omada_controllers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  base_url VARCHAR(255) NOT NULL,               -- ej. https://use1-omada-northbound.tplinkcloud.com
  omadac_id VARCHAR(64) NOT NULL,
  client_id VARCHAR(64) NOT NULL,
  client_secret TEXT NULL,                      -- cifrado (cryptoService)
  verify_tls TINYINT(1) NOT NULL DEFAULT 1,     -- 0 solo para un controlador local con certificado propio
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  last_sync_at DATETIME NULL,
  last_sync_ok TINYINT(1) NULL,
  last_sync_detail VARCHAR(500) NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_omada_ctrl_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_omada_ctrl_user (created_by),
  UNIQUE KEY uniq_omada_ctrl (base_url, omadac_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sitios de cada controlador, con el resumen de la ultima lectura.
CREATE TABLE IF NOT EXISTS omada_sites (
  id INT AUTO_INCREMENT PRIMARY KEY,
  controller_id INT NOT NULL,
  site_key VARCHAR(64) NOT NULL,                -- siteId de Omada
  name VARCHAR(100) NOT NULL,
  region VARCHAR(60) NULL,
  devices_total INT NOT NULL DEFAULT 0,
  devices_online INT NOT NULL DEFAULT 0,
  clients_total INT NOT NULL DEFAULT 0,
  clients_wireless INT NOT NULL DEFAULT 0,
  down_bps BIGINT NOT NULL DEFAULT 0,           -- suma de la velocidad actual de los clientes
  up_bps BIGINT NOT NULL DEFAULT 0,
  synced_at DATETIME NULL,
  CONSTRAINT fk_omada_site_ctrl FOREIGN KEY (controller_id) REFERENCES omada_controllers(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_omada_site (controller_id, site_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Equipos adoptados: AP, switches y gateway.
CREATE TABLE IF NOT EXISTS omada_devices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  site_id INT NOT NULL,
  mac CHAR(17) NOT NULL,                        -- AA:BB:CC:DD:EE:FF
  name VARCHAR(150) NOT NULL,
  kind VARCHAR(10) NOT NULL,                    -- ap | switch | gateway | otro
  model VARCHAR(100) NULL,
  ip VARCHAR(45) NULL,
  status TINYINT NOT NULL DEFAULT 0,            -- 0 desconectado, 1 conectado, 2 pendiente, 3 sin latido, 4 aislado
  cpu TINYINT UNSIGNED NULL,                    -- %
  mem TINYINT UNSIGNED NULL,                    -- %
  uptime VARCHAR(40) NULL,
  firmware VARCHAR(80) NULL,
  serial VARCHAR(60) NULL,
  uplink_name VARCHAR(150) NULL,
  uplink_port VARCHAR(40) NULL,
  clients INT NOT NULL DEFAULT 0,               -- clientes conectados a este equipo
  present TINYINT(1) NOT NULL DEFAULT 1,        -- 0 = ya no figura en el controlador
  synced_at DATETIME NULL,
  CONSTRAINT fk_omada_dev_site FOREIGN KEY (site_id) REFERENCES omada_sites(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_omada_dev (site_id, mac),
  INDEX idx_omada_dev_mac (mac)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Clientes vistos (conectados ahora o en los ultimos dias).
CREATE TABLE IF NOT EXISTS omada_clients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  site_id INT NOT NULL,
  mac CHAR(17) NOT NULL,
  name VARCHAR(150) NULL,
  vendor VARCHAR(100) NULL,
  device_type VARCHAR(40) NULL,
  ip VARCHAR(45) NULL,
  wireless TINYINT(1) NOT NULL DEFAULT 0,
  ssid VARCHAR(64) NULL,
  via_mac CHAR(17) NULL,                        -- AP o switch al que esta conectado
  via_name VARCHAR(150) NULL,
  via_port VARCHAR(40) NULL,
  vlan INT NULL,
  signal_pct TINYINT UNSIGNED NULL,
  down_bps BIGINT NOT NULL DEFAULT 0,
  up_bps BIGINT NOT NULL DEFAULT 0,
  traffic_down BIGINT NOT NULL DEFAULT 0,       -- bytes de la sesion actual
  traffic_up BIGINT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  last_seen DATETIME NULL,
  CONSTRAINT fk_omada_cli_site FOREIGN KEY (site_id) REFERENCES omada_sites(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_omada_cli (site_id, mac),
  INDEX idx_omada_cli_mac (mac),
  INDEX idx_omada_cli_seen (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Una muestra por sitio en cada lectura: es el historial del grafico de
-- consumo. Se conservan 30 dias (lo borra la propia lectura).
CREATE TABLE IF NOT EXISTS omada_samples (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site_id INT NOT NULL,
  taken_at DATETIME NOT NULL,
  clients INT NOT NULL DEFAULT 0,
  wireless INT NOT NULL DEFAULT 0,
  down_bps BIGINT NOT NULL DEFAULT 0,
  up_bps BIGINT NOT NULL DEFAULT 0,
  devices_offline INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_omada_sample_site FOREIGN KEY (site_id) REFERENCES omada_sites(id) ON DELETE CASCADE,
  INDEX idx_omada_sample (site_id, taken_at),
  INDEX idx_omada_sample_taken (taken_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
