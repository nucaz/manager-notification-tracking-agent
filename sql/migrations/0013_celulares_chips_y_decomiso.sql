-- Ver sql/schema.sql para la explicacion completa.

-- 1) Decomiso: estado del equipo + tipo de incidente con motivo.
ALTER TABLE mobile_devices
  MODIFY COLUMN status ENUM('en_stock','asignado','en_reparacion','en_decomiso','de_baja') NOT NULL DEFAULT 'en_stock';
ALTER TABLE mobile_device_incidents
  MODIFY COLUMN tipo ENUM('reparacion','accidente','baja','decomiso') NOT NULL;
ALTER TABLE mobile_device_incidents ADD COLUMN IF NOT EXISTS motivo VARCHAR(20) NULL AFTER tipo;

-- 2) Chips como registro propio (un chip = un numero de linea).
CREATE TABLE IF NOT EXISTS mobile_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  phone_country_code_id INT NULL,
  phone_number VARCHAR(30) NOT NULL,
  iccid VARCHAR(22) NULL,
  operadora VARCHAR(50) NULL,
  plan VARCHAR(60) NULL,
  costo_plan DECIMAL(10,2) NULL,
  estado ENUM('activo','suspendido','de_baja') NOT NULL DEFAULT 'activo',
  device_id INT NULL,
  notes VARCHAR(250) NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_mobile_line_device FOREIGN KEY (device_id) REFERENCES mobile_devices(id) ON DELETE SET NULL,
  CONSTRAINT fk_mobile_line_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_mobile_line_number (phone_number),
  INDEX idx_mobile_line_device (device_id),
  INDEX idx_mobile_line_estado (estado),
  INDEX idx_mobile_line_operadora (operadora)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mobile_line_assignments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  line_id INT NOT NULL,
  employee_id INT NULL,
  holder_name VARCHAR(150) NOT NULL,
  uso ENUM('personal','emergencia') NOT NULL DEFAULT 'personal',
  assigned_date DATE NULL,
  returned_date DATE NULL,
  observacion VARCHAR(250) NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_mobile_line_asg_line FOREIGN KEY (line_id) REFERENCES mobile_lines(id) ON DELETE CASCADE,
  CONSTRAINT fk_mobile_line_asg_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL,
  CONSTRAINT fk_mobile_line_asg_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_mobile_line_asg_line (line_id),
  INDEX idx_mobile_line_asg_employee (employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cada celular que ya tiene chip y numero pasa a tener su chip registrado,
-- puesto en ese celular. INSERT IGNORE: si un numero se repitiera entre dos
-- celulares se queda con el primero (antes de aplicar se verifico que no
-- hay numeros repetidos) y reintentar la migracion no duplica nada.
INSERT IGNORE INTO mobile_lines (phone_country_code_id, phone_number, operadora, device_id, created_by)
SELECT phone_country_code_id, phone_number, operadora, id, created_by
FROM mobile_devices
WHERE has_chip = 1 AND phone_number IS NOT NULL AND phone_number <> ''
ORDER BY id;
