# Contexto del proyecto para asistentes de IA

> Este archivo es un espejo de `CLAUDE.md` (la versión canónica), para
> herramientas que buscan específicamente `AGENTS.md` (convención usada
> por varios agentes de código, ej. OpenAI Codex CLI y otros). Si algo
> parece desactualizado, `CLAUDE.md` manda — avisa para sincronizarlos.

## Qué es esto

Repositorio `nucaz/manager-notification-tracking-agent`, con **dos
aplicaciones independientes** que corren como servicios separados en el
mismo `docker-compose.yml`:

1. **`glpi-licencias-app`** (raíz del repo) — Node 20 + Express + EJS +
   Bootstrap 5, MySQL/MariaDB. Gestión de licencias de software,
   dominios, contratos ISP, adjuntos con extracción por IA (Gemini),
   recordatorios por correo, y un agente conversacional por
   WhatsApp/Telegram. Integrado con GLPI vía su API REST "Legacy".
2. **`devops-sidecar/`** — Python 3.12 + FastAPI + SQLAlchemy + SQLite.
   Audita con IA (Gemini/Claude/Ollama) repositorios de GitHub que él
   mismo clona/sincroniza, recibe webhooks de despliegue de Coolify,
   calcula un leaderboard de actividad, y hace respaldos
   incrementales/totales de los repos que audita.

Se instalan juntas con `install-ubuntu.sh` (para un servidor Ubuntu
limpio) o con `docker compose up -d --build` si ya está el proyecto
clonado. Cada app tiene su propio `README.md` con el detalle completo de
uso — este archivo es orientación de alto nivel, no reemplaza esos
READMEs.

## Antes de tocar código

- **Lee `docs/ai-knowledge/lecciones-aprendidas.md`** — gotchas
  concretos ya encontrados (bugs de shell/sed, verificación de
  Docker en Windows, patrones de seguridad) que van a repetirse si no
  se conocen de antemano.
- Si vas a escribir o modificar un script de instalación/despliegue en
  bash, sigue `.claude/skills/shell-docker-verification/SKILL.md`
  (o el agente `deploy-script-verifier`, si tu herramienta soporta
  subagentes de Claude Code) — verificar contra un contenedor Ubuntu
  real es obligatorio, no opcional.
- Si vas a agregar un campo de credencial/API key nueva, sigue
  `.claude/skills/encrypt-secrets-at-rest/SKILL.md`.
- Si vas a agregar backup/restore de algo, sigue
  `.claude/skills/respaldo-restauracion-segura/SKILL.md`.

## Convenciones establecidas (no las reinventes)

- **Nunca SQL/comandos armados con strings concatenados**: siempre
  parámetros (`?` en mysql2, ORM en Python) y `subprocess`/`spawn`/
  `execFile` con argumentos en lista, nunca `shell=True`.
- **Nunca SDKs de terceros para APIs de IA**: Gemini/Claude/Ollama se
  llaman por REST directo (`axios` en Node, `httpx` en Python) — evita
  depender de nombres de paquete que cambian con el tiempo.
- **El chatbot (WhatsApp/Telegram) nunca genera SQL libre**: interpreta
  la pregunta a un `{tool, args}` de un catálogo fijo y cerrado; el
  código ejecuta esa herramienta puntual. Ver `src/services/chatAgent.js`.
- **Credenciales cifradas en reposo** (parcial — ver
  `docs/ai-knowledge/lecciones-aprendidas.md` sección 4 para qué campos
  quedan fuera todavía): `src/services/cryptoService.js` (Node,
  AES-256-GCM) y `devops-sidecar/app/services/crypto_service.py`
  (Python, Fernet). Clave por variable de entorno
  `CREDENTIALS_ENC_KEY`, con fallback "sin clave = sin cifrar" para no
  romper una instalación ya desplegada.
- **Contraseñas de usuario**: siempre bcrypt (`bcryptjs`, cost 12), 2FA
  TOTP obligatorio en la app principal.
- **CSRF** en toda ruta POST/PUT/DELETE de la app principal
  (`src/middleware/csrf.js`) — DevOps Sidecar usa HTTP Basic Auth en vez
  de sesiones, así que no aplica el mismo mecanismo ahí.
- **Rate limiting** (`express-rate-limit`) en login y verificación 2FA.
- **Verificar contra la fuente primaria**, no memoria ni documentación
  de terceros potencialmente desactualizada, para cualquier integración
  externa crítica (webhooks, APIs, instaladores de paquetes) — código
  fuente del proyecto externo > su documentación oficial > memoria del
  modelo. Dilo explícitamente cuando algo no se pudo verificar así.
- **Verificación real antes de dar algo por corregido**: contenedores
  Docker reales, datos reales cuando sea posible, nunca solo lectura de
  código o un test aislado — ver
  `.claude/skills/shell-docker-verification/SKILL.md`.
- **Commits**: en español, temáticos y separados cuando hay varias
  features mezcladas sin commitear (no un solo commit gigante), mensaje
  explicando el *por qué* del cambio.

## Estructura rápida

```
.claude/skills/       Skills de Claude Code (procedimientos reutilizables)
.claude/agents/        Subagentes especializados de Claude Code
docs/ai-knowledge/      Conocimiento del proyecto en Markdown plano,
                        pensado para cualquier asistente de IA (no solo
                        Claude) - gotchas, patrones, lecciones.
install-ubuntu.sh       Instalador completo para un servidor Ubuntu limpio
docker-compose.yml      Orquesta "app" (Node), "db" (MariaDB) y
                        "devops-sidecar" (Python)
scripts/security-check.sh  Auditoría de dependencias (npm audit + pip-audit)
src/                    App principal (Node/Express)
devops-sidecar/app/     DevOps Sidecar (Python/FastAPI)
sql/schema.sql + sql/migrations/  Esquema de BD de la app principal,
                        incremental (ver sql/migrations/README.md)
```

## Qué falta / decisiones pendientes

Ver la sección "Pendiente / a considerar más adelante" del historial de
desarrollo del proyecto (mantenido por el usuario fuera de este repo) o
preguntar directamente — no asumas que algo mencionado como "pendiente"
en una conversación anterior ya se resolvió sin confirmarlo contra el
código actual.
