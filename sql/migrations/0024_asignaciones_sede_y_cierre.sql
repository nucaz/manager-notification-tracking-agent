-- Ver sql/schema.sql para la explicacion completa.

-- Historial de asignaciones: en que sede y area estuvo el equipo durante
-- cada asignacion, y como termino (otra persona, stock, baja, decomiso).
ALTER TABLE mobile_device_assignments ADD COLUMN IF NOT EXISTS area VARCHAR(100) NULL AFTER turno;
ALTER TABLE mobile_device_assignments ADD COLUMN IF NOT EXISTS sede VARCHAR(100) NULL AFTER area;
ALTER TABLE mobile_device_assignments ADD COLUMN IF NOT EXISTS estado_final VARCHAR(20) NULL AFTER returned_date;

-- Asignaciones vigentes: el lugar actual del equipo (es donde esta).
UPDATE mobile_device_assignments a JOIN mobile_devices d ON d.id = a.device_id
SET a.area = d.area, a.sede = d.sede
WHERE a.returned_date IS NULL AND a.area IS NULL AND a.sede IS NULL;

-- Asignaciones ya cerradas: no se guardaba el lugar. Si la persona esta en
-- el directorio de empleados se toma su area y sede (lo mas cercano que
-- hay); si no, queda vacio ("sin dato").
UPDATE mobile_device_assignments a JOIN employees e ON e.id = a.employee_id
SET a.area = e.area, a.sede = e.sede
WHERE a.returned_date IS NOT NULL AND a.area IS NULL AND a.sede IS NULL;

-- Como terminaron las ya cerradas, cuando se puede saber: si despues hubo
-- otra asignacion del mismo equipo, paso a otra persona.
UPDATE mobile_device_assignments a
SET a.estado_final = 'reasignado'
WHERE a.returned_date IS NOT NULL AND a.estado_final IS NULL
  AND EXISTS (SELECT 1 FROM (SELECT device_id, id FROM mobile_device_assignments) b WHERE b.device_id = a.device_id AND b.id > a.id);
