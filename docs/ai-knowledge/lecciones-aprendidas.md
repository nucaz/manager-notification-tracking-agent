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

## 19. Un mirror "que solo agrega" se congela tras el primer force-push

Primera version del mirror protegido: `git push` sin `+`, para que un
force-push en el origen no pise el respaldo. Funciona, pero despues la
rama del respaldo queda en la version vieja y rechaza para siempre los
commits nuevos (el respaldo deja de respaldar sin que nadie lo note). Lo
revelo la prueba de "mirror automatico tras sync". Correcto: guardar la
punta vieja en una rama aparte (`sidecar-conservado/<rama>-<fecha>`) y
recien entonces actualizar con `--force-with-lease=<rama>:<punta vieja>`.
Mismo criterio para los avisos: si algo esperado (una rama borrada que el
respaldo conserva) deja el estado en "aviso" en cada ejecucion, la gente
aprende a ignorar los avisos; eso va como informacion, no como aviso.

## 20. Restaurar desde el manifest, no desde la base

El caso real de una restauracion es haber perdido el servidor, y con el
la base que sabe que puntos hay. La restauracion lee la carpeta de la
cadena y su `manifest.json` (con SHA-256), y el destino se puede explorar
sin la base. Subir un repo restaurado va con `git push --atomic`: sin
eso, si `main` era rechazado igual se subian las etiquetas al repositorio
equivocado.

## 21. "Probar conexión" no es un buen contador

El panel mostraba cuántas computadoras, monitores e impresoras hay en GLPI
reutilizando "probar conexión". En producción salía vacío: esa prueba
consulta además el perfil del propio usuario, y un usuario de servicio de
solo lectura no tiene ese permiso. Para contar se pide un registro de cada
tipo (el total viene en la respuesta). Regla: una función nueva no debe
depender de un permiso que la tarea no necesita.

## 22. Un "historial" puede ser estado

Al poner retención de 3 meses a los históricos, `reminder_log` parecía uno
más. No lo es: guarda "este aviso ya se envió" (clave única por entidad y
umbral). Borrarlo haría que un recordatorio viejo saliera otra vez. Antes
de borrar por antigüedad, mirar quién LEE la tabla, no solo cómo se llama.

## 23. Con sesión por cookie aparece el riesgo que HTTP Basic no mostraba

DevOps Sidecar no tenía tokens CSRF porque usaba HTTP Basic. Al pasar a
sesión por cookie (acceso único), cualquier otra aplicación del mismo
servidor queda "en el mismo sitio" para el navegador (el puerto no
cuenta), y `SameSite` no la frena. Por eso el sidecar compara
`Origin`/`Referer` con su propio `Host` en todo lo que no sea lectura.

## 24. Un pase en la URL queda escrito en más lugares de los que parece

El primer diseño del acceso único mandaba el pase como `?token=`. Queda en
el historial del navegador y en el log de accesos del servidor. Se cambió
a un formulario que se envía solo por POST, y el pase es de un solo uso.

## 25. HSTS con un certificado que el navegador aún no reconoce bloquea la entrada

El HTTPS interno usa la autoridad propia de Caddy; hasta instalar su
certificado raíz, el navegador avisa pero deja continuar. Si además se
enviara HSTS, el navegador ya no dejaría continuar. No se envía hasta que
el certificado raíz esté distribuido.

## 26. Lo que prueba un Gemini simulado y lo que no

El asistente se prueba contra un servidor local que imita a Gemini: sirve
para comprobar qué se le envía y qué se hace con lo que responde. No
detecta una clave inválida ni el saldo agotado (`HTTP 400`, `HTTP 402`),
que fue justo lo que falló al probar con la API real. Decirlo así al
reportar: "probado con simulador; con la API real no respondió por X".

## 27. Una sola configuración de IA, no una por aplicación

La app principal y DevOps Sidecar tenían cada una su API key y su modelo.
Cambiar de modelo o renovar una clave obligaba a hacerlo dos veces, y se
desincronizaban (en producción la app tenía un nombre de modelo inválido,
"Gemini 3 Flash-Lite", mientras el sidecar ya usaba Ollama). Ahora la
configuración vive en la app (`ai_providers` + `ai_uso_*`) y el sidecar
le pide que genere (`/interno/ia/generar`, pase "app-ai"). Las claves
quedan en un solo lugar. El sidecar conserva lo suyo solo como emergencia.

