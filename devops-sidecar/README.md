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
  la auditoría, guardado como archivo) y mirror semanal completo
  comprimido (`.tar.gz`, domingo 02:00 por defecto) con retención de 30
  días — también disponible como script standalone
  (`scripts/weekly_backup.sh`) para correr por cron del sistema operativo
  en vez del scheduler interno.

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
- Una llamada real a Gemini/Claude/Ollama (el contrato REST de cada API
  se verificó contra la documentación oficial, pero no se hizo una
  llamada real con una API key válida).
- Un webhook real de Coolify — se confirmó que Coolify sí tiene un canal
  de notificación "Webhook" genérico y configurable, pero **no el
  esquema exacto de campos** que manda (la documentación pública no lo
  expuso al buscarlo). El endpoint guarda el payload completo tal cual
  llega (columna `raw_payload`) precisamente por esto: en cuanto
  configures el webhook real, revisa un payload real ahí y ajusta el
  mapeo de campos en `app/routers/webhooks.py` (función `_first`) si
  hace falta — está escrito para que ajustar eso sea un cambio de una
  sola línea.
- Un repositorio privado con token de GitHub real.

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

En Coolify: **Notifications → Webhook** → URL
`https://tu-servidor:8091/webhooks/coolify` → agrega el header
`X-Webhook-Token` con el mismo valor de tu `WEBHOOK_SECRET` → activa los
eventos de despliegue que quieras recibir.

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
