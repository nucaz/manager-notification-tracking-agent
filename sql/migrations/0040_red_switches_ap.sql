-- Modulo Red > Switches y AP: ficha tecnica de cada switch o punto de acceso
-- (1:1 con network_devices, que ya lleva nombre, MAC, IP, sede y VLAN).
CREATE TABLE IF NOT EXISTS network_device_specs (
  device_id INT NOT NULL PRIMARY KEY,
  brand VARCHAR(80) NULL,
  model VARCHAR(100) NULL,
  port_count SMALLINT UNSIGNED NULL,            -- puertos de red del equipo
  poe VARCHAR(10) NULL,                         -- no | poe | poe_plus | poe_pp | pasivo
  speed VARCHAR(10) NULL,                       -- fast | gigabit | multigig | 10g
  floor VARCHAR(40) NULL,                       -- piso
  uplink1 VARCHAR(100) NULL,                    -- puerto de enlace: "24 -> SW-CORE puerto 3"
  uplink2 VARCHAR(100) NULL,
  protocols VARCHAR(60) NULL,                   -- rest,restconf,snmp,grpc (los que el equipo ofrece para gestion)
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_net_spec_device FOREIGN KEY (device_id) REFERENCES network_devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
