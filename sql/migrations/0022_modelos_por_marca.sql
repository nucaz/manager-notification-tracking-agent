-- Ver sql/schema.sql para la explicacion completa.

-- Catalogo de modelos de celular ligado a su marca. Antes los modelos eran
-- una lista suelta (catalog_items, tipo "modelo") y el formulario ofrecia
-- todos los modelos para cualquier marca.
CREATE TABLE IF NOT EXISTS mobile_models (
  id INT AUTO_INCREMENT PRIMARY KEY,
  brand VARCHAR(100) NOT NULL,
  model VARCHAR(20) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_mobile_model_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_mobile_model (brand, model),
  INDEX idx_mobile_model_model (model)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 1) Los pares marca/modelo que ya usan los celulares registrados.
INSERT IGNORE INTO mobile_models (brand, model)
SELECT TRIM(brand), TRIM(model) FROM mobile_devices
WHERE brand IS NOT NULL AND TRIM(brand) <> '' AND model IS NOT NULL AND TRIM(model) <> ''
GROUP BY TRIM(brand), TRIM(model);

-- 2) Los modelos del catalogo anterior que ningun celular usaba con marca:
--    la marca se deduce del nombre (Galaxy = Samsung, iPhone = Apple). Los
--    que no se pueden deducir quedan para cargarlos a mano.
INSERT IGNORE INTO mobile_models (brand, model, active)
SELECT x.brand, x.model, x.active FROM (
  SELECT CASE WHEN c.value LIKE 'Galaxy%' THEN 'Samsung' WHEN c.value LIKE 'iPhone%' THEN 'Apple' ELSE NULL END AS brand,
         c.value AS model, c.active
  FROM catalog_items c
  WHERE c.catalog_type = 'modelo' AND NOT EXISTS (SELECT 1 FROM mobile_models m WHERE m.model = c.value)
) x WHERE x.brand IS NOT NULL;
