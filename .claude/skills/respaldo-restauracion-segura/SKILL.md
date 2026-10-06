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

## Respaldo completo de la aplicación (formato y lo que ya costó)

- **Un respaldo que sirve para recuperar un servidor perdido trae también
  los secretos**: sin el `CREDENTIALS_ENC_KEY` del `.env`, las API keys
  guardadas cifradas en la base son ilegibles. Van en
  `secretos.env.enc`, cifrados con una contraseña de recuperación que el
  usuario guarda fuera del servidor, en **formato de OpenSSL**
  (`Salted__` + PBKDF2-SHA256 200 000 + AES-256-CBC): se abren sin la
  aplicación (`src/services/fullBackupService.js`, `encryptOpenssl`).
- Un solo motor de destinos externos: el de DevOps Sidecar (rclone). La
  aplicación solo genera y restaura el `.tar.gz`
  (`/interno/respaldo/generar|restaurar`, pase `app-backup`); el sidecar
  lo programa, lo guarda en cadenas con SHA-256, lo envía y lo restaura.
- **Verificar antes de restaurar**: SHA-256 de cada archivo contra el
  manifest y rechazar nombres que tar tenga que "limpiar" (`../`, `/`):
  busybox tar los neutraliza al extraer, pero un respaldo propio nunca
  los trae, así que se rechaza el archivo entero.
- **Después de restaurar, migrar**: un respaldo de una versión anterior
  queda con el esquema viejo; `restoreArchive` corre las migraciones.
- **Carpetas de cadena únicas**: dos ejecuciones en el mismo segundo
  compartían carpeta y la retención borraba la más nueva
  (`backup_jobs.unique_stamp`).
- Pruebas: `tests/respaldo_completo.e2e.js` (incluye restauración de ida y
  vuelta y un tar con `../` armado a mano) y
  `devops-sidecar/tests/test_respaldo_aplicacion.py`.

## Respaldar sistemas externos (bases en Azure, WordPress en un hosting)

- **Solo leer del origen**: usuario de solo lectura (Probar avisa si puede
  escribir) y ningun modo que escriba en el sistema de origen; esos
  respaldos se verifican o se descargan, y su `RESTAURAR.txt` dice como
  levantarlos en una base u hosting NUEVO.
- **Contrasenas fuera de la linea de comandos** cuando la herramienta lo
  permite: archivo de opciones 0600 para `mariadb-dump`, `PGPASSWORD` para
  `pg_dump`. `sqlpackage` solo las acepta como argumento.
- **`mariadb-dump` 11 escribe una primera linea "sandbox"** (la forma
  antigua la rechazaba el cliente de MySQL): se quita cuando el origen es
  MySQL, y el volcado se prueba con el cliente oficial de MySQL. Sin `--databases`
  (sin `CREATE DATABASE`/`USE`) el volcado se restaura en cualquier base.
  Las opciones como `connect-timeout` en `[client]` las acepta `mariadb`
  pero no `mariadb-dump` (falla con "unknown variable").
- **`pg_dump` no respalda un servidor mas nuevo que el**: el cliente sale
  del repositorio oficial PGDG (18), no el de Debian.
- **Verificar es leerlo entero**, no solo el SHA-256: pie `Dump completed`,
  `pg_restore --list`, zip del `.bacpac`, tar sin rutas `..`.
- **Probar contra servidores reales** y restaurar cada respaldo en una base
  nueva comparando datos (`tests/test_sistemas_externos.py`). `rclone serve
  ftp` con certificado hace TLS implicito y rechaza PBSZ: no sirve para
  probar FTPS; se usa Pure-FTPd (el de cPanel) con `--tls=2`.

