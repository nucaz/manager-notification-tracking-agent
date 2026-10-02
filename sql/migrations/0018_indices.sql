-- Ver sql/schema.sql para la explicacion completa.

-- Indices para las busquedas exactas, filtros y limpiezas por fecha que la
-- aplicacion hace a diario. Las busquedas por "contiene" (LIKE '%texto%') no
-- pueden usar un indice: esas siguen leyendo la tabla, que es pequena.
ALTER TABLE mobile_devices
  ADD INDEX IF NOT EXISTS idx_mobile_device_imei (imei),
  ADD INDEX IF NOT EXISTS idx_mobile_device_asset_code (asset_code),
  ADD INDEX IF NOT EXISTS idx_mobile_device_sede (sede),
  ADD INDEX IF NOT EXISTS idx_mobile_device_phone_number (phone_number);
ALTER TABLE mobile_lines
  ADD INDEX IF NOT EXISTS idx_mobile_line_iccid (iccid);
ALTER TABLE mobile_line_assignments
  ADD INDEX IF NOT EXISTS idx_mobile_line_asg_active (line_id, returned_date);
ALTER TABLE employees
  ADD INDEX IF NOT EXISTS idx_employee_name (last_name, first_name),
  ADD INDEX IF NOT EXISTS idx_employee_area (area),
  ADD INDEX IF NOT EXISTS idx_employee_sede (sede);
ALTER TABLE agent_message_log
  ADD INDEX IF NOT EXISTS idx_agent_log_created (created_at);
ALTER TABLE trusted_devices
  ADD INDEX IF NOT EXISTS idx_trusted_device_expires (expires_at);
ALTER TABLE audit_log
  ADD INDEX IF NOT EXISTS idx_audit_log_email (user_email);
