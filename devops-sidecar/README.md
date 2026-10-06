# DevOps Sidecar

Módulo adicional de `glpi-licencias-app`: audita con IA los repositorios
de GitHub del equipo, recibe el historial de despliegues de Coolify vía
webhook, calcula un leaderboard de actividad por desarrollador, y hace
respaldos incrementales/totales de cada repo.

**Stack distinto a propósito** (Python/FastAPI/SQLite, no Node/Express/
MySQL): vive en este mismo repositorio, como un segundo servicio en el
mismo `docker-compose.yml` de `glpi-licencias-app`, en su propio puerto
(`8091` por defecto). No comparte base de datos ni proceso con la app
principal — solo el repositorio de Git y el despliegue.

## 1. Qué hace

- **Registro de repositorios**: agregas la URL de un repo de GitHub
  (público o privado, con un Personal Access Token) y cada cuánto
  sincronizarlo (minutos/horas). El propio módulo lo clona la primera vez
  y lo actualiza (`git fetch` + `git reset --hard` a la rama por
  defecto) en cada ciclo — no hace falta que los repos ya estén clonados
  de antemano en el servidor.
- **Webhook de Coolify**: `POST /webhooks/coolify` recibe cada evento de
  despliegue (éxito o fallo) y lo guarda con su payload completo.
- **Auditoría semántica diaria con IA** (18:00 por defecto): por cada
  repo, extrae `git log --since=1.day.ago -p` y le pide a Gemini/Claude/
  Ollama (configurable; con acceso único, el modelo se elige en la
  aplicación principal, Configuración > Inteligencia artificial, y este
  módulo le pide que genere por él) un reporte en Markdown con desarrolladores del
  día, análisis de impacto en la lógica de negocio, y alertas DevSecOps.
  Además corre un **escaneo de secretos determinístico** (regex, sin IA)
  sobre el mismo diff — no depende solo de que la IA "se dé cuenta".
- **Leaderboard**: puntaje por desarrollador (día/semana/mes/año/total),
  fórmula simple y ajustable en `app/scoring.py`.
- **Respaldos**: diferencial diario (el mismo diff que ya se generó para
  la auditoría, guardado como archivo), mirror git semanal completo
  comprimido (`.tar.gz`, domingo 02:00 por defecto, solo lo puede leer
  git) y respaldo de **archivos reales** (los archivos del repo tal
  cual, sin necesitar git para abrirlos) — los tres con retención
  configurable y disparables al instante desde la ficha de cada repo, sin
  esperar al horario. También disponible como script standalone
  (`scripts/weekly_backup.sh`) para correr por cron del sistema operativo
  en vez del scheduler interno.
- **Restaurar un respaldo**: reemplaza el clon local por el contenido de
  un mirror o de un respaldo de archivos reales (no aplica a los
  diferenciales, que son solo un diff de texto). Pausa el auto-sync del
  repo después, para no perder la restauración en el próximo ciclo.
- **Explorador de archivos** del clon (navegar carpetas, ver contenido de
  archivos de texto) y **explorador de commits** (ver el diff de
  cualquier commit, descargar el código tal como estaba en ese punto con
  `git archive` — de solo lectura, no toca nada).
- **Rollback y revert**, en tres niveles de riesgo creciente:
  1. Ver/descargar una versión anterior (solo lectura, sin riesgo).
  2. Rollback del **clon local** a un commit específico (`git reset
     --hard`) — pausa el auto-sync de ese repo automáticamente (si no, el
     próximo ciclo lo deshace solo); se reanuda con un botón que vuelve a
     sincronizar con la punta real de GitHub.
  3. Revertir de verdad: primero se crea un commit de reversión en el
     **clon local** (`git revert`, no reescribe historial), y solo con
     una confirmación aparte (escribir el nombre del repo) se sube a
     GitHub con `git push` — acción real e irreversible sobre el
     repositorio remoto, pensada para cuando ya se revisó que el revert
     local quedó bien. **No probado contra un push real** en esta sesión
     a propósito (afectaría el repositorio real de un tercero) — sí se
     probó y confirmó la creación del commit de reversión local.

## 2. ⚠️ Cosas verificadas y cosas NO verificadas

**Verificado en Docker antes de entregar esto** (no es solo código sin
probar): arranque del servicio y del scheduler, autenticación HTTP Basic
del dashboard, rechazo/aceptación del webhook con y sin token, clonado
real de un repositorio público de GitHub, sincronización posterior
(`fetch` + `reset`, detectando la rama por defecto), extracción de
estadísticas de commits por autor, el motor de auditoría completo (con
el cliente de IA simulado, ya que no había una API key real disponible
en el momento de construir esto), el escaneo de secretos (detecta y
enmascara una AWS key de prueba), el leaderboard, el respaldo diferencial
diario y el mirror semanal comprimido, y que el HTML de un reporte
sanea correctamente un intento de inyección (`<script>`) antes de
mostrarlo.

