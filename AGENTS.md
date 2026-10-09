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
  (o el agente `deploy-script-verifier`) — verificar contra un
  contenedor Ubuntu real es obligatorio, no opcional.
- Si vas a agregar un campo de credencial/API key nueva, sigue
  `.claude/skills/encrypt-secrets-at-rest/SKILL.md`.
- Si vas a agregar backup/restore de algo, sigue
  `.claude/skills/respaldo-restauracion-segura/SKILL.md`.
- Si vas a endurecer la validación de un campo (tamaño, formato
  alfanumérico/numérico) en una tabla que ya tiene datos, sigue
  `.claude/skills/endurecer-validacion-de-campos/SKILL.md` — verificar
  los datos reales ANTES de decidir el límite.
- Si vas a crear o cambiar una tabla, columna o índice, agregar una
  búsqueda/filtro, o tocar Mantenimiento BD o la retención de históricos,
  sigue `.claude/skills/mariadb-esquema-e-indices/SKILL.md` (tope de 30
  columnas por tabla, cuándo un índice sirve, qué es historial y qué es
  estado).
- Si vas a tocar el acceso único con DevOps Sidecar, el login o el
  captcha, sigue `.claude/skills/acceso-unico-entre-servicios/SKILL.md`.
- Si vas a tocar el asistente "Preguntar a la IA" (datos que consulta,
  herramientas, instrucciones), sigue
  `.claude/skills/asistente-ia-solo-lectura/SKILL.md`.
- Si vas a armar un atributo HTML condicional en una plantilla EJS
  (`views/**/*.ejs`), revisa
  `.claude/skills/ejs-atributos-sin-escapar/SKILL.md` — `<%= %>` escapa
  HTML y rompe en silencio un atributo ya armado como string; hace
  falta `<%- %>`.

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
- **Un solo usuario para las dos aplicaciones**: la app principal es la
  única que autentica personas (contraseña, captcha propio, 2FA). A
  DevOps Sidecar se entra con un pase firmado de un solo uso
  (`SSO_SHARED_SECRET`, igual en los dos `.env`); las llamadas entre
  servicios usan un pase de servicio, no una contraseña guardada.
- **El asistente de IA de la app solo lee**: elige consultas de un
  catálogo cerrado que ejecuta la aplicación (nunca SQL), respeta los
  permisos por módulo y no tiene ninguna herramienta de escritura.
- **CSRF** en toda ruta POST/PUT/DELETE de la app principal
  (`src/middleware/csrf.js`). DevOps Sidecar, con acceso único, usa sesión
  por cookie y rechaza toda orden cuyo `Origin`/`Referer` no sea el suyo;
  sin acceso único sigue con HTTP Basic.
- **Rate limiting** (`express-rate-limit`) en login y verificación 2FA,
  tope general por IP en toda la app, y límite por usuario en el asistente.
- **Base de datos**: máximo 30 columnas por tabla, clave primaria e
  índice en cada clave foránea (lo fija `tests/mantenimiento.e2e.js`);
  los históricos (auditoría, chat) se conservan 3 meses por defecto.
- **Cifrado en tránsito**: `docker-compose.https.yml` + `Caddyfile`
  ponen HTTPS delante de las dos aplicaciones; con eso activo, ninguna se
  publica directamente a la red.
- **Catálogos de texto libre** (sede, área, marca, modelo, operadora):
  tabla genérica `catalog_items` (`catalog_type` + `value`), sin FK
  dura desde quien lo usa — administrable desde Configuración >
  Catálogos sin tocar código. Si el dato tiene varios campos
  relacionados (ej. país + código de llamada + dígitos esperados, ver
  `phone_country_codes`), usar una tabla propia en vez de forzarlo
  dentro de un `value` de texto.
  Excepción: los usuarios de Clinic apuntan a `catalog_items` (sede, área)
  por clave foránea; por eso "Unificar valores" mueve también esas FK
  (`fk: true` en `catalogMergeService.PLACES`).
- **Crédito del desarrollador (no tocar)**: "Juan Carlos Aguirre Alvarado
  - Develop Infraestructura TI Ciberseguridad" va fijo al pie de todas las
  páginas (`views/partials/credito.ejs`, incluido por `partials/foot.ejs` y
  las pantallas sueltas), en DevOps Sidecar (`templates/base.html`) y en
  los PDF de Reportes. Nunca se vuelve configurable ni se quita; toda
  pantalla nueva con `</body>` lo incluye. Lo vigila `tests/credito.test.js`.
