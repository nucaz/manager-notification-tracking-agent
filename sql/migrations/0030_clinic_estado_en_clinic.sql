-- Ver sql/schema.sql para la explicacion completa.
--
-- Estado que muestra CLINIC en la ultima importacion (activo | inactivo),
-- aparte del estado de este inventario: una baja registrada aqui sigue
-- siendo "baja" aunque Clinic la muestre ACTIVA. Con este dato se sabe
-- que bajas faltan desactivar en Clinic y cuales ya quedaron remediadas
-- de un mes al siguiente.
ALTER TABLE clinic_user_origin
  ADD COLUMN IF NOT EXISTS clinic_status VARCHAR(10) NULL AFTER clinic_user_id,
  ADD INDEX IF NOT EXISTS idx_clinic_origin_status (clinic_status);
