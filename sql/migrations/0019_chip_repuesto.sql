-- Ver sql/schema.sql para la explicacion completa.

-- Chips de repuesto: una persona puede guardar chips extra, mas alla de los
-- dos que admite un celular doble SIM. Se registran como asignacion a la
-- persona con uso 'repuesto'.
ALTER TABLE mobile_line_assignments
  MODIFY uso ENUM('personal','emergencia','repuesto') NOT NULL DEFAULT 'personal';