**NO verificado** (requiere credenciales/infraestructura real que no
estaban disponibles):
- Un repositorio privado con token de GitHub real.

**Ya verificado con datos reales** (no solo teoría):
- Una llamada real a Gemini (`gemini-2.5-pro`, con la API key configurada
  en `.env`): se ejecutó una auditoría real sobre un repositorio real y
  generó un reporte coherente, identificando al autor correcto de los
  commits del día.
- El esquema exacto del payload que manda el webhook de Coolify: **no se
  instaló una instancia de Coolify** para esto — se verificó
  directamente contra el código fuente público de Coolify
  (`coollabsio/coolify` en GitHub, vía `gh api`/`gh search code`), leyendo
  `app/Notifications/Application/DeploymentSuccess.php` y
  `DeploymentFailed.php` (método `toWebhook()`), y
  `app/Notifications/Channels/WebhookChannel.php` +
  `app/Jobs/SendWebhookJob.php` para el transporte. Es más confiable que
  una sola prueba en vivo porque es el código que Coolify realmente
  ejecuta, no una suposición. Payload real (siempre estos campos, más
  algunos opcionales si es un preview de pull request):
  ```json
  {
    "success": true,
    "message": "New version successfully deployed",
    "event": "deployment_success",
    "application_name": "mi-app",
    "application_uuid": "...",
    "deployment_uuid": "...",
    "deployment_url": "https://tu-coolify/project/.../deployment/...",
    "project": "Mi Proyecto",
    "environment": "production",
    "fqdn": "https://mi-app.ejemplo.com"
  }
  ```
  Para fallos, `success` es `false` y `event` es `"deployment_failed"`.
  **Importante:** Coolify **nunca** manda el commit ni el autor del push
  en este payload — no es una limitación de este módulo, Coolify
  simplemente no lo incluye. Además, `WebhookNotificationSettings` (el
  modelo que guarda la config del canal en Coolify) solo tiene un campo
  `webhook_url` — **no soporta headers personalizados**, así que el
  token de este endpoint solo puede validarse por query string, nunca
  por header (ver `WEBHOOK_SECRET` en `.env.example`).

## 3. Uso

### 3.1 Configurar

```bash
cd devops-sidecar
cp .env.example .env
nano .env   # WEBHOOK_SECRET, DASHBOARD_USER/PASSWORD, GEMINI_API_KEY (o Claude/Ollama)
```

### 3.2 Levantar (junto con el resto de glpi-licencias-app)

```bash
# Desde la raíz del repo (glpi-licencias-app/), no desde devops-sidecar/
docker compose up -d --build devops-sidecar
```

Va a quedar disponible en `http://IP_DEL_SERVIDOR:8091` (usuario/
contraseña los que pusiste en `DASHBOARD_USER`/`DASHBOARD_PASSWORD`).
Desde `glpi-licencias-app` (solo admin) hay un enlace "DevOps" en el
menú superior que abre esto en una pestaña nueva.

### 3.3 Agregar un repositorio

Desde el dashboard → **Repositorios** → completa nombre, URL de GitHub
(y el token si es privado), y cada cuánto sincronizarlo. Se clona de
inmediato en segundo plano.

### 3.4 Configurar el webhook en Coolify

En Coolify: **Notifications → Webhook** → **Webhook URL**, con el token
incluido en la propia URL (Coolify no soporta headers personalizados en
este canal):
```
https://tu-servidor:8091/webhooks/coolify?token=TU_WEBHOOK_SECRET
```
→ activa "Deployment success"/"Deployment failure" (y los demás eventos
que quieras) en la configuración de notificaciones del proyecto/equipo.

### 3.5 Respaldar/migrar la configuración a otro servidor

Desde **Configuración** → "Respaldo de la aplicación" hay un botón
**"Descargar respaldo completo"**: genera un `.tar.gz` con una copia
consistente de `sidecar.db` (repositorios registrados, proveedor de IA,
historial de despliegues/auditorías) — todo lo que hace a este módulo,
en un solo archivo. No incluye los repositorios clonados ni los
archivos de respaldo/reportes en disco (son datos, no configuración —
se regeneran solos al re-sincronizar).

