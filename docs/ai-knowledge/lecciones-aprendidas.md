# Lecciones aprendidas — para cualquier asistente de IA que trabaje en este repo

Este documento es independiente de qué modelo/herramienta lo lea (Claude,
Gemini, ChatGPT, un asistente local sobre Ollama, etc.) — es texto plano
con los hallazgos concretos, reproducibles y ya verificados durante el
desarrollo de este proyecto. No repite lo que ya está en el README de
cada app; se enfoca en los **gotchas no obvios** que costó tiempo
diagnosticar, para que la próxima vez sean inmediatos.

Ver también `.claude/skills/` para las mismas lecciones empaquetadas como
skills invocables por Claude Code específicamente.

## 1. Bugs de shell/bash ya encontrados y corregidos en este repo

### Sustitución de comandos captura TODO el stdout de una función
Una función usada como `X="$(mi_funcion ...)"` captura absolutamente
todo lo que la función escriba a stdout, no solo el `echo` final que
"devuelve" el valor. Un `echo` puramente decorativo (ej. bajar de línea
después de un `read -s`, que no hace eco del Enter) queda pegado DENTRO
del valor capturado. Esto causó un bug real en `install-ubuntu.sh`: una
contraseña terminaba como `"\n\nMiClave123"` (con saltos de línea
embebidos), lo que rompía el `sed` que la insertaba en un `.env` con el
error `sed: -e expression #1, char N: unterminated 's' command`.
**Regla**: cualquier función pensada para `$(...)` solo puede escribir a
stdout el valor final; todo lo demás va a stderr (`>&2`).

### `MSYS_NO_PATHCONV` en Windows Git Bash
Rutas absolutas estilo Unix (`/data/backups/...`) pasadas a `docker
exec`, `docker run -v`, etc. desde Git Bash en Windows se mangan en
silencio por la traducción automática de rutas de MSYS, a menos que el
comando lleve el prefijo `MSYS_NO_PATHCONV=1`. Causó un `rm -rf` que
no-opeó en silencio (gracias al `-f`) dejando archivos huérfanos en
disco sin fila correspondiente en la base de datos.

### Escapado de `sed` con delimitador no estándar
Usar `s|patron|reemplazo|` en vez de `s/patron/reemplazo/` sigue
requiriendo escapar el delimitador elegido (`|`), además de `&`
(referencia al match completo) y `\`, si el texto de reemplazo viene de
una variable con contenido arbitrario. Orden correcto: escapar backslash
PRIMERO, después los demás caracteres — si no, se doble-escapa lo que
agregan los pasos siguientes.

### Debian/Ubuntu separan `python3-venv` del `python3` base
Herramientas que crean un venv interno (ej. `pip-audit`) fallan en un
Ubuntu recién instalado sin ese paquete aparte — no es una
vulnerabilidad real, es una particularidad de empaquetado de
Debian/Ubuntu. Si algo debe correr en "cualquier Ubuntu", conviene un
fallback a un contenedor con una imagen Python completa
(`python:3.12-slim` sí trae venv).

## 2. Verificación: nunca confiar solo en la lectura del código

En este proyecto, cada cambio no trivial se verificó contra un entorno
REAL antes de darse por terminado — no alcanza con `bash -n`, un test
unitario aislado, o "se ve bien". Ejemplos concretos donde esto
encontró bugs reales que el razonamiento por sí solo no hubiera
atrapado:
- Dos respaldos completos el mismo día se pisaban en disco por un
  timestamp sin hora — solo se vio corriendo dos respaldos reales
  seguidos y comparando los nombres de archivo generados.
- El bug de `sed`/contraseña de arriba solo se reprodujo simulando la
  entrada interactiva completa contra un Ubuntu 22.04 real en Docker,
  con el stdin trazado línea por línea.
- La migración automática de credenciales a formato cifrado se
  confirmó funcionando correctamente solo después de probarla contra
  datos REALES ya guardados en producción (no fixtures sintéticas).

**Patrón recomendado para probar un script bash interactivo o algo con
Docker**: inyectar el script vía base64 en una variable de entorno hacia
un contenedor desechable (evita problemas de traducción de rutas en
Windows), armar el stdin como un archivo explícito con el conteo de
líneas trazado a mano contra el camino condicional real del script, y
correr siempre con un timeout (un mal conteo de stdin puede producir un
loop infinito).

## 3. Verificar contra fuentes primarias, no memoria ni documentación de terceros desactualizada

Varias integraciones de este proyecto se verificaron contra el CÓDIGO
FUENTE real de la herramienta externa (vía `gh api`/`gh search code`),
no contra su documentación pública (que puede estar incompleta o
desactualizada) ni contra la memoria del modelo:
- El esquema exacto del payload del webhook de Coolify (qué campos
  manda realmente, y que su canal "Webhook" no soporta headers
  personalizados) se confirmó leyendo el código PHP real del proyecto
  `coollabsio/coolify` en GitHub.
- Los comandos de instalación de Caddy se verificaron contra
  `caddyserver.com/docs/install` antes de escribirlos en un script,
  en vez de recordarlos de memoria.
- Un modelo de Gemini (`gemini-2.5-flash`) que dejó de estar disponible
  se confirmó con un error HTTP 404 real de la API, no con una
  suposición.

**Regla general**: si una integración con un sistema externo (webhook,
API, gestor de paquetes) es crítica, verifica el contrato exacto contra
la fuente más primaria disponible (código fuente > documentación oficial
> memoria del modelo), y dilo explícitamente cuando algo NO se pudo
verificar así (ej. falta de acceso de red, credenciales reales).

## 4. Patrones de seguridad ya establecidos en este repo

Ver `.claude/skills/encrypt-secrets-at-rest/SKILL.md` y
`.claude/skills/respaldo-restauracion-segura/SKILL.md` para el detalle
completo. Resumen:
- Cifrado en reposo con clave desde variable de entorno, prefijo
  versionado (`enc:v1:...`), fallback "sin clave = sin cifrar" para no
  romper producción, y migración automática perezosa al leer un valor
  legado.
- Cualquier acción destructiva (restaurar, eliminar todo) pide una
  frase de confirmación exacta y guarda un snapshot de seguridad
  automático antes de aplicarse.
- Comparación de credenciales siempre en tiempo constante
  (`secrets.compare_digest` / `crypto.timingSafeEqual`), nunca `==`.
- Comandos de sistema siempre con argumentos en lista
  (`subprocess`/`spawn`/`execFile`), nunca `shell=True` ni un string
  armado a mano con datos de entrada.

## 5. Convención de commits de este repo

Cuando hay varios cambios sin commitear que en realidad son features
distintas mezcladas, se organizan en commits temáticos separados y
ordenados (no un solo commit gigante), cada uno con un mensaje que
explica el POR QUÉ del cambio, no solo el qué. Ver el historial real de
`git log` de este repo como referencia de estilo y de granularidad.
