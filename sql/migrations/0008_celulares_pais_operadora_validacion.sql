-- Ver sql/schema.sql para la explicacion completa.
CREATE TABLE IF NOT EXISTS phone_country_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  country_name VARCHAR(80) NOT NULL,
  calling_code VARCHAR(5) NOT NULL,
  mobile_length TINYINT UNSIGNED NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_phone_country_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_phone_country (country_name, calling_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO phone_country_codes (country_name, calling_code, mobile_length) VALUES
  ('Perú', '51', 9),
  ('Chile', '56', 9),
  ('Colombia', '57', 10),
  ('Ecuador', '593', 9),
  ('Bolivia', '591', 8),
  ('Argentina', '54', 10),
  ('México', '52', 10),
  ('España', '34', 9),
  ('Estados Unidos', '1', 10),
  ('Brasil', '55', 11);

INSERT IGNORE INTO catalog_items (catalog_type, value) VALUES
  ('operadora', 'Entel'),
  ('operadora', 'Claro'),
  ('operadora', 'Movistar'),
  ('operadora', 'Bitel');

ALTER TABLE mobile_devices ADD COLUMN IF NOT EXISTS phone_country_code_id INT NULL AFTER imei;
ALTER TABLE mobile_devices ADD COLUMN IF NOT EXISTS operadora VARCHAR(50) NULL AFTER model;
ALTER TABLE mobile_devices ADD INDEX IF NOT EXISTS idx_mobile_device_phone_country (phone_country_code_id);

-- Datos ya cargados (todos son de Peru hasta ahora): se asocian al codigo
-- de Peru para no dejarlos sin pais. No pisa filas que ya se hayan
-- asociado a otro pais (IS NULL de por medio), asi es seguro reintentar.
UPDATE mobile_devices
SET phone_country_code_id = (SELECT id FROM phone_country_codes WHERE calling_code = '51' LIMIT 1)
WHERE phone_number IS NOT NULL AND phone_number <> '' AND phone_country_code_id IS NULL;

-- Reduce el campo a 20 caracteres (el tamaño pedido para "modelo"). Antes
-- de aplicarlo en produccion se confirmo que ningun registro real supera
-- ese largo (18 celulares cargados, model/brand estaban en blanco).
ALTER TABLE mobile_devices MODIFY COLUMN model VARCHAR(20) NULL;