Para restaurarlo (en este servidor o en uno nuevo que ya tenga la app y
Docker instalados): mismo panel → sube el archivo, escribe
`RESTAURAR SIDECAR` para confirmar. Antes de aplicar, se guarda
automáticamente un snapshot de cómo estaba la base justo antes (en
`/data/backups/_pre_restore_sidecar/`), por si hace falta volver atrás.

**Importante si usas `CREDENTIALS_ENC_KEY`** (cifra las API keys de IA
en la base de datos, ver Sección 4): el servidor donde restaures debe
tener la **misma** clave en su `.env` que el servidor de origen — si no,
las API keys guardadas quedan cifradas e ilegibles, y hay que volver a
escribirlas desde Configuración.

### 3.6 Respaldos externos y trabajos programados

**Respaldos → Destinos externos**: cuentas adonde enviar los respaldos,
fuera del servidor. Usa `rclone` (incluido en la imagen, versión fija y
SHA-256 verificado en el build). Puede haber varios destinos del mismo
tipo:

| Tipo | Cómo se autoriza |
|---|---|
| OneDrive personal y Microsoft 365 (varias cuentas) | En un PC con navegador: `rclone authorize "onedrive"`, iniciar sesión con la cuenta y pegar el JSON. La unidad y la cuenta se detectan solas |
| Microsoft 365 con aplicación aprobada por el administrador (OneDrive de un usuario o biblioteca de SharePoint) | Registrar una aplicación en Entra ID con permiso **de aplicación** `Files.ReadWrite.All` (OneDrive) o `Sites.ReadWrite.All` / `Sites.Selected` (SharePoint) y consentimiento del administrador. Se cargan tenant, ID de aplicación, secreto y el correo o la URL del sitio. No depende de una sesión de usuario: solo vence el secreto |
| Google Drive | `rclone authorize "drive"` y pegar el JSON |
| S3 (AWS, Backblaze B2, Wasabi, R2, MinIO) | Access key y secret; en S3 con *object lock* los respaldos quedan inmutables |
| SFTP | Usuario y contraseña o llave; recomendado pegar la huella (`ssh-keyscan`) |
| Carpeta compartida de Windows / NAS (SMB) | Usuario y contraseña |
| WebDAV / Nextcloud | Usuario y contraseña o token de app |
| Disco local o USB | Montarlo en el contenedor (ver `docker-compose.yml`) y usar su ruta |

Cada destino puede **cifrar** los respaldos (rclone crypt: contenido y
nombres de archivo). Guarde la contraseña fuera del servidor: sin ella
los respaldos cifrados son irrecuperables. **Probar** crea, lee y borra
un archivo de prueba.

**Respaldos → Trabajos programados**: qué repos, qué contenido, cuándo
(diario, semanal, mensual o cron) y adónde. Estilo Veeam: cada repo forma
**cadenas** de un completo + N incrementales:

- Completo: `git bundle --all` (todo el historial, ramas y tags).
- Incremental: `git bundle` solo con los commits nuevos desde el punto
  anterior. Si no hubo commits, no se crea.
- Opcionales: `.diff` legible, archivos sin `.git` (solo en completos) y
  copia de `sidecar.db`.
- Retención por cadenas enteras, por separado en el servidor y en los
  destinos: nunca se borra un completo del que dependa un incremental.
- Lo que no llegó a un destino (por ejemplo, OneDrive caído) se reenvía
  en la siguiente ejecución, y cada envío se verifica (`rclone check` o
  `cryptcheck`).

**Restaurar sin el sidecar**: cada carpeta de cadena trae `RESTAURAR.txt`
y `manifest.json` (con SHA-256). Con los bundles de la cadena:

```bash
git init --bare restaurado.git
git -C restaurado.git fetch "$PWD/00_completo_....bundle" "+refs/*:refs/*"
git -C restaurado.git fetch "$PWD/01_incremental_....bundle" "+refs/*:refs/*"   # en orden
git clone restaurado.git trabajo
```

Si el destino está cifrado, descargar primero con rclone usando un remoto
`crypt` con la misma contraseña (y la segunda contraseña, si se usó).

**Respaldos → Restaurar**: aplica el completo y los incrementales en orden
hasta el punto elegido, desde el servidor o desde cualquier destino
(también cifrado). Antes verifica el SHA-256 de cada archivo contra el
`manifest.json`, y después corre `git fsck`. Tres modos:

- **Probar restauración**: reconstruye y comprueba, sin dejar archivos.
  Conviene hacerlo cada tanto: un respaldo que nunca se probó no es un
  respaldo.
- **Preparar descarga**: un `.git.tar.gz` con el repositorio completo
  (todas las ramas y etiquetas) y un `.zip` con los archivos de la rama
  principal. Se borran solos a los 3 días.
