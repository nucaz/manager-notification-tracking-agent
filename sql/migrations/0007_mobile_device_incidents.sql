-- Ver sql/schema.sql para la explicacion completa.
CREATE TABLE IF NOT EXISTS mobile_device_incidents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  device_id INT NOT NULL,
  tipo ENUM('reparacion','accidente','baja') NOT NULL,
  fecha DATE NOT NULL,
  descripcion TEXT,
  costo DECIMAL(10,2) NULL,
  fecha_resolucion DATE NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_mobile_incident_device FOREIGN KEY (device_id) REFERENCES mobile_devices(id) ON DELETE CASCADE,
  CONSTRAINT fk_mobile_incident_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_mobile_incident_device (device_id),
  INDEX idx_mobile_incident_fecha (fecha),
  INDEX idx_mobile_incident_tipo (tipo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
