# Gestión de Licencias, Dominios y Contratos (integrado con GLPI)

Aplicación web para el seguimiento de:

- **Licencias de software** (Microsoft 365, Power BI, Office, antivirus, etc.)
- **Dominios**: fechas de registro, renovación y vencimiento
- **Contratos ISP**: proveedor, ancho de banda contratado, vigencia, SLA
- **Servidores y Activos TI**: inventario de servidores físicos/virtuales/nube,
  con criticidad, ambiente (producción/pruebas/calidad/desarrollo),
  responsable, dependencias y vencimiento de soporte/garantía
- **Certificados TLS**: dominio cubierto, emisor, tipo (single/wildcard/SAN),
  vencimiento y vínculo opcional con el módulo de Dominios
- **Celulares**: inventario de equipos móviles (IMEI, código, marca,
  modelo, si tiene chip y su número), con área/sede, asignación a
  personas con **historial completo** (quién tuvo cada equipo y cuándo),
  reasignación (busca al empleado por DNI y actualiza el área/sede del
  equipo) y devolución a stock, un **resumen por área** con checklist
  de auditoría física (estatus, última fecha, observación), y
  **eliminación múltiple** desde el listado (selección con checkboxes)
- **Empleados**: directorio reutilizable por DNI (nombres, apellidos,
  área, sede, cargo) — se alimenta automáticamente al asignar un celular,
  o se gestiona directo desde su propia pantalla
- **Catálogos** (Configuración → Gestionar catálogos, solo admin): listas
  de sedes, áreas, marcas y modelos reutilizables desde los formularios
  (por ahora, en Celulares) para estandarizar la carga de datos
- **Adjuntos**: contratos, adendas y facturas vinculados a cada registro
- **Extracción de facturas con IA (Gemini)**: al adjuntar una factura/recibo
  (PDF o imagen), un botón "Extraer datos con IA" lee el documento y
  propone monto, moneda, concepto, proveedor, N° de factura, RUC, fechas de
  emisión/vencimiento y local/sede — que puedes revisar y aplicar al
  registro con un clic (solo completa los campos que estén vacíos, nunca
  sobrescribe datos ya cargados)
- **Módulo de Red**: topologías y diagramas de arquitectura web, infraestructura
  TI, datacenter, networking, Azure, AWS, VPS/hosting y housing
- **Recordatorios automáticos por correo** antes de cada vencimiento
- **Reportes y consultas** con exportación a CSV
- **Integración con GLPI vía API REST**: prueba de conexión, búsqueda de
  equipos/entidades para vincular registros, sincronización de licencias,
  dominios, contratos ISP, servidores/activos y certificados como objetos
  "Contract" en GLPI, e **Inventario GLPI** (solo lectura): listado/
  búsqueda de computadoras registradas en GLPI y el software instalado en
  cada una (nombre, versión y cantidad) — ver nota en la sección 8
- **Tipo de cambio USD → PEN**: se muestra en el panel principal y junto a
  cada monto en dólares, usando la API pública y gratuita del BCRP (Banco
  Central de Reserva del Perú) — sin API key
- **Importación masiva (CSV/Excel)**: carga por lote de licencias, dominios,
  contratos ISP, servidores, certificados y celulares ya existentes, con
  plantilla descargable y reporte de filas con error
- **Agente conversacional por WhatsApp y/o Telegram**: consulta
  vencimientos, celulares (por IMEI) y empleados directamente por
  WhatsApp (API oficial de Meta) o Telegram (Bot API, gratis y sin
  necesidad de exponer la app a internet), disponible solo para contactos
  autorizados (admin/editor) — ver sección 9

Construida en Node.js + Express + EJS + MySQL/MariaDB, pensada para
desplegarse con Docker junto a tu stack GLPI + Zabbix existente.

---

## 1. Requisitos

- Docker y Docker Compose (v2) en el servidor donde se va a desplegar
- Un servidor SMTP para el envío de recordatorios (Office 365, Gmail
  Workspace, Postfix interno, etc.)
- (Opcional pero recomendado) Una instancia GLPI con la API REST habilitada

## 2. Despliegue con Docker (recomendado)

Esta aplicación fue probada localmente contra MariaDB 10/11 y Node 20, y
está pensada para correr en un contenedor separado del de GLPI/Zabbix, en
el mismo servidor Ubuntu (`svrmonitor-dp`) o en otro distinto.

