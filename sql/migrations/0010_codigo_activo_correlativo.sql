-- Ver sql/schema.sql para la explicacion completa.
-- El codigo real que usa el negocio es "A-00868" (prefijo + guion +
-- correlativo numerico) - la validacion de la migracion 0009 (alfanumerico
-- sin guion) era mas estricta de lo que el negocio usa de verdad. Se
-- amplia la columna para permitir el guion y se agregan los 2 settings
-- que controlan el prefijo/cantidad de digitos del correlativo sugerido.
INSERT INTO settings (`key`, `value`) VALUES
  ('mobile_asset_code_prefix', 'A-'),
  ('mobile_asset_code_digits', '5')
ON DUPLICATE KEY UPDATE `key`=`key`;

ALTER TABLE mobile_devices MODIFY COLUMN asset_code VARCHAR(12) NULL;
