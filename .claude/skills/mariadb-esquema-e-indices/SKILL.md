---
name: mariadb-esquema-e-indices
description: 'Usar al crear o cambiar una tabla, una columna o un índice de la base MariaDB de la app principal, al agregar una búsqueda o filtro nuevo, al tocar la pantalla Mantenimiento BD o la retención de históricos, o cuando alguien pida "optimizar la base de datos". Ejemplos - "agrega una tabla para X", "esta pantalla está lenta", "agrega un índice", "borra los registros viejos de Y".'
---

# Esquema, índices y mantenimiento de MariaDB en este proyecto

Reglas que ya están fijadas por una prueba (`tests/mantenimiento.e2e.js`):
si una se rompe, esa prueba falla.

## Reglas del esquema

1. **Tope de 30 columnas por tabla; aviso desde 21.** Hoy la más ancha
   tiene 24 (`attachments`). Si una tabla necesita crecer más allá de 20,
   primero pregúntate si lo nuevo es otra cosa (otra tabla 1:1 o 1:N) y
   no "una columna más". La pantalla Mantenimiento BD marca en amarillo
   las de más de 20 y en rojo las que pasan de 30.
2. **Toda tabla con clave primaria, InnoDB y `utf8mb4`.**
3. **Toda clave foránea con un índice que empiece por su columna** (InnoDB
   lo crea solo al declarar la FK; no lo borres).
4. **Dos cambios por cada cambio de esquema**: `sql/schema.sql` (línea
   base) + una migración numerada en `sql/migrations/` con cláusulas
   idempotentes (`ADD COLUMN IF NOT EXISTS`, `ADD INDEX IF NOT EXISTS`).
   Ver `sql/migrations/README.md`.

## Cuándo un índice sirve (y cuándo no)

- **Sirve**: igualdad (`imei = ?`), prefijo (`asset_code LIKE 'A-%'`),
  rango de fechas (`created_at < ?`), `ORDER BY` sobre esas columnas, y la
  combinación que usa la consulta (`line_id, returned_date`).
- **No sirve**: "contiene" (`LIKE '%texto%'`). Los buscadores de los
  listados usan eso a propósito; siguen leyendo la tabla. Con tablas de
  cientos o miles de filas no se nota. No agregues un índice "por si
  acaso" para ese caso: no se va a usar.
- **Compruébalo, no lo supongas**: `EXPLAIN SELECT ...` contra la base
  real y mira la columna `key`. Con pocas filas o poca variedad de
  valores el motor puede elegir leer la tabla aunque el índice exista;
  eso no es un error. La prueba comprueba `key` en las búsquedas exactas
  y `possible_keys` en el resto.
- Un nombre de índice no debe ser prefijo de otro
  (`idx_mobile_device_phone` vs `idx_mobile_device_phone_country`):
  complica buscarlo y verificarlo.

## Mantenimiento desde la aplicación

`/mantenimiento` (solo admin; `src/services/maintenanceService.js`):
estado de tablas e índices, **Analizar** (`ANALYZE TABLE`: estadísticas,
rápido) y **Optimizar** (`OPTIMIZE TABLE`: reconstruye tabla e índices y
recupera espacio; mientras dura, esa tabla no acepta escrituras: fuera de
horario).

- El nombre de tabla que llega del navegador **se compara contra la lista
  real de tablas** y se pasa como identificador (`??` de mysql2), nunca
  concatenado.
- Solo existen esas dos acciones. Cada ejecución queda en `audit_log`.

## Retención de históricos

- Sujetos a retención (3 meses por defecto, `history_retention_months`;
  0 = sin borrado automático): `audit_log`, `agent_message_log`,
  `agent_message_log_archive`, y los `trusted_devices` vencidos. Tarea
  diaria 01:15 (`src/jobs/purgeHistory.js`).
- **Antes de sumar una tabla a la retención, pregunta si es historial o
  estado.** `reminder_log` parece un historial y no lo es: es el registro
  de "este aviso ya se envió" (clave única por entidad y umbral). Borrarlo
  haría que un recordatorio viejo se envíe otra vez. Los datos de trabajo
  (celulares, chips, recibos) tampoco entran: las comparaciones mes a mes
  dependen de ellos.
- El borrado **a demanda** es una acción irreversible: frase de
  confirmación exacta (`BORRAR HISTORIAL`) y copia previa automática con
  `backupService.snapshot()` (skill `respaldo-restauracion-segura`).

## En producción

Respaldo antes de migrar (`mariadb-dump --single-transaction`), nunca
`docker compose down -v` ni borrar volúmenes, y comprobar después que los
conteos de las tablas principales siguen iguales. El playbook personal
`dba-safety-playbook` (SQL Server) aplica en sus principios: simulación o
confirmación para lo irreversible, todo registrado, respaldo previo.
