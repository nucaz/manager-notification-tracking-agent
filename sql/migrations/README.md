# Migraciones incrementales

`sql/schema.sql` es la línea base completa (migración `0001_baseline`,
implícita — no hay un archivo `0001_*.sql` en esta carpeta, el runner usa
`sql/schema.sql` directamente para ese paso). Sirve para dejar una base de
datos **nueva** lista de una sola vez.

Cuando un cambio de esquema (columna nueva, tabla nueva, índice nuevo)
afecta una tabla que **ya pudo existir** en una base de datos ya
desplegada, hacen falta **dos** cambios, no uno:

1. Actualizar `sql/schema.sql` con el cambio completo (para que una
   instalación nueva lo tenga desde el principio).
2. Agregar un archivo nuevo en esta carpeta con **solo el cambio
   puntual**, numerado en orden (`0002_...`, `0003_...`, etc.), para que
   una base de datos que ya tenía la tabla también reciba el cambio la
   próxima vez que corra `npm run migrate`.

Cada migración se registra en la tabla `schema_migrations` para no
volver a aplicarse. Escribe cada migración con cláusulas **idempotentes**
de MariaDB, para que sea inofensivo si se llegara a correr de más (por
ejemplo, en una base de datos nueva donde `0001_baseline` ya trajo ese
mismo cambio):

```sql
-- Agregar una columna
ALTER TABLE users ADD COLUMN IF NOT EXISTS ejemplo VARCHAR(50) NULL;

-- Agregar un índice
ALTER TABLE users ADD INDEX IF NOT EXISTS idx_ejemplo (ejemplo);

-- Tabla nueva (igual que en schema.sql)
CREATE TABLE IF NOT EXISTS ejemplo (...);
```

Ejemplo de nombre de archivo: `0002_agrega_columna_ejemplo_a_users.sql`.
