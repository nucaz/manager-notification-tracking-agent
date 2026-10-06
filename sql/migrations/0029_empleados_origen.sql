-- Ver sql/schema.sql para la explicacion completa.
--
-- De donde salio cada empleado: NULL = directorio (planilla o registro
-- manual); 'clinic' = creado al importar el listado de Clinic con la opcion
-- "Vincular y crear". Asi el cruce "usuarios de Clinic sin empleado en
-- planilla" no se engana con los empleados que se crearon desde Clinic.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NULL AFTER cargo,
  ADD INDEX IF NOT EXISTS idx_employee_source (source);
