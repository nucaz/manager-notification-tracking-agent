-- Ver sql/schema.sql para la explicacion completa.

-- Celulares que quedaron "en stock" o "de baja" con una asignacion todavia
-- abierta (se les cambio el estado desde Editar, que antes no la cerraba):
-- en listados y reportes seguian mostrando a la persona como usuario
-- actual. Se cierra esa asignacion, que queda en el historial, con la fecha
-- de la ultima modificacion del equipo (cuando se cambio el estado), nunca
-- anterior a la fecha de entrega. Es idempotente: solo toca las abiertas.
INSERT INTO audit_log (action, target, detail)
SELECT 'asignaciones_cerradas_migracion', CONCAT(COUNT(*), ' asignación(es)'),
       CONCAT('Celulares en stock o de baja con asignación abierta: ', GROUP_CONCAT(d.imei ORDER BY d.id SEPARATOR ', '))
FROM mobile_device_assignments a JOIN mobile_devices d ON d.id = a.device_id
WHERE a.returned_date IS NULL AND d.status IN ('en_stock', 'de_baja')
HAVING COUNT(*) > 0;

UPDATE mobile_device_assignments a JOIN mobile_devices d ON d.id = a.device_id
SET a.returned_date = GREATEST(COALESCE(a.assigned_date, DATE(d.updated_at)), DATE(d.updated_at)),
    a.observacion = TRIM(BOTH ' - ' FROM CONCAT_WS(' - ', a.observacion, 'Cerrada: el equipo ya estaba en stock o de baja'))
WHERE a.returned_date IS NULL AND d.status IN ('en_stock', 'de_baja');
