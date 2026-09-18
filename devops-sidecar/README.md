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
  Ollama (configurable) un reporte en Markdown con desarrolladores del
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
- El token de GitHub de un repo privado se guarda en texto plano en
  SQLite — misma deuda técnica ya documentada y aceptada en
  `glpi-licencias-app` para otros secretos (ver su bitácora), no una
  omisión de esta implementación puntual.
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
      ai_client.py              Gemini/Claude/Ollama intercambiables (REST directo)
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