- **Subir a un repositorio Git** (idealmente uno nuevo y vacío), con
  `git push --atomic` y sin forzar: si el destino tiene ramas con otro
  historial no se sube nada. El token se usa solo en memoria.

Si se perdió el servidor: instalar el sidecar, crear el destino con las
mismas credenciales (y la misma contraseña de cifrado) y usar
**Explorar**, que lista las cadenas del destino sin necesitar la base
anterior. La copia de `sidecar.db` también se puede verificar y descargar
desde ahí.

Pruebas de extremo a extremo (WebDAV, SFTP y S3 reales con `rclone serve`,
cifrado, restauración, caída de un destino y retención):
`docker compose exec devops-sidecar python tests/test_respaldos_externos.py`

#### Sistemas externos: bases en Azure y sitios WordPress

**Respaldos > Sistemas externos** registra bases y sitios que viven fuera
de este servidor; se marcan en un trabajo programado como cualquier otro
contenido (mismo horario, destinos, cifrado, SHA-256 y retención). Cada
ejecución es un completo por sistema, con `RESTAURAR.txt` y
`manifest.json`.

| Tipo | Cómo se copia | Archivo |
|---|---|---|
| MySQL / MariaDB (Azure Database for MySQL, cPanel) | `mariadb-dump --single-transaction` (consistente, sin detener la app), sin `CREATE DATABASE`: se restaura en cualquier base | `.sql.gz` |
| PostgreSQL (Azure Database for PostgreSQL) | `pg_dump` 18 en formato personalizado (respalda servidores hasta la 18) | `.dump` |
| Azure SQL / SQL Server | `sqlpackage` Export | `.bacpac` |
| WordPress en un hosting (cPanel) | archivos por FTPS/SFTP a un espejo local (solo baja lo que cambió) + la base MySQL (datos de `wp-config.php` si no se indican) | `_archivos.tar.gz` + `_basedatos.sql.gz` |

- **Solo lectura**: use un usuario de solo lectura (la ayuda de cada tipo
  trae el `GRANT`); **Probar** avisa si el usuario puede escribir. Nunca se
  escribe en el sistema de origen: en Restaurar estos respaldos se
  **verifican** (SHA-256 y lectura completa: `pg_restore --list`, el pie
  `Dump completed`, el zip del `.bacpac`) o se **descargan**; no se suben a
  Git ni se "aplican".
- **Firewall**: Azure y cPanel ("MySQL remoto") deben permitir la IP
  pública de salida de la empresa. Si no responde, el error lo sugiere.
- **TLS**: por defecto se verifica el certificado (Azure). Para un hosting
  con certificado propio: "Cifrado sin verificar"; FTP sin cifrar existe
  pero no se recomienda.
- **Azure SQL**: un `.bacpac` no es una foto en un instante; si la base
  recibe escrituras durante la exportación, exporte una copia
  (`CREATE DATABASE copia AS COPY OF base`). `sqlpackage` solo existe para
  x64.
- El respaldo de WordPress incluye `wp-config.php` (con la clave de la
  base): envíelo a un destino cifrado.

Pruebas contra servidores reales desechables (MySQL 8.4, MariaDB 11.4,
PostgreSQL 18, SQL Server 2022 y Pure-FTPd con TLS obligatorio, el FTP de
cPanel), incluida la restauración de cada respaldo en una base nueva:
ver el comentario al inicio de `tests/test_sistemas_externos.py`.

### 3.7 Mirror de respaldo y cuenta colaboradora → principal

En la página de cada repositorio, sección **Mirror de respaldo y
sincronización con la cuenta principal**:

- **Mirror de respaldo**: copia todas las ramas y etiquetas a *otro*
  repositorio (GitHub, GitLab, Azure DevOps, Gitea o un repositorio bare
  en un disco montado), manualmente o después de cada sincronización.
  - *Protegido* (recomendado): nunca pierde nada. Una rama borrada en el
    origen se conserva. Si el origen reescribe historial (force-push), la
    versión anterior queda en `sidecar-conservado/<rama>-<fecha>` y la
    rama sigue recibiendo commits.
  - *Exacto* (`git push --mirror`): el destino queda idéntico al origen,
    borrados incluidos. **Probar** lista qué ramas borraría. Si el origen
    queda sin ramas, no se envía nada.
  - No se permite un mirror hacia un repositorio registrado en el sidecar
    ni hacia el principal de una sincronización.