```bash
# 1. Copiar la configuración de ejemplo y completarla
cp .env.example .env
nano .env   # completar SESSION_SECRET, credenciales de BD, admin inicial, SMTP, GLPI...

# 2. Definir tambien la contraseña root de MariaDB usada por docker-compose
echo "DB_ROOT_PASSWORD=una_clave_larga_y_unica" >> .env

# 3. Construir y levantar los contenedores
docker compose up -d --build

# 4. Aplicar el esquema de base de datos (primera vez)
docker compose exec app npm run migrate

# 5. Crear el usuario administrador inicial (usa ADMIN_* de tu .env)
docker compose exec app npm run seed
```

La aplicación quedará disponible en `http://IP_DEL_SERVIDOR:8090` (puerto
elegido para no chocar con GLPI/Zabbix, que normalmente ocupan 80/443/8080
en el mismo servidor — puedes cambiarlo en `docker-compose.yml`).

Si tienes un reverse proxy (Nginx/Apache) delante de GLPI en ese servidor,
lo más prolijo es agregar un `server_name` o subdominio adicional (por
ejemplo `licencias.ad.depilzone.com.pe`) que haga proxy_pass hacia
`127.0.0.1:8090`, y así exponer la app con HTTPS igual que GLPI.

### Notas de puertos e instalación existente

- El contenedor de base de datos (`licencias_db`) usa una base de datos
  **propia** (`licencias_app`), separada de la base de datos de GLPI. No
  hace falta tocar la base de datos de GLPI para nada.
- El puerto de MariaDB del contenedor **no se publica** al host por
  defecto (más seguro). Si ya tienes MySQL/MariaDB corriendo en el
  servidor para GLPI, no habrá conflicto.
- El puerto de la app (por defecto `8090`) es configurable en
  `docker-compose.yml` si ya está en uso.

## 3. Desarrollo / pruebas locales sin Docker

```bash
npm install
cp .env.example .env   # ajustar DB_HOST=127.0.0.1 y credenciales de tu MySQL/MariaDB local
npm run migrate
npm run seed
npm run dev             # http://localhost:3000
```

Para probar el envío de recordatorios manualmente sin esperar al cron
diario:

```bash
npm run send-reminders             # revisa y envía correos reales
npm run send-reminders:dry-run     # solo muestra qué se enviaría, sin enviar
```

## 4. Configuración desde la aplicación

Una vez dentro de la app (como usuario `admin`), ve a **Configuración** para
completar (sin tocar archivos ni reiniciar contenedores):

- **Integración GLPI**: URL base de la API REST **"Legacy"** de GLPI —
  copia el valor exacto que muestra tu propio servidor en
  *Configuración → General → pestaña API → sección "Legacy API" → "URL of
  the API"* (no la sección "API" nueva de arriba, esa es la v2.x y no la
  soporta esta app). La ruta varía según la versión de GLPI: en instalaciones
  viejas suele ser `/apirest.php`, en GLPI 10/11 (con la API nueva ya
  habilitada en paralelo) suele ser `/api.php/v1` — agrégale tu dominio real
  delante, ej. `https://tu-servidor.tudominio.com/api.php/v1`.
  - El **App-Token** viene de un "API client" (en esa misma pantalla, más
    abajo, "API clients (Legacy API)") — si usas uno ya existente, revisa
    que no tenga restringido el rango de IP a `localhost` únicamente, o
    las llamadas desde donde corra esta app van a ser rechazadas; si hace
    falta, crea un cliente API nuevo sin esa restricción (o con el rango
    de IP correcto).
  - En esa misma pantalla, confirma que **"Enable login with external
    token"** esté activado (esta app se autentica con User-Token, no con
    usuario/contraseña).
  - El **User-Token** se genera desde el perfil del usuario de servicio en
    GLPI: *Preferencias → pestaña "Claves API personales"*.
  - Ese usuario de GLPI debe tener perfil con permisos de **lectura**
    sobre `Computer`, `Software`, `SoftwareVersion` y `Entity` (para el
    Inventario GLPI), y de **escritura** sobre `Contract` (para
    "Sincronizar con GLPI").
  - El botón "Probar ahora" valida la conexión.
- **SMTP**: host, puerto, usuario/contraseña y remitente. Botones para
  "Verificar conexión" y "Enviar correo de prueba".
- **Recordatorios**: umbrales de días antes del vencimiento (por defecto
  `90,60,30,15,7,1`) y lista de correos destinatarios. La tarea programada
  corre todos los días a las 08:00 (hora del contenedor/servidor) y evita
  reenviar el mismo aviso dos veces gracias a un registro interno.

