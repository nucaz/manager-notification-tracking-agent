-- Ver sql/schema.sql para la explicacion completa.

-- Recibos de las operadoras (subidos en PDF o Excel) para cruzarlos contra
-- el inventario de chips y celulares.
CREATE TABLE IF NOT EXISTS mobile_bills (
  id INT AUTO_INCREMENT PRIMARY KEY,
  operadora VARCHAR(50) NOT NULL,
  recibo_nro VARCHAR(40) NOT NULL,
  cuenta VARCHAR(40) NULL,
  razon_social VARCHAR(150) NULL,
  ruc VARCHAR(20) NULL,
  fecha_emision DATE NULL,
  periodo_inicio DATE NULL,
  periodo_fin DATE NULL,
  fecha_vencimiento DATE NULL,
  total_pagar DECIMAL(12,2) NULL,
  total_lineas DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_cargos DECIMAL(12,2) NOT NULL DEFAULT 0,
  saldo_anterior DECIMAL(12,2) NOT NULL DEFAULT 0,
  origen ENUM('pdf','excel') NOT NULL,
  archivo_nombre VARCHAR(255) NULL,
  archivo_guardado VARCHAR(255) NULL,
  uploaded_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_mobile_bill_user FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_mobile_bill (operadora, recibo_nro),
  INDEX idx_mobile_bill_emision (fecha_emision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mobile_bill_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bill_id INT NOT NULL,
  phone_number VARCHAR(30) NOT NULL,
  plan VARCHAR(80) NULL,
  cargo_fijo DECIMAL(10,2) NOT NULL DEFAULT 0,
  descuento DECIMAL(10,2) NOT NULL DEFAULT 0,
  otros DECIMAL(10,2) NOT NULL DEFAULT 0,
  monto_total DECIMAL(10,2) NOT NULL DEFAULT 0,
  descuento_tipo VARCHAR(120) NULL,
  descuento_cuota SMALLINT NULL,
  descuento_cuotas SMALLINT NULL,
  CONSTRAINT fk_mobile_bill_line_bill FOREIGN KEY (bill_id) REFERENCES mobile_bills(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_mobile_bill_line (bill_id, phone_number),
  INDEX idx_mobile_bill_line_number (phone_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mobile_bill_charges (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bill_id INT NOT NULL,
  descripcion VARCHAR(255) NOT NULL,
  imei VARCHAR(30) NULL,
  modelo VARCHAR(100) NULL,
  folio VARCHAR(40) NULL,
  cuota_nro SMALLINT NULL,
  cuota_total SMALLINT NULL,
  monto DECIMAL(10,2) NOT NULL DEFAULT 0,
  CONSTRAINT fk_mobile_bill_charge_bill FOREIGN KEY (bill_id) REFERENCES mobile_bills(id) ON DELETE CASCADE,
  INDEX idx_mobile_bill_charge_bill (bill_id),
  INDEX idx_mobile_bill_charge_imei (imei)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