## 28. Ollama corta en silencio los textos largos

Ollama usa un contexto chico por defecto (`num_ctx`) y, si el texto no
cabe, descarta el principio sin avisar: la auditoría de un diff grande
"funciona", pero la IA solo ve el final. Cada proveedor Ollama lleva su
`context_tokens`; "Probar" muestra el máximo que admite el modelo.

## 29. Un modelo local no lee un PDF; su texto sí

Gemini y Claude reciben el PDF tal cual. Ollama solo acepta imágenes (y
solo si el modelo tiene visión). Para facturas con un modelo local se
extrae el texto del PDF en el servidor (pdf.js, el mismo de los recibos)
y se le manda eso. Un PDF escaneado no tiene texto: se dice, no se inventa.

## 30. Herramientas: nativas cuando hay, emuladas cuando no

El asistente depende de que la IA pida `consultar_datos`. Gemini, Claude,
y en Ollama los modelos con capacidad "tools" (gemma4) lo hacen nativo.
Para un modelo sin herramientas se emulan: se describen en las
instrucciones y se le pide un JSON (`herramienta`/`argumentos` o
`respuesta`). Las cifras igual salen de la aplicación, no del modelo.

## 31. La API key va en una cabecera, no en la URL

Gemini acepta `?key=` en la URL, pero la URL aparece en mensajes de error
de axios y en logs de proxies. Se usa la cabecera `x-goog-api-key`, y los
errores de red se reescriben sin la URL.

## 32. El respaldo a la nube debe ser una decisión, no un efecto

Si el servidor local se cae, pasar sola a Gemini sacaría datos de la
empresa justo cuando alguien eligió "local" por privacidad. El respaldo
existe pero viene vacío; cuando actúa, la respuesta lo avisa.

## 33. El asistente no debe cargar tablas enteras para contar

`runQuery` cargaba cada conjunto completo (`load()`) y filtraba en
JavaScript. Con miles de filas no se notaba; con cientos de miles es
lento y usa memoria. Ahora arma SQL con lista blanca y parámetros y deja
filtrar, agrupar y sumar a MariaDB. Se comprobó que da lo mismo que antes
(totales, grupos y sumas, `tests/asistente_datos.e2e.js`).

## 34. Un índice que no cubre el JOIN se ignora

Con 300 000 chips, "de baja" (10 %) igual recorría la tabla completa: el
`COUNT` con sus `LEFT JOIN` necesitaba `device_id`, que no estaba en el
índice `(estado, operadora)`, y leer cada fila salía más caro que
recorrerla. Con `(estado, operadora, device_id)` usa el índice. Medirlo
con EXPLAIN sobre datos grandes, no con los de desarrollo (el optimizador
recorre tablas chicas aunque haya índice).

## 35. Una columna mostrada como etiqueta se filtra por su código

Filtrar "estado = En stock" sobre un `CASE` no usa índices. Se resuelve
la etiqueta al código (`status IN ('en_stock')`) o a una condición fija
(vencido = `fecha < CURDATE()`), y el índice sí sirve.

## 36. Un respaldo sin la clave de cifrado no recupera la configuración

La base guarda API keys y tokens cifrados con `CREDENTIALS_ENC_KEY`, que
vive en el `.env`, fuera de la base. Un dump solo, restaurado en un
servidor nuevo, deja toda esa configuración ilegible. El respaldo completo
lleva los `.env` cifrados con una contraseña que el usuario guarda aparte.

## 37. Probar la retención con ejecuciones seguidas destapa nombres repetidos

Las cadenas se nombraban con fecha y hora al segundo. En producción corren
de noche y no chocan, pero dos ejecuciones manuales seguidas compartían
carpeta y la retención borraba la copia más nueva. Nombres únicos siempre.

## 38. cryptcheck no sirve sobre un destino sin hashes