- **Colaborador → principal**: si este repositorio es el de una cuenta
  colaboradora, sube sus commits nuevos al repositorio de la cuenta que
  compartió el acceso. Por defecto a la rama `sidecar-sync/<rama>` y abre
  el **Pull Request** (GitHub por API; GitLab con *push options*; en otros
  servidores se informa para abrirlo a mano). Si el PR ya existe, queda
  actualizado. En modo *directo* solo sube si es avance rápido; nunca
  fuerza. Para un repositorio **personal de otra cuenta** hace falta un
  **token clásico con alcance `repo`**: los tokens de grano fino no
  acceden a repositorios personales ajenos (**Probar** lo detecta y
  también avisa si el token solo tiene lectura).

Cada destino Git trabaja en su propio repositorio bare
(`/data/repos/.sidecar-git-targets/<id>.git`), separado del clon que se
audita. El token va cifrado y viaja por cabecera, igual que el de GitHub.

Pruebas (repos bare locales como remotos; la API de GitHub y Microsoft
Graph simuladas): `docker compose exec devops-sidecar python tests/test_git_y_restauracion.py`

## 4. Seguridad (decisiones deliberadas)

- El dashboard/API (todo menos el webhook) está detrás de **HTTP Basic
  Auth** — este módulo maneja diffs de código y alertas de secretos, no
  es información para dejar sin ninguna protección aunque corra en red
  interna.
- El webhook de Coolify usa un **token compartido** (`X-Webhook-Token` o
  `?token=`) en vez de Basic Auth, porque lo llama Coolify de forma
  programática, no un humano desde un navegador.
- Los reportes de auditoría (generados por una IA a partir del código de
  terceros) se **sanean con `bleach`** antes de mostrarse en HTML — una
  inyección de prompt en un commit/comentario no puede terminar
  ejecutando `<script>` en el navegador de quien lea el reporte.
- El token de GitHub de cada repo se guarda **cifrado** en SQLite
  (`enc:v1:...`, con `CREDENTIALS_ENC_KEY`) y git lo recibe por una
  cabecera `Authorization` pasada en variables de entorno
  (`GIT_CONFIG_COUNT/KEY/VALUE`), **nunca dentro de la URL**. Antes iba en
  la URL y `git clone` lo dejaba guardado en `.git/config` de cada clon.
  Al arrancar, la app cifra los tokens que sigan en texto plano y quita el
  token de la URL de `origin` de todos los clones, incluidos los huérfanos
  de repos ya eliminados de la app.
- Las credenciales de los destinos externos (tokens OAuth, claves S3,
  contraseñas) también van cifradas, y la API nunca las devuelve. Para
  SFTP se puede fijar la huella del servidor (`known_hosts`); sin ella
  rclone no verifica la identidad del servidor.
- Mirror y sincronización con la cuenta principal nunca fuerzan sobre un
  repositorio de trabajo: el mirror exacto no se permite hacia un
  repositorio registrado; la sincronización colaborador → principal va a
  una rama aparte + Pull Request, o directo solo con avance rápido. Una
  restauración que se sube a Git es atómica y sin forzar.
- Los comandos de git corren siempre con `subprocess` pasando argumentos
  como lista (nunca un string armado a mano ni `shell=True`) — sin
  riesgo de inyección de comandos aunque la URL de un repo viniera de un
  campo de formulario.

## 5. Estructura

```
devops-sidecar/
  app/
    main.py             FastAPI app, arranca el scheduler al iniciar
    config.py            Configuración via .env (pydantic-settings)
    database.py           SQLAlchemy + SQLite
    models.py              Repo, Deployment, CommitStat, AuditReport, BackupRun
    scoring.py              Fórmula del leaderboard
    auth.py                  HTTP Basic Auth del dashboard
    scheduler.py              APScheduler: sync por repo + auditoria diaria + backup semanal
    services/
      git_service.py          Clonar/sincronizar, extraer diffs y stats de commits
      ai_client.py              IA de la aplicación principal (configuración única); Gemini/Claude/Ollama directo solo de emergencia
      secret_scanner.py          Escaneo de secretos por regex (sin IA)
      audit_engine.py             Orquesta el reporte diario de un repo
      backup_service.py            Diff diario + mirror semanal + retención
    routers/
      webhooks.py               POST /webhooks/coolify
      repos.py                    API JSON de repos (CRUD + sync manual)
      deployments.py               API JSON de despliegues
      dashboard.py                  Páginas HTML (Jinja2 + Bootstrap)
    templates/                       Vistas HTML
  scripts/
    weekly_backup.sh                Alternativa standalone al backup semanal (cron de SO)
  Dockerfile
  requirements.txt
  .env.example
```
