-- Ver sql/schema.sql para la explicacion completa.

-- El chip guarda los dos montos: costo_plan = cargo fijo mensual SIN
-- descuento; descuento_plan = descuento mensual vigente. Lo que se paga es
-- la diferencia. Asi se ve cuanto costara la linea cuando el descuento
-- termine (y cuanto se ahorra mientras dura).
ALTER TABLE mobile_lines ADD COLUMN IF NOT EXISTS descuento_plan DECIMAL(10,2) NULL AFTER costo_plan;
ALTER TABLE mobile_lines ADD COLUMN IF NOT EXISTS descuento_nota VARCHAR(150) NULL AFTER descuento_plan;