Con rclone crypt, la verificación usaba `cryptcheck`, que compara hashes.
Una carpeta SMB (o un WebDAV genérico) no tiene hashes: sin cifrado,
`check` cae solo a comparar tamaños y pasa, pero `cryptcheck` falla con
"does not support any hashes" y cada subida quedaba en error. Ahora, ante
ese mensaje, se verifica con `check --download` (descarga, descifra y
compara byte a byte). Las pruebas incluyen un WebDAV cifrado.

## 39. Respaldar MySQL con el cliente de MariaDB: probarlo con el de MySQL

`mariadb-dump` 11 empieza con `/*M!999999\- enable the sandbox mode */`.
La forma actual (`/*M!`) la aceptan los clientes de MySQL 8.0 y 8.4
(probado); la forma antigua (`/*!999999\-`) la rechazaban. Al respaldar
un MySQL se quita igual (solo protege al restaurar en MariaDB) y el
volcado se probo con el cliente oficial de MySQL 8.0, no solo con el de
MariaDB.
Y `pg_dump` no respalda un servidor de version mayor: el cliente se
instala del repositorio oficial PGDG, no el de la distribucion.

## 40. Un servidor de prueba que no se comporta como el real no prueba nada

`rclone serve ftp --cert` hace TLS implicito y rechaza `PBSZ`: con el
cliente en FTPS explicito se quedaba colgado. El hosting real (cPanel) usa
Pure-FTPd con TLS explicito obligatorio; la prueba usa ese mismo servidor.

## 41. El TestClient de FastAPI corre las tareas en segundo plano antes de responder

Con `BackgroundTasks`, `TestClient` termina la tarea antes de devolver la
respuesta: una prueba que consulta el avance "mientras corre" solo ve el
100 %. El avance intermedio se prueba sobre la clase que lo calcula
(`restore_service.Progress`), con el intervalo de guardado en 0.

## 42. Un "solicitante" para varios modulos va en una sola tabla

Celulares, Clinic y Microsoft 365 necesitaban "quien lo pidio". Columnas
de solicitante en cada tabla las habrian acercado al tope de columnas y
no permitirian ver todo lo que pidio una persona. `service_requests`
(modulo + entidad + foto del solicitante) con pasos en
`service_request_tasks` lo resuelve para los tres, y la asignacion de un
celular solo suma `request_id`.

## 43. Un paso con evidencia obligatoria no puede aceptar "vacio = ninguna"

El paso "Quitar las licencias" decia "vacio = ninguna" pero exigia
evidencia: no se podia marcar. Lo explicito es escribir "ninguna"; asi un
campo olvidado no se confunde con "sin licencias".

## 44. El identificador de un sistema externo es su Id, no el nombre que se ve

El listado real de Clinic trae dos usuarios con el mismo nombre de usuario (uno con un espacio
de no separacion al final), usuarios con Ñ y espacios y uno sin usuario.
Con `username` unico, la importacion habria juntado dos personas en una
fila. La clave es `IdUsuario` (`clinic_id`, unico); el usuario se limpia
de espacios invisibles y se indexa sin ser unico, y los repetidos se
avisan.

## 45. Pasar un catalogo de texto a clave foranea obliga a revisar "Unificar"

Con perfil, sede y area por id (`catalog_items`, `clinic_profiles`,
`clinic_sedes`), borrar un valor en uso ya no deja texto huerfano: falla.
"Unificar valores" borraba los valores origen del catalogo; ahora primero
apunta las claves foraneas al valor que queda (`fk: true` en
`catalogMergeService.PLACES`) y el borrado desde Catalogos avisa en vez de
dar error 500.

## 46. Un .xls de Excel 97 no lo lee ExcelJS

Clinic exporta en BIFF8 (.xls). ExcelJS solo lee .xlsx; para ese archivo se
usa SheetJS 0.20.3 desde su CDN oficial (la version de npm, 0.18.5, tiene
vulnerabilidades conocidas). Las fechas llegan como numero de serie y las
horas como fraccion del dia (0.375 = 09:00): se convierten con
`XLSX.SSF.parse_date_code`, sin pasar por `Date` (evita corrimientos de
zona horaria).
