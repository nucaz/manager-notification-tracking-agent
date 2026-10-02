-- Ver sql/schema.sql para la explicacion completa.

-- Baja del chip: desde cuando ya no se paga y por que.
ALTER TABLE mobile_lines ADD COLUMN IF NOT EXISTS fecha_baja DATE NULL AFTER estado;
ALTER TABLE mobile_lines ADD COLUMN IF NOT EXISTS motivo_baja VARCHAR(150) NULL AFTER fecha_baja;
-- Los chips que ya estaban de baja no tenian fecha: se toma su ultima modificacion.
UPDATE mobile_lines SET fecha_baja = DATE(updated_at) WHERE estado = 'de_baja' AND fecha_baja IS NULL;
