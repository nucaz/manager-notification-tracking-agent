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

## 6. Plantillas EJS: `<%- %>` para atributos HTML ya armados, nunca `<%= %>`

`<%= %>` escapa HTML a propósito (evita XSS) — correcto para imprimir
texto de usuario, pero rompe un string que ya es HTML válido por sí
mismo (ej. un atributo `maxlength="9"` armado condicionalmente). Bug
real encontrado en `views/mobileDevices/form.ejs`: el `maxlength` del
número de línea se armaba como `'maxlength="' + n + '"'` dentro de
`<%= %>`, y el navegador recibía `maxlength=&#34;9&#34;` — un atributo
inválido que se ignora en silencio, sin ningún error visible. El campo
aceptaba cualquier cantidad de caracteres pese al límite "aplicado" en
el código. Se detectó porque el usuario probó el formulario a mano, no
por lectura de código ni por `ejs.compile()` (que solo valida sintaxis,
no el HTML resultante). Ver
`.claude/skills/ejs-atributos-sin-escapar/SKILL.md` para el detalle y
cómo verificarlo renderizando la plantilla real con datos de muestra.

## 7. Antes de endurecer la validación de un campo con datos ya cargados

Nunca reducir el tamaño de una columna o agregar un patrón estricto sin
antes consultar `SELECT MAX(LENGTH(columna)) FROM tabla` y buscar
registros que violarían el nuevo límite. Se hizo así antes de cada
`ALTER ... MODIFY COLUMN` de `mobile_devices` (`model`, `asset_code`,
`notes`) — los tres casos resultaron seguros, pero solo se supo
consultando, no asumiendo. Además: si el usuario da un tamaño/formato
que contradice un estándar técnico externo verificable (ej. IMEI como
"8 alfanumérico" cuando el estándar GSMA real son 15 dígitos
numéricos, y el "8" corresponde solo al TAC), se aplica el estándar
real explicando la discrepancia — pero si el dato viene del propio
negocio (ej. su código de activo real es "A-00868", con guion), el
usuario es la fuente primaria y se sigue tal cual. Ver
`.claude/skills/endurecer-validacion-de-campos/SKILL.md`.

## 8. Catálogo de un solo valor vs. tabla propia

Un campo de texto libre que el negocio define (sede, área, marca,
modelo, operadora) va en la tabla genérica `catalog_items`
(`catalog_type` + `value`), sin FK dura desde quien lo usa — sugiere/
estandariza, nunca restringe a nivel de base de datos. Cuando el
"valor" en realidad son varios campos relacionados (país + código de
llamada + cantidad de dígitos esperada, ver `phone_country_codes`), se
usa una tabla propia pequeña en vez de forzar los datos extra dentro de
un solo `value` de texto delimitado a mano.

## 9. Un valor sugerido/autogenerado se calcula de los datos reales, nunca con un contador aparte

El correlativo del código de activo (ej. sugerir "A-00869" después de
"A-00868") no se guarda como un contador en `settings` — un contador
separado se desincroniza en cuanto se borra un registro o se carga uno
con código manual fuera de secuencia. Se calcula en el momento: buscar
el número más alto ya usado con el prefijo configurado y sumar 1. Más
lento que leer un contador, pero siempre consistente con la tabla real.

## 10. Corregir datos con trazabilidad: auditoría con antes/después y "última actualización" real

Al permitir corregir un dato ya registrado (DNI, IMEI, número de línea) el
cambio tiene que quedar en `audit_log` con **el valor anterior y el nuevo**
(`Campo: "antes" → "después"`), y solo cuando algo cambió de verdad: un
guardado sin cambios no debe ensuciar la auditoría. Patrón en
`mobileDeviceService.describeDeviceChanges` y en `POST /celulares/:id/usuario`.

Dos trampas encontradas:
- `updated_at ... ON UPDATE CURRENT_TIMESTAMP` solo se mueve si cambia una
  columna **de esa misma tabla**. Cambiar la asignación, devolver a stock o
  registrar un incidente no tocaba "última actualización" del equipo; hay que
  forzarlo (`touchDevice`) en cada acción que modifique datos relacionados.
- Al editar un dato que identifica algo (IMEI) hay que rechazar el valor si ya
  lo usa **otro** registro (`imeiTaken(imei, exceptId)`); sin restricción
  UNIQUE en la base, la única barrera es la de aplicación.
Y al corregir a la persona asignada: si ya está vinculada a `employees` se
corrige su ficha (rechazando un DNI que ya es de otro empleado); si se importó
solo como texto, se vincula por DNI a un empleado existente o se crea uno.

## 12. Auditoria "siempre", no solo en crear/editar

