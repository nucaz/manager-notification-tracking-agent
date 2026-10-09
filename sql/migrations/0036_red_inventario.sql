-- Modulo Red: inventario de equipos de red (PC, celulares, AP, switches...),
-- sus direcciones MAC e IP, y las VLAN. Ver src/services/networkService.js.

-- VLAN: numero, nombre, subred y puerta de enlace, por sede.
CREATE TABLE IF NOT EXISTS network_vlans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  vlan_number INT NOT NULL,                     -- 1 a 4094
  name VARCHAR(100) NOT NULL,
  subnet VARCHAR(50) NULL,                      -- ej. 172.16.10.0/24
  gateway VARCHAR(45) NULL,
  sede VARCHAR(100) NULL,                       -- catalog_items (sede); NULL = todas
  notes VARCHAR(500) NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_net_vlan_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_net_vlan_user (created_by),
  INDEX idx_net_vlan_number (vlan_number, sede)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Equipos. Un celular es una fila enlazada a mobile_devices (codigo, IMEI,
-- sede y area se leen de ahi; aqui van su MAC, IP y ubicacion). Una PC puede
-- venir de GLPI o del directorio activo (source) y completarse a mano.
CREATE TABLE IF NOT EXISTS network_devices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(12) NOT NULL,                    -- pc | celular | ap | switch | router | firewall | impresora | servidor | otro
  name VARCHAR(150) NOT NULL,
  mac CHAR(17) NULL,                            -- AA:BB:CC:DD:EE:FF
  mac_wifi CHAR(17) NULL,                       -- segunda interfaz (Wi-Fi en una PC)
  ip VARCHAR(45) NULL,
  sede VARCHAR(100) NULL,
  area VARCHAR(100) NULL,
  location VARCHAR(150) NULL,                   -- ubicacion fisica: piso, sala, rack, puerto
  brand_model VARCHAR(150) NULL,
  serial VARCHAR(100) NULL,
  notes VARCHAR(500) NULL,
  source VARCHAR(10) NOT NULL DEFAULT 'manual', -- manual | glpi | ad | celular
  mobile_device_id INT NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_net_device_mobile FOREIGN KEY (mobile_device_id) REFERENCES mobile_devices(id) ON DELETE CASCADE,
  CONSTRAINT fk_net_device_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_net_device_mobile (mobile_device_id),
  INDEX idx_net_device_user (created_by),
  INDEX idx_net_device_mac (mac),
  INDEX idx_net_device_wifi (mac_wifi),
  INDEX idx_net_device_kind (kind, sede, name),
  INDEX idx_net_device_ip (ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- VLAN de cada equipo (un switch o un AP llevan varias).
CREATE TABLE IF NOT EXISTS network_device_vlans (
  device_id INT NOT NULL,
  vlan_id INT NOT NULL,
  PRIMARY KEY (device_id, vlan_id),
  CONSTRAINT fk_net_dv_device FOREIGN KEY (device_id) REFERENCES network_devices(id) ON DELETE CASCADE,
  CONSTRAINT fk_net_dv_vlan FOREIGN KEY (vlan_id) REFERENCES network_vlans(id) ON DELETE CASCADE,
  INDEX idx_net_dv_vlan (vlan_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- MAC de las computadoras que GLPI ya conoce por su inventario.
ALTER TABLE glpi_assets ADD COLUMN IF NOT EXISTS mac VARCHAR(255) NULL AFTER ip;
