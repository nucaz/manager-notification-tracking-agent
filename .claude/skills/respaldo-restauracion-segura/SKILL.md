---
name: respaldo-restauracion-segura
description: Diseñar o revisar una función de "descargar respaldo" / "restaurar desde archivo" para una app auto-hospedada, o una guía de migración de servidor. Usar al agregar backup/restore a un módulo nuevo, o al escribir instrucciones de migración completa a otro servidor.
---

# Respaldo y restauración seguros (patrón ya usado dos veces en este proyecto)

## Barreras de seguridad para cualquier restauración (es destructiva por definición)

1. **Frase de confirmación exacta escrita por el usuario**, no un simple
   checkbox — una segunda barrera deliberada además de estar
   autenticado, contra un click accidental en una acción irreversible.
   Cada módulo puede tener su propia frase (ej. `"RESTAURAR TODO"` en la
   app principal, `"RESTAURAR SIDECAR"` en DevOps Sidecar) para que no
   se confundan entre sí.

2. **Snapshot de seguridad automático justo ANTES de aplicar el
   cambio**, guardado en un volumen persistente (no en `/tmp` ni algo
   que se pierda al reiniciar el contenedor). Si la restauración que se
   está por aplicar es la equivocada, hay un punto de vuelta atrás
   inmediato sin depender de que el usuario tuviera OTRO respaldo a
   mano.

## Copiar la base de datos de forma segura (nunca `cp`/`shutil.copy` en caliente)

- MySQL/MariaDB: `mariadb-dump --single-transaction` (consistente aunque
  haya escrituras concurrentes).
- SQLite: la API de backup nativa, `sqlite3.Connection.backup()` en
  Python (o el equivalente en otros lenguajes) — nunca copiar el
  archivo `.db` a mano, porque puede capturarse a medio escribir si hay
  una transacción en curso.
- Después de REEMPLAZAR un archivo SQLite en caliente, hay que cerrar
  el pool de conexiones del ORM (ej. `engine.dispose()` en SQLAlchemy)
  para que ninguna conexión vieja siga apuntando al inodo anterior
  (ahora reemplazado) hasta que se reciclara sola.

## Qué SÍ y qué NO incluir en un respaldo de "configuración"

Un respaldo de "toda la configuración de este módulo" no tiene por qué
incluir datos voluminosos reproducibles (ej. clones de repos git,
archivos de reportes/backups ya generados) — esos se pueden documentar
como "se regeneran solos al re-sincronizar" en vez de empaquetarlos.
Decide explícitamente el alcance y decláralo en el propio archivo de
respaldo (manifiesto) para que quien lo use en 6 meses no asuma que
está todo ahí.

## El aviso que es fácil olvidar: la clave de cifrado

Si la app cifra secretos en reposo (ver skill `encrypt-secrets-at-rest`),
migrar a otro servidor requiere llevar la MISMA clave de cifrado, o el
contenido restaurado queda cifrado e ilegible. Este aviso va DENTRO del
propio flujo (manifiesto del backup, mensaje en la pantalla de
restaurar), no solo en un README que un administrador migrando bajo
presión podría no leer.

## Verificación obligatoria

No declares un backup/restore como funcional sin probar el round-trip
completo contra una instancia real con datos reales preexistentes (no
solo fixtures):
1. Descarga un respaldo real.
2. Inspecciona su contenido (¿tiene lo que dice tener?).
3. Restaura ESE MISMO respaldo sobre sí mismo (prueba segura, no
   destruye nada real ya que el contenido es idéntico).
4. Confirma que los datos reales (ej. registros existentes, valores
   cifrados) siguen intactos y funcionando después — incluyendo que un
   valor cifrado sigue descifrando correctamente tras el ciclo completo.
5. Confirma que el snapshot de seguridad automático realmente quedó en
   disco antes de la restauración.
