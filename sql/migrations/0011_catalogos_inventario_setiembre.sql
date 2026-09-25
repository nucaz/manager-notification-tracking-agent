-- Ver sql/schema.sql para la explicacion completa.
-- Valores que aparecen en el inventario "Inventario Móvil Setiembre 2026" y
-- todavia no estaban en los catalogos (areas, marcas y modelos). Sin esto los
-- desplegables de Celulares los mostrarian como "Otro (especificar)".
INSERT IGNORE INTO catalog_items (catalog_type, value) VALUES
  ('area', 'BACKOFFICE'),
  ('area', 'C-MANAGER'),
  ('area', 'ESPECIALISTAS'),
  ('area', 'STOCK SISTEMAS'),
  ('area', 'CONEXXION'),
  ('area', 'SURCO'),
  ('area', 'MEGA PLAZA'),
  ('area', 'IZAGUIRRE'),
  ('marca', 'ZTE'),
  ('marca', 'Apple'),
  ('marca', 'Huawei'),
  ('marca', 'LG'),
  ('modelo', 'A54'),
  ('modelo', 'Galaxy A12'),
  ('modelo', 'Galaxy A10s'),
  ('modelo', 'Galaxy A04'),
  ('modelo', 'Galaxy J2'),
  ('modelo', 'Galaxy J7'),
  ('modelo', 'iPhone 13'),
  ('modelo', 'iPhone 15 Pro'),
  ('modelo', 'iPhone 17 Pro');