## 5. Extracción de facturas con IA (Gemini)

Desde **Configuración** (solo `admin`):

1. Genera una API key en [Google AI Studio](https://aistudio.google.com/apikey)
   y pégala en el campo "API key de Gemini". El uso tiene costo según el
   volumen de documentos procesados — es la facturación normal de la API
   de Gemini, ajena a esta app.
2. El campo "Modelo" viene precargado con `gemini-2.5-flash` (rápido y
   económico para lectura de documentos). Google renueva sus modelos
   "flash" con cierta frecuencia — si en el futuro aparece uno más nuevo o
   el actual deja de estar disponible, solo hay que cambiar el nombre acá,
   sin tocar código.
3. Usa "Verificar API key" para confirmar que quedó bien configurada.

**Cómo se usa:** sube una factura/recibo (PDF, PNG, JPG o WEBP) como
adjunto de tipo "Factura" en el detalle de una licencia, dominio o
contrato ISP (como ya se hacía). Va a aparecer un botón **"Extraer datos
con IA"**: al pulsarlo, la IA lee el documento y muestra monto, moneda,
concepto, proveedor, N° de factura, RUC/NIT, fecha de emisión, fecha de
vencimiento y local/sede debajo del archivo. Si los datos se ven
correctos, el botón **"Aplicar al registro"** los copia al costo, moneda,
fecha de vencimiento y local/sede del registro — pero **solo llena los
campos que estén vacíos**, nunca sobrescribe algo que ya hayas cargado
manualmente, así que siempre puedes revisar antes de aplicar.

Por ahora el flujo es de **subida manual**: descargas o guardas la factura
que te llega (por ejemplo, por correo a Outlook) y la subes a la app. No
se conecta directamente a tu buzón de Outlook/Microsoft 365 — se evaluó,
pero requeriría registrar una aplicación en Azure AD con permisos de
lectura de correo sobre tu tenant `ad.depilzone.com.pe`, coordinarlo con
tu administrador de M365 y mantener esa integración corriendo (webhooks o
sondeo periódico del buzón). Si más adelante quieres ese nivel de
automatización, es una ampliación natural sobre esta misma base: el
`src/services/geminiClient.js` ya queda listo para reutilizarse detrás de
cualquier origen de archivos.

## 6. Roles de usuario

- **admin**: acceso total, incluye Usuarios y Configuración.
- **editor**: puede crear, editar y eliminar licencias/dominios/contratos/
  adjuntos/diagramas, pero no accede a Usuarios ni Configuración.
- **lector**: solo puede ver y consultar/exportar reportes.

Gestiona usuarios desde **Usuarios** (solo visible para `admin`).

## 7. Verificación en dos pasos (2FA)

La aplicación exige **2FA obligatorio** (TOTP) para los tres roles
(admin/editor/lector). No depende de SMTP: usa una app autenticadora
(Google Authenticator, Microsoft Authenticator, Authy, etc.).

- **Primer login**: después de la contraseña, se pide escanear un código QR
  y confirmar con el código de 6 dígitos que muestra la app. Recién ahí
  queda activo el 2FA y se completa el inicio de sesión.
- **Logins siguientes**: después de la contraseña, se pide el código de 6
  dígitos vigente.
- **Si un usuario pierde su dispositivo**: un `admin` puede restablecer su
  2FA desde **Usuarios** → botón "Restablecer 2FA" — la próxima vez que esa
  persona inicie sesión, se le pedirá configurar el 2FA de nuevo desde cero.
- **Si el único admin pierde su dispositivo** (nadie más puede restablecerlo
  desde la UI): con acceso al servidor, corre
  `docker compose exec app npm run reset-2fa -- correo@ejemplo.com`
  (o `npm run reset-2fa -- correo@ejemplo.com` en desarrollo local sin
  Docker).

## 8. Integración con GLPI — cómo funciona

- **Búsqueda de equipos/entidades**: al registrar una licencia puedes
  anotar el ID de equipo o entidad de GLPI (se puede consultar vía
  `GET /glpi/api/equipos?q=nombre` y `GET /glpi/api/entidades`, usados
  internamente por la app).
- **Sincronizar con GLPI**: desde el detalle de una licencia, dominio o
  contrato ISP, el botón "Sincronizar con GLPI" crea un objeto **Contract**
  en GLPI con el nombre, fecha de inicio y notas del registro local, y
  guarda el ID de ese contrato de vuelta en la app para trazabilidad.
- Esto **no reemplaza** el inventario de GLPI: la idea es que GLPI siga
  siendo la fuente de verdad de equipos/activos, y esta app sea el
  formulario especializado para licencias, dominios, contratos ISP,
  adjuntos y diagramas de red — con un puente hacia GLPI vía su API REST
  documentada en https://github.com/glpi-project/glpi/blob/main/apirest.md
- **Inventario GLPI** (menú "Inventario GLPI", los 3 roles pueden verlo,
  es de solo lectura): busca/lista las computadoras registradas en GLPI y,
  al entrar al detalle de una, muestra su software instalado (nombre,
  versión y cantidad total). No modifica nada en GLPI ni en esta app —
  solo consulta. Si un equipo tiene muchísimo software instalado, se
  muestran como máximo los primeros 100 (se indica si quedó algo afuera).
  ⚠️ Esta funcionalidad se construyó siguiendo al pie de la letra la
  documentación oficial de la API de GLPI, pero **no se pudo probar contra
  un servidor GLPI real** (no había uno accesible desde el entorno donde
  se desarrolló — mismo caso que `geminiClient.js`, ver sección 5). Si al
  usarla contra tu GLPI real algo no calza (por ejemplo, el nombre de un
  campo cambió entre versiones de GLPI), avísame para ajustarlo.

## 9. Agente conversacional por WhatsApp y/o Telegram

Permite consultar la app por WhatsApp y/o Telegram (vencimientos,
celulares por IMEI, empleados, resumen de celulares por área) mediante un
agente con IA que interpreta la pregunta y ejecuta una herramienta fija
contra la base de datos — la IA **nunca genera SQL libre**, solo elige
entre un catálogo cerrado de consultas seguras y sus argumentos. Los dos
canales son independientes: puedes activar solo uno, o ambos a la vez, y
un mismo usuario puede tener vinculados ambos.

**Seguridad del diseño** (decisiones explícitas del proyecto, iguales
para los dos canales):

- Solo responde a **contactos autorizados**: un número de WhatsApp o un
  ID de chat de Telegram vinculado a un usuario existente con rol `admin`
  o `editor` y activo (campos en Usuarios → Nuevo/Editar). Cualquier otro
  contacto recibe un mensaje genérico de "no disponible", sin confirmar
  ni negar nada sobre el bot.
- Las respuestas pueden incluir **datos personales** (por ejemplo, el DNI
  de la persona que tiene asignado un celular) porque solo llegan a
  usuarios ya autorizados dentro de la organización — no lo trates como
  un canal público.
- Se usa **exclusivamente la API oficial** de cada plataforma (WhatsApp
  Cloud API de Meta, Bot API de Telegram). Se descartó a propósito
  cualquier librería no oficial (whatsapp-web.js, Baileys, clientes
  MTProto con `api_id`/`api_hash`, etc.) porque automatizar una cuenta así
  viola los términos de servicio y arriesga el bloqueo del número/cuenta.
- Toda conversación (entrante y saliente, de cualquiera de los dos
  canales) queda registrada en la tabla `agent_message_log` para
  auditoría, con una columna `channel` que distingue el origen.

**Qué puede responder hoy**: cantidad y listado de vencimientos próximos
(licencias, dominios, contratos ISP, servidores, certificados), búsqueda
de un celular por IMEI (con su asignación actual), búsqueda de un
empleado por DNI o nombre, y el resumen de celulares por área.

### 9.1 WhatsApp (Meta Cloud API)

**Configuración** (menú Configuración → tarjeta "Agente de WhatsApp"):

1. Crea una cuenta de **Meta for Developers** y una app de tipo
   "Business", agrega el producto **WhatsApp**.
2. En el panel de WhatsApp de tu app obtendrás el **ID de número de
   teléfono** (`phone_number_id`) y un **token de acceso** temporal (para
   producción, genera uno permanente vinculado a un System User de tu
   Business Manager). Cópialos en la tarjeta de Configuración.
3. Inventa tú mismo un **token de verificación del webhook** (cualquier
   texto) y ponlo también en Configuración.
4. En el panel de Meta, configura la URL del webhook como
   `https://tu-dominio-publico/webhook/whatsapp` usando ese mismo token
   de verificación, y suscribe el campo `messages`.
5. Copia el **App Secret** de tu app de Meta (Configuración básica) a la
   tarjeta de Configuración — se usa para verificar que cada mensaje
   entrante realmente viene de Meta (firma `X-Hub-Signature-256`).
6. Usa el botón "Probar conexión con WhatsApp" para confirmar que el
   `phone_number_id` y el token de acceso son válidos.
7. El webhook necesita ser alcanzable por HTTPS público — mismo
   requisito de reverse proxy/subdominio que ya aplica al resto de la
   app.

⚠️ Esta funcionalidad se construyó siguiendo la documentación oficial de
Meta (verificación del webhook, formato de mensajes entrantes, firma de
seguridad y envío de mensajes), y se verificó todo lo que no requiere
credenciales reales (firma HMAC, handshake del webhook, autorización de
contactos, despacho de herramientas). **No se pudo probar contra un
número de WhatsApp real** porque el proyecto todavía no tiene cuenta de
Meta Business configurada — mismo caso que GLPI (sección 8) y Gemini
(sección 5). Si al conectarlo con Meta real algo no calza, avísame para
ajustarlo.

### 9.2 Telegram (Bot API)

Alternativa gratuita y más simple: no requiere cuenta de negocio, no
tiene proceso de verificación, y **no necesita exponer la app a
internet** — funciona por sondeo periódico (la app le pregunta a Telegram
cada pocos segundos si hay mensajes nuevos), no por webhook público. Ideal
si el volumen de consultas es bajo, como aquí.

**Configuración** (menú Configuración → tarjeta "Bot de Telegram"):

1. En Telegram, habla con **[@BotFather](https://t.me/BotFather)** y
   crea un bot nuevo (`/newbot`). Te dará un **token** con el formato
   `123456:ABC-DEF...`.
2. Pega ese token en la tarjeta de Configuración y guarda. Deja marcada
   la casilla "Sondeo activo".
3. Usa el botón "Probar conexión con Telegram" para confirmar que el
   token es válido.
4. Para vincular un usuario de la app: pídele que le escriba `/start` al
   bot desde su cuenta de Telegram — el bot le responderá con su **ID de
   chat** (un número). Ese ID se pega en el campo "ID de chat de
   Telegram" del perfil del usuario (Usuarios → Editar).

⚠️ Esta funcionalidad se construyó siguiendo la documentación oficial de
Telegram (`core.telegram.org/bots/api`: creación del bot vía BotFather,
formato de `getUpdates`/mensajes entrantes, endpoint `sendMessage`, y el
hecho de que el Bot API es gratuito y no requiere `api_id`/`api_hash` de
la API cruda de MTProto — esa es para otro caso de uso, automatizar
cuentas de usuario, no bots). Se verificó toda la lógica propia sin
depender de un bot real (autorización de contactos, manejo de `/start`,
despacho de herramientas, persistencia del offset de sondeo) simulando
las respuestas de la API de Telegram. **No se probó contra un bot real**
porque el proyecto todavía no tiene un token de BotFather — en cuanto lo
tengas, probamos la conexión real.

## 10. Copias de seguridad y migración a otro servidor

Toda la app vive en tres sitios: la **base de datos** (datos + configuración
completa: GLPI, SMTP, Gemini, WhatsApp, Telegram — todo lo que se edita
desde Configuración se guarda en la tabla `settings`, así que un dump de
la BD ya incluye la configuración, no hace falta copiarla aparte), el
**volumen de archivos** `uploads_data` (adjuntos y diagramas de red), y el
archivo **`.env`** (credenciales de infraestructura: contraseña de BD,
`SESSION_SECRET`, puerto, límite de subida — esto no vive en la BD y hay
que recrearlo a mano en el servidor nuevo).

Este procedimiento fue **verificado de punta a punta**: se hizo un backup
completo, se restauró en un stack Docker completamente aparte (simulando
un segundo servidor, con su propio contenedor de base de datos y su
propio volumen de archivos) y se confirmó que usuarios, 2FA, celulares,
configuración y el contenido exacto de un archivo adjunto llegaron
idénticos.

### 10.1 Desde la interfaz web (recomendado para el día a día)

En Configuración → tarjeta "Respaldo y migración" (solo admin):

- **Descargar respaldo completo (.zip)**: descarga un archivo con
  `backup.sql` (toda la base de datos: datos + configuración completa) y
  la carpeta `uploads/` (adjuntos y diagramas de red) — todo en un clic,
  sin necesidad de terminal ni acceso al servidor.
- **Restaurar base de datos**: sube el `backup.sql` (el que viene dentro
  del .zip anterior) para sobrescribir la base de datos actual con ese
  contenido. Es una acción **destructiva** — por eso pide escribir
  exactamente `RESTAURAR TODO` para confirmar, además de requerir sesión
  de administrador. Solo restaura la base de datos: los archivos
  adjuntos/diagramas siguen necesitando el paso por terminal de la
  sección 10.2 (menos frecuente — normalmente solo migras archivos una
  vez, al cambiar de servidor).
- Cada restauración queda registrada en los logs del contenedor (`docker
  compose logs app`) con qué usuario la ejecutó y el nombre del archivo.

Requiere que la imagen tenga instalado `mariadb-client` (ya viene en el
`Dockerfile` de este proyecto — si construyes tu propia imagen a partir de
otra base, agrégalo tú).

### 10.2 Por línea de comandos (para automatizar, o para migrar también los archivos)

Útil para backups programados (cron) o para el paso de migrar el volumen
de archivos, que la interfaz web todavía no cubre.

#### Backup (en el servidor de origen)

```bash
# 1) Volcado completo de la base de datos (usa el usuario root de MariaDB,
#    con la MARIADB_ROOT_PASSWORD que tengas en tu .env o docker-compose.yml)
docker compose exec -T db mariadb-dump -u root -p licencias_app > backup.sql

# 2) Volumen de archivos (adjuntos + diagramas de red) a un .tgz portable
docker run --rm -v glpi-licencias-app_uploads_data:/data -v "$(pwd)":/backup \
  alpine tar czf /backup/uploads_backup.tgz -C /data .
```

Guarda `backup.sql`, `uploads_backup.tgz` y una copia de tu `.env` (por
referencia, para no perder de vista qué SMTP/GLPI usabas antes — aunque
esos valores ya viajan dentro del dump) en un lugar seguro fuera del
servidor.

#### Restauración en el servidor nuevo

```bash
# 1) Clona el repositorio y crea un .env nuevo (mismo formato que
#    .env.example) — usa una contraseña de BD y un SESSION_SECRET
#    NUEVOS, no hace falta que coincidan con los del servidor viejo;
#    ajusta APP_BASE_URL al dominio/puerto real del servidor nuevo.
git clone <tu-repo> && cd glpi-licencias-app
cp .env.example .env   # y edítalo

# 2) Levanta los contenedores (crea una base de datos vacía)
docker compose up -d --build

# 3) Restaura el dump completo directamente (esto recrea todas las
#    tablas con los datos originales — NO ejecutes "npm run migrate" ni
#    "npm run seed" antes o después, el dump ya trae todo)
docker compose exec -T db mariadb -u root -p licencias_app < backup.sql

# 4) Restaura los archivos al volumen (todavía vacío) del contenedor nuevo
docker run --rm -v glpi-licencias-app_uploads_data:/data -v "$(pwd)":/backup \
  alpine tar xzf /backup/uploads_backup.tgz -C /data

# 5) Reinicia la app para que tome la base de datos ya poblada
docker compose restart app
```

### 10.3 Verificación post-migración (aplica a cualquiera de los dos métodos)

- Inicia sesión con las mismas credenciales de siempre — el secreto TOTP
  viajó con la BD, así que tu app autenticadora **sigue funcionando sin
  volver a escanear el QR**.
- Entra a Configuración y confirma que GLPI/SMTP/Gemini/WhatsApp/Telegram
  ya aparecen con los valores del servidor anterior (vinieron en el dump).
- Abre un registro con un adjunto (por ejemplo, un contrato en Licencias)
  y confirma que el archivo se descarga correctamente.
- Ten en cuenta que las **sesiones activas no migran** (se guardan en
  memoria del proceso, no en la BD): todos los usuarios deberán volver a
  iniciar sesión en el servidor nuevo, aunque su 2FA ya esté configurado.

## 11. Estructura del proyecto

```
sql/schema.sql        Esquema de base de datos (se aplica con npm run migrate)
src/config/           Configuración desde variables de entorno
src/db/               Pool de conexión, migración, seed del admin y reset-2fa
src/services/         Cliente GLPI, cliente Gemini (extracción IA), envío de correo, configuración, subida de archivos, TOTP (2FA)
src/jobs/              Tarea programada de recordatorios (node-cron)
src/middleware/        Autenticación, control de acceso por rol y protección CSRF
src/routes/             Rutas de cada módulo (licencias, dominios, isp, servidores, certificados, red, adjuntos, glpi, reportes, configuración, usuarios, 2FA)
views/                  Plantillas EJS (Bootstrap 5)
uploads/                Archivos subidos (adjuntos y diagramas de red)
```
