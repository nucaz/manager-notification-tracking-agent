-- Ver sql/schema.sql para la explicacion completa.
ALTER TABLE mobile_devices ADD COLUMN IF NOT EXISTS purchase_date DATE NULL AFTER operadora;
ALTER TABLE mobile_devices ADD COLUMN IF NOT EXISTS condicion ENUM('nuevo','usado') NULL AFTER purchase_date;