Cuando se pide que "siempre quede registro" de lo que se hizo, no alcanza
con auditar creacion y edicion del registro principal - hay que cubrir
TODAS las acciones que cambian datos: eliminar (individual y masivo, con
el dato ya leido ANTES de borrar, porque despues no se puede consultar),
asignar, devolver a stock, registrar un incidente, resolverlo. Cada
accion de escritura de un modulo es candidata a auditoria, no solo el
formulario de alta/edicion.

Decision de arquitectura que no cambio con esto: campos nuevos que son un
solo valor por equipo (fecha de compra, condicion nuevo/usado) van como
columna directa en `mobile_devices`, no en una tabla hija - las tablas
hijas (`mobile_device_assignments`, `mobile_device_incidents`) existen
porque ESAS si son 1-a-muchos (historial de asignaciones, varios
incidentes por equipo). Agregar una tabla hija para un dato 1-a-1 seria
sobre-ingenieria.

## 14. Confirmar "guardar" ademas de "eliminar", solo donde ya habia datos

Cuando se pide confirmacion adicional para "modificar, eliminar o
actualizar" en varios modulos: eliminar ya tenia `confirm()` en todas las
pantallas de este repo (se verifico con un grep de todas las
`action="...eliminar..."` antes de tocar nada). Lo nuevo fue agregarlo
tambien a **guardar una edicion**, y solo ahi - nunca al crear un
registro nuevo, porque no hay nada que sobrescribir. El patron
(`views/*/form.ejs`, todas comparten `action="<%= item.id ? '.../editar'
: '.../nuevo' %>"`) es condicionar el `onsubmit` a `item.id`:

```ejs
<form method="post" action="<%= item.id ? '/x/' + item.id + '/editar' : '/x/nuevo' %>"
      <%- item.id ? 'onsubmit="return confirm('¿Guardar los cambios...?');"' : '' %>>
```

Ojo con el mismo bug de la seccion 6: esto se escribe con `<%- %>`, no
`<%= %>`, porque arma un atributo HTML completo como string. Se aplico el
mismo criterio a dos acciones de Celulares que no se llaman "editar" pero
si modifican datos ya existentes: "Corregir datos del usuario" (siempre
confirma, es edicion pura) y "Reasignar" (confirma solo si ya habia una
asignacion activa - la primera asignacion a un equipo en stock es más
"crear" que "modificar"). Quedo deliberadamente FUERA de este alcance el
checklist fisico por area de `celulares/resumen` (guardado frecuente, bajo
riesgo, no es un "registro" en el sentido de licencias/dominios/etc.) y
la pantalla de Configuracion general (un formulario grande de ajustes,
no un registro individual) - si se pide extenderlo ahi, es una decision
aparte, no automatica.

## 15. Convención de commits de este repo

Cuando hay varios cambios sin commitear que en realidad son features
distintas mezcladas, se organizan en commits temáticos separados y
ordenados (no un solo commit gigante), cada uno con un mensaje que
explica el POR QUÉ del cambio, no solo el qué. Ver el historial real de
`git log` de este repo como referencia de estilo y de granularidad.

## 16. Un token en la URL de git queda guardado en disco

`git clone https://TOKEN@github.com/...` guarda esa URL, con el token, en
`.git/config` del clon; ademas el token es visible en la lista de
procesos mientras corre el comando. El comentario del codigo decia "nunca
se guarda": era falso, y se confirmo mirando los clones reales. Correcto:
URL limpia + cabecera `Authorization: Basic base64(x-access-token:TOKEN)`
pasada con `GIT_CONFIG_COUNT/GIT_CONFIG_KEY_0/GIT_CONFIG_VALUE_0` (git >=
2.31), que no toca disco ni argv. Ojo: `git remote show origin` tambien
va a la red; para la rama por defecto usar primero
`git symbolic-ref refs/remotes/origin/HEAD` (local). Y verificar la
autenticacion contra un repo **privado**: con uno publico cualquier
cambio "funciona" aunque la autenticacion este rota.

## 17. Antes de enviar algo fuera del servidor, revisar que secretos lleva

La base del sidecar iba a viajar a OneDrive dentro de los respaldos, y
tenia el token de GitHub en texto plano. Primero se cifro (con migracion
automatica al arrancar), despues se construyo el envio. Mismo criterio
para cualquier "exportar/respaldar hacia afuera".

## 18. Incrementales que se puedan restaurar

Un `.diff` de `git log -p` sirve para leer cambios pero no para
restaurar. Para respaldos incrementales de git: `git bundle create x
--all --not <puntas anteriores>` y restaurar con `git fetch bundle
"+refs/*:refs/*"` en orden sobre un repo bare. Si falta alguna punta
anterior en el clon (force-push, re-clonado), se empieza una cadena
nueva con un completo. La retencion borra cadenas enteras.