- **Roles** (`src/middleware/auth.js`): `lector` ve todo sin cambiar;
  `editor` escribe en los módulos; `admin` gestiona los módulos, catálogos,
  auditoría e historial de chat pero **no** lo crítico; `superadmin` todo.
  Lo crítico (credenciales de conexión, usuarios, permisos, respaldos,
  mantenimiento de la base, IA, conexión de M365, DevOps) va con
  `isSuperAdmin`. Nunca queda la app sin un superadmin activo. Lo vigila
  `tests/roles.e2e.js`.
- **Tema claro / oscuro / del sistema**: `views/partials/tema.ejs` (en el
  `<head>` de toda página) pone `data-bs-theme`; el selector está en
  `partials/tema_selector.ejs`. Colores propios solo por variables
  (`--app-*` en `style.css`, o las de Bootstrap `--bs-*`), nunca un color
  claro fijo. Lo vigila `tests/tema.dom.js`.
- **Directorio activo** (`src/services/adService.js`): solo LDAPS con la
  CA validada, cuenta de servicio sin privilegios, conexión solo para
  superadmin y probada antes de guardar. `adService.js` solo lee (la
  prueba busca operaciones de escritura); TODA escritura va en
  `adWriteService.js` y pasa por `adChangeService.js` (superadmin directo,
  el resto con aprobación o permiso temporal, con re-autenticación). Las
  protecciones (OU gestionadas, privilegiados por SID y por cadena,
  adminCount, RID < 1000, DC, cuentas propias) se comprueban EN VIVO al
  ejecutar, no con la foto. Búsquedas por GUID: con `EqualityFilter` y un
  Buffer, nunca con un filtro de texto. Probar contra
  `scripts/ad-prueba/levantar.sh` (`tests/ad.e2e.js` y luego
  `tests/ad_cambios.e2e.js`, que modifica el DC), nunca contra un dominio real. Las directivas de grupo (GPO) se leen por LDAP en la misma lectura (`adGpoService.js`, tablas `ad_gpos` y
  `ad_gpo_links`, que se reemplazan): qué existe, tipo de configuración por sus extensiones, software, filtro WMI,
  vínculos y precedencia calculada; el contenido de SYSVOL no se lee y no hay escritura de GPO.
- **Módulo Red** (`networkService.js`, `netToolsService.js`): inventario de equipos con MAC, IP y VLAN. Las PC se
  traen de GLPI y del directorio activo y **nunca pisan lo escrito a mano**; los celulares son los de
  `mobile_devices` (aquí solo MAC, IP, ubicación y VLAN). Las herramientas (ping, ruta, DNS, puertos) corren
  desde el servidor, solo para admin, con el destino validado y pasado como argumento de `execFile` (nunca en
  una línea de comandos), auditadas y con tope; la revisión de puertos solo acepta direcciones privadas. La
  ruta usa `tracepath` porque `traceroute` exige privilegios que el contenedor no tiene. Prueba:
  `tests/red.e2e.js`.
- **Tablas de listado (estándar en toda la app)**: toda tabla con
  `<thead>` dentro de `.table-responsive` recibe sola, de
  `public/js/tablas.js`, **orden con clic en el encabezado**, **filtro por
  columna** (embudo), mover y estirar columnas y registros por página. No
  hace falta código por pantalla; `data-tabla="no"` la excluye y
  `data-orden="no"` saca una columna del orden. Si la tabla **pagina en
  el servidor** (`data-tabla="servidor"` o `.pagination` en su tarjeta),
  el orden y los filtros deben ir al servidor: declare en cada `<th>`
  `data-orden="clave"` (→ `?orden=&dir=`), `data-filtro="param"` con
  `data-opciones='[["valor","texto"]]'` (→ `?param=v1,v2`) o
  `data-filtro-texto="param"`, y el servicio los acepta (ver
  `clinicService.filtersOf`). Botón **Columnas** (mostrar/ocultar; un
  `<th data-oculta>` es una columna extra que viene oculta y se puede
  agregar). El buscador (`name="q"`, `public/js/ui.js`) es angosto y
  sugiere mientras se escribe, desde la tabla o desde
  `data-sugerencias="/url"` (JSON) si la tabla pagina en el servidor. Un
  aviso informativo con `data-aviso="clave"` lleva "No volver a mostrar"
  (vuelve si su texto cambia). Prueba: `tests/tablas.dom.js` (jsdom).
- **Valores sugeridos/autogenerados** (ej. correlativo de código de
  activo): siempre calculados de los datos reales en el momento
  (`MAX` sobre lo ya existente + 1), nunca con un contador aparte en
  `settings` que se pueda desincronizar.
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
