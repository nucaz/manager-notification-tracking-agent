-- Ver sql/schema.sql para la explicacion completa.
-- Antes de aplicar esto en produccion se confirmo contra la base de
-- datos real que ningun mobile_devices.asset_code/notes existente supera
-- 8/250 caracteres (ambos campos estaban vacios en los 18 registros
-- cargados hasta ahora).
ALTER TABLE mobile_devices MODIFY COLUMN asset_code VARCHAR(8) NULL;
ALTER TABLE mobile_devices MODIFY COLUMN notes VARCHAR(250) NULL;
