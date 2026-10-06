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
  **eliminación múltiple** desde el listado (selección con checkboxes).
  **Decomiso** (denuncia, investigación u observado): queda en el
  historial de incidentes, el equipo no se puede asignar mientras dure y
  "Resolver decomiso" lo devuelve a stock (o se registra la baja).
  **Chips** (`/celulares/chips`): cada chip es un número de línea con
  operadora, ICCID, plan y sus dos montos (costo mensual sin descuento y
  descuento vigente: se paga la diferencia); puede estar en un celular (doble
  SIM incluido), asignado a una persona sin celular, como **número de
  emergencia** (aunque la persona ya tenga celular con chip) o en stock.
  Filtros combinables con totales, **suma del costo** de lo filtrado y
  exportación a Excel. El número del celular se mantiene sincronizado con
  su chip principal. Prueba: `E2E_PERMITIR=1 node tests/celulares_chips_decomiso.e2e.js`
  **Carga por lote**: ingreso por **escaneo** de códigos de barras (lee el
  ICCID y el número de cada chip, arma la lista y aplica a todos los datos
  del lote), **importación desde Excel** con plantilla y **revisión fila
  por fila antes de registrar** (encabezados en cualquier fila), y **operadora
  masiva** (marcar uno, varios o todos los chips del listado y asignarla).
  Al escribir o escanear un número (o ICCID) ya registrado avisa **"chip
  existente"** sin esperar a guardar. **Dar de baja** un chip (fecha y
  motivo, reversible): sale de su celular y deja de sumar en lo que se paga.
  Prueba: `E2E_PERMITIR=1 node tests/celulares_chips_lote.e2e.js`
  **Doble SIM**: desde la ficha del celular se agrega el 2.º chip (lo toma
  de stock o lo registra en el momento), se elige cuál es el principal y
  se retira cualquiera; un celular admite como máximo **2 chips**. El
  segundo número sale en el listado ("Número 2"), el Excel, Reportes y el
  PDF. Los chips extra que guarda una persona se le asignan como
  **repuesto** (sin tope). **2.º chip desde notas** busca los números
  anotados a mano en las notas de los celulares ("N° 2 (uso WhatsApp)"),
  los cruza con los chips registrados y con el último recibo de cada
  operadora (inventario real: facturadas, registradas, faltantes y
  cuántas faltarían) y registra los que se marquen como 2.º chip, con el
  plan y el costo del recibo; si el celular ya tiene 2 chips, el número
  queda como repuesto de quien lo tiene. Prueba: `E2E_PERMITIR=1 node tests/celulares_doble_sim.e2e.js`
  **Tablero** (`/celulares/tablero`): indicadores para decidir (stock de
  equipos sin usuario y su cobertura, cuotas que terminan en 3 meses o
  menos para negociar la renovación, chips que se pagan sin uso, doble
  SIM, equipos sin respaldo), widgets predefinidos (celulares por marca,
  por cantidad de chips y por sede, fin de cuotas, chips por sede y por
  uso real, áreas con chips, personas con más chips, stock por modelo) y
  **widgets propios**: cada usuario elige datos (celulares o chips), por
  qué agrupar, qué medir (cantidad, cuota o costo mensual), un filtro, el
  gráfico (barras, dona o tabla) y si lo comparte (admin y editor). Un
  widget es una configuración validada, nunca SQL. El listado de celulares
  tiene la columna "Chips" para filtrar los de doble SIM. Prueba:
  `E2E_PERMITIR=1 node tests/celulares_tablero.e2e.js`
  **Estadísticas de celulares** (`/celulares/estadisticas`): totales por
  estado, área, sede, marca, modelo y operadora; equipos que se pagan **en
  cuotas** según el recibo (y cuáles de ellos están sin usuario), equipos
  que el recibo cobra y **no están registrados**, **respaldo de compra**
  (recibo, fecha de compra, contrato adjunto o ninguno) y datos que faltan;
  **completar marca y modelo desde el recibo** (solo campos vacíos y solo
  con modelos del catálogo). El listado de celulares suma las columnas
  Marca, Equipo en recibo, Línea en recibo y Respaldo de compra, y el de
  chips "En recibo", para filtrarlas. **Modelos por marca**: catálogo en
  Configuración → Catálogos → Modelos; el formulario del celular ofrece
  solo los modelos de la marca elegida. Prueba:
  `E2E_PERMITIR=1 node tests/celulares_estadisticas.e2e.js`
  **Uso real** (`/celulares/chips/uso`): de lo que se paga cada mes según
  el último recibo, cuánto está **en uso** (chips en un celular con
  usuario, asignados sin celular, de emergencia), cuánto está **guardado**
  y se paga sin usarse (repuestos, chips en celulares en stock, chips en
  stock), cuánto se **factura sin estar registrado** y qué chips
  registrados no figuran en el recibo; con detalle y Excel. Prueba:
  `E2E_PERMITIR=1 node tests/celulares_uso_real.e2e.js`
  **Recibos** (`/celulares/recibos`): se sube el recibo de la operadora
  (hoy Entel: el PDF del recibo o su Excel de detalle; se leen sin IA) y la
  app lo cruza contra el inventario en tres sentidos — número facturado →
  chips, IMEI con cuota → celulares, e inventario → recibo — marcando cada
  fila como coincide, observado (con el motivo) o faltante, con conteos y
  montos, filtros y exportación a Excel. Desde el cruce se registran en
  bloque los números faltantes como chips en stock y se copia a los chips
  su plan, costo sin descuento y descuento. El PDF agrega cuándo vencen los
  descuentos y las cuotas de equipos. Con dos o más recibos muestra la
  **evolución mes a mes** (líneas y equipos que entraron o salieron, monto
  sin descuento, descuentos, total y variación). Verifica que lo leído
  cuadre con el total del recibo.
  Una operadora nueva se agrega como un lector más en
  `src/services/mobileBillParsers/`. Prueba:
  `E2E_PERMITIR=1 node tests/celulares_recibos.e2e.js`
  (escribe datos de prueba marcados en la base configurada y los borra)
- **Empleados**: directorio reutilizable por DNI (nombres, apellidos,
  área, sede, cargo) — se alimenta automáticamente al asignar un celular,
  o se gestiona directo desde su propia pantalla
- **Catálogos** (Configuración → Gestionar catálogos, solo admin): listas
  de sedes, áreas, marcas y modelos reutilizables desde los formularios
  (por ahora, en Celulares) para estandarizar la carga de datos
- **Reportes y consultas**: vencimientos (licencias, dominios, ISP,
  servidores, certificados), inventario (celulares, chips y computadoras,
  monitores e impresoras de GLPI) y repositorios del módulo DevOps. Cada
  reporte muestra la cantidad total y por grupo (estado, sede, operadora,
  entidad…), se filtra y se exporta a Excel, CSV o **PDF para imprimir**.
  En los de inventario el PDF lleva, por fila, un código de barras
  (Code 128: IMEI, código interno, número, ICCID, n.º de serie o de
  inventario, a elección) y una casilla para marcar, para verificar el
  inventario físico con un lector contra lo que dice la aplicación
- **Preguntar a la IA** (botón en todas las pantallas; por defecto responde
  el modelo local de la empresa, y cada pregunta puede ir a otro modelo,
  local o en la nube, ver sección 5): conversa con libertad, responde sobre lo que
  hay registrado ("stock de celulares por sede", "qué vence en 60 días",
  "los 10 planes más caros"), cruza datos y busca en internet (búsqueda de
  Google de Gemini, con fuentes, si hay un proveedor Gemini activo). Cada consulta produce una tabla que se
  abre como **reporte temporal** a pantalla completa y se descarga en
  Excel o PDF (con código de barras en listados de inventario); no se
  guarda. Puede leer todo lo que el usuario puede abrir (reportes,
  empleados, asignaciones, incidentes, recibos, catálogos, adjuntos,
  diagramas y, solo admin, usuarios y auditoría), pero **no puede crear,
  cambiar ni borrar datos**: no escribe SQL y no tiene ninguna herramienta
  de escritura. Se habilita por rol en Permisos y queda en Historial de
  chat (canal web). Las consultas corren en MariaDB con índices (nunca
  carga tablas completas), en una transacción de solo lectura con tope de
  15 s y, si se configura, con un usuario de MariaDB solo con SELECT
  (`ASSISTANT_DB_USER`, ver `scripts/crear-usuario-asistente.js`). GLPI y
  los repositorios se consultan desde una copia local que se renueva cada
  30 minutos. Con una IA en la nube, los datos personales (nombres, DNI,
  números, correos) le llegan ocultos; con el servidor local no salen de
  la red.
- **Un solo usuario para las dos aplicaciones**: a DevOps Sidecar se entra
  desde el menú DevOps con el mismo usuario (ver 11.1)
- **Captcha en el inicio de sesión**, propio y sin servicios externos, más
  un tope de solicitudes por equipo contra scripts (ver 7.7)
- **Mantenimiento de base de datos** (solo admin): estado de tablas e
  índices, Analizar / Optimizar, y retención de históricos a 3 meses con
  borrado a demanda (ver 10.4)
- **HTTPS** opcional delante de las dos aplicaciones, para que
  contraseñas y sesión viajen cifradas (ver 2.1)
- **Panel principal**: además de los vencimientos, cuántos celulares y
  chips hay y cuántas computadoras, monitores e impresoras tiene GLPI
  (el conteo de GLPI se renueva cada 10 minutos)
- **Tablas ajustables** (en todas las pantallas): **ordenar con clic en
  el encabezado** (ascendente, descendente, original; números, montos y
  fechas se ordenan como tales y los vacíos van al final), **filtro en cada
  columna** (embudo en el encabezado, como en Excel: se marcan los valores
  a mostrar, con buscador y cantidad por valor; los filtros se combinan).
  En los listados grandes que paginan en el servidor (Usuarios de Clinic)
  el orden y los filtros se aplican sobre todos los registros, no solo la
  página visible, y el Excel exportado los respeta. Elija cuántos registros
  ver (10, 20, 30, 40, 50, 100 o todos) con "Anterior / Siguiente", estire
  una columna arrastrando el borde derecho de su encabezado y cámbiela de
  lugar arrastrando el encabezado. Cada persona conserva su ajuste en su
  navegador, por pantalla; "Restablecer columnas" lo deshace. "Marcar
  todos" alcanza solo a las filas que se ven
- **Adjuntos**: contratos, adendas y facturas vinculados a cada registro
- **Extracción de facturas con IA** (modelo local o en la nube): al adjuntar una factura/recibo
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
  "Contract" en GLPI, e **Inventario GLPI** (solo lectura): computadoras,
  monitores e impresoras (estado, tipo, fabricante, modelo, serie, N.º de
  inventario, ubicación, usuario), búsqueda, exportación a Excel, equipos
  conectados y software instalado — ver nota en la sección 8. Funciona con
  la **API clásica** (App-Token + User-Token; GLPI 9/10 y la "Legacy API"
  de GLPI 11) o con la **API v2 de GLPI 11** (OAuth: cliente OAuth con
  acceso "Password" + usuario de servicio), a elegir en Configuración.
  De las computadoras trae además sistema operativo y versión, procesador,
  tipo de memoria, memoria total e IP (pantalla, detalle y Excel). Esos
  datos solo los entrega la API clásica: en modo v2 la app los pide a la API
  clásica del mismo GLPI si tiene App-Token y User-Token, y si no puede,
  lista el inventario igual y explica qué activar.
  Pruebas: `node tests/glpi_inventario.e2e.js` y `node tests/glpi_v2.e2e.js`
  (contra un GLPI simulado)
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
- **Seguridad y control de acceso**: 2FA obligatorio con códigos de
  respaldo de un solo uso (recuperación de cuenta sin depender de otro
  admin ni del servidor), bloqueo de cuenta tras intentos fallidos,
  "confiar en este navegador" para saltar el 2FA en equipos de confianza,
  autoservicio de "Mi cuenta" (cambiar contraseña propia, reconfigurar el
  2FA, ver/revocar dispositivos de confianza), permisos por módulo
  configurables por rol, y un log de auditoría de solo-lectura (quién
  hizo qué, cuándo y desde dónde) — ver sección 6.1 y 7
- **DevOps Sidecar** (módulo aparte, Python/FastAPI/SQLite): audita con
  IA los repositorios de GitHub del equipo, recibe despliegues de
  Coolify por webhook, leaderboard de actividad por desarrollador, y
  respaldos incrementales/totales de cada repo — ver sección 11

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

### 2.1 HTTPS: contraseñas y sesión cifradas en la red

Por defecto las dos aplicaciones responden por HTTP (puertos 8090 y
8091): en una red interna, la contraseña y la sesión viajan sin cifrar.
`docker-compose.https.yml` agrega un proxy (Caddy) que cifra todo y deja
a las aplicaciones sin publicarse directamente. No necesita dominio
público: el certificado lo emite la autoridad interna de Caddy para el
nombre o la IP por los que se entre.

En el `.env` de la raíz:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.https.yml
APP_PUBLISH=127.0.0.1:18090
SIDECAR_PUBLISH=127.0.0.1:18091
APP_BASE_URL=https://<nombre o IP del servidor>
SIDECAR_PUBLIC_URL=https://{host}:8443
```

y luego `docker compose up -d`. Queda así:

| Dirección | Qué es |
|---|---|
| `https://<servidor>` | Aplicación principal |
| `https://<servidor>:8443` | DevOps Sidecar |
| `http://<servidor>:8090`, `:8091` y puerto 80 | Solo redirigen a las de arriba |

Con `APP_BASE_URL` en `https`, la cookie de sesión se marca `Secure`.

**El aviso del navegador.** El certificado lo firma una autoridad que las
PC todavía no conocen, así que el navegador avisa "conexión no privada"
hasta que se instale su certificado raíz. Para sacarlo del servidor:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-raiz.crt
```

e instalarlo en cada PC como "Entidad de certificación raíz de confianza"
(en un dominio de Windows, una directiva de grupo lo reparte a todas).
Mientras tanto la conexión **ya va cifrada**; lo que falta es que el
navegador confíe en quién firma. Esa autoridad vive en el volumen
`caddy_data`: si se borra, se genera otra y hay que reinstalar el raíz.
Si la empresa tiene su propia autoridad o un dominio público, se puede
cambiar `tls internal` en el `Caddyfile` por ese certificado.

### Actualizar a una versión nueva del código (migraciones)

```bash
git pull
docker compose up -d --build
docker compose exec app npm run migrate
```

`npm run migrate` es **incremental y seguro de correr siempre**, tanto en
una base de datos nueva como en una que ya está en producción con datos:

- `sql/schema.sql` es la línea base completa (se aplica como la migración
  `0001_baseline`) — dejará lista una base de datos **nueva** de un solo
  saque.
- Cualquier cambio de esquema posterior (columna o tabla nueva) que
  afecte a una instalación **ya desplegada** viene, además, como un
  archivo numerado en `sql/migrations/` (ver `sql/migrations/README.md`).
  Cada uno se aplica **una sola vez** — queda registrado en la tabla
  `schema_migrations` — así que correr `migrate` de más nunca duplica ni
  rompe nada.

En otras palabras: después de un `git pull`, siempre es correcto (y
necesario) volver a correr `npm run migrate` — no se salta nada que ya
estuviera aplicado, y sí aplica lo que sea nuevo.

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

Los campos de credenciales (App-Token/User-Token de GLPI, contraseña SMTP,
API key de Gemini, tokens de WhatsApp/Telegram) nunca vuelven a mostrar el
valor real una vez guardado — solo un placeholder enmascarado indicando
que ya está configurado. Dejarlos en blanco al guardar **mantiene el valor
que ya tenías** (igual que la contraseña en el formulario de Usuarios);
escribe un valor nuevo solo si quieres reemplazarlo.

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

## 5. Inteligencia artificial (configuración única)

En **Configuración > Inteligencia artificial** (solo `admin`) se configura
la IA de **las dos aplicaciones**: esta y DevOps Sidecar. El sidecar no
guarda API keys ni elige modelo: le pide a esta aplicación que genere por
él (`POST /interno/ia/generar`, con un pase firmado con
`SSO_SHARED_SECRET`). Su propia configuración de IA queda solo de
emergencia, si esta aplicación no responde.

**Proveedores.** Cada uno tiene tipo, dirección, modelo y (si hace falta)
API key, que se guarda cifrada:

- **Ollama** (local): un servidor de la empresa, por ejemplo
  `http://172.16.1.22:11434` con `gemma4:26b`. Los datos no salen de la
  red. Para cambiar de modelo: `ollama pull <modelo>` en el servidor,
  "Editar" el proveedor, "Cargar modelos" y elegirlo. **Contexto
  (tokens)**: Ollama usa poco por defecto y corta en silencio los textos
  largos (una auditoría con el diff del día); aquí se fija `num_ctx`
  (16 384 por defecto; más contexto usa más memoria de la GPU).
- **Google Gemini**, **Anthropic Claude** o una API **compatible con
  OpenAI** (OpenAI, LM Studio, vLLM...) en la nube: la pregunta y los datos
  necesarios se envían a ese servicio.

"**Probar**" envía una pregunta corta, mide cuánto tarda y, en Ollama,
detecta si el modelo tiene herramientas y visión. Un modelo sin
herramientas igual sirve para el asistente: se le piden en JSON
(herramientas emuladas).

**Qué modelo usa cada función:** asistente, chatbot de WhatsApp/Telegram,
lectura de facturas, auditoría diaria de DevOps y asistente/resúmenes de
DevOps. Por defecto todas usan el servidor local. Opcional: un
**respaldo** (si el asignado no responde se intenta con ese; si es de la
nube, en ese caso los datos salen de la empresa; por defecto no hay) y
dejar que cada persona elija el modelo **para cada pregunta** en el panel
"Preguntar a la IA" (se recuerda la última elección y se avisa si los
datos salen a la nube). Cada respuesta dice qué modelo respondió.

**Búsqueda en internet:** solo la tiene Gemini. Si hay un proveedor Gemini
activo, el asistente puede buscar aunque responda el modelo local (solo el
texto de la búsqueda va a Google).

### Lectura de facturas

Con Gemini o Claude el PDF o la imagen se envían tal cual. Con un modelo
local se envía el **texto** del PDF (extraído en el servidor); una imagen
necesita un modelo con visión, y un PDF escaneado (sin texto), un
proveedor que lea PDF.

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
`src/services/invoiceExtractor.js` ya queda listo para reutilizarse detrás de
cualquier origen de archivos.

### 5.1 Solicitudes, usuarios de Clinic y cuentas de Microsoft 365

**Solicitudes** (menú *Solicitudes*): quién pidió qué, para quién y cuándo,
en todos los módulos. El solicitante (jefe o gerente) se elige del
directorio de empleados (queda vinculado y se completan su cargo y área) o
se escribe si no está; se guarda como foto con la fecha y una referencia
(ticket, correo, memo). Buscando el nombre del jefe se ve todo lo que pidió.

- **Celulares**: asignar o reasignar pide "Solicitado por"; aparece en la
  asignación actual, en el historial y en Auditoría ("Corregir datos del
  usuario" también lo corrige).
- **Usuarios de Clinic** (menú *Usuarios de Clinic*): inventario con DNI,
  correo, celular, perfil, sede, área, supervisor, aprobación, última
  conexión, quién lo creó en Clinic, historial de cambios, y alta, baja y
  reactivación con quién las pidió. Perfiles y sedes de Clinic tienen tabla
  propia con su Id de Clinic (*Perfiles y sedes*): ahí se define el **área
  de cada perfil** (la toman sus usuarios sin área propia) y la sede del
  catálogo general que corresponde a cada sede de Clinic. Todo va por clave
  foránea: un perfil, una sede o un área en uso no se borra (se desactiva o
  se unifica).
  **Importar listado de Clinic** recibe el archivo que exporta Clinic tal
  cual (`Usuarios_roles_sedes_permisos.xls`, hojas USUARIOS, SEDES y
  PERFILES; también .xlsx o .csv): alimenta perfiles y sedes, crea o
  actualiza cada usuario por su **IdUsuario** (no por el usuario: Clinic
  tiene usuarios repetidos salvo un espacio invisible), deja en el
  historial lo que cambió y avisa de usuarios sin nombre de usuario,
  usuarios o DNI repetidos, usuarios que ya no vienen en el archivo y bajas
  registradas aquí que Clinic sigue mostrando ACTIVAS. Antes de guardar
  muestra una **revisión** (nuevos, qué cambia, empleados, avisos y
  errores): la importación corre completa y se deshace; nada se guarda
  hasta *Confirmar*. Con **Empleados** se elige: *solo vincular por DNI*
  (recomendado), *vincular y crear* a los activos que falten (quedan
  marcados "desde Clinic" para no mezclarlos con la planilla) o no tocar
  Empleados. Todo en una transacción; cada importación queda registrada.
  El listado marca para revisar los activos sin entrar en 90 días, los
  candidatos a depurar, los activos sin empleado en planilla, sin área, no
  aprobados o pendientes de aprobación (Aprobado: 0 no aprobado, 1
  aprobado, 3 pendiente), sin DNI y los DNI o usuarios repetidos.
  **Conexiones** es el tablero por antigüedad de la última conexión (30 /
  90 / 180 días, 1 año, más, nunca), por sede y por perfil, con los
  candidatos a depurar (activos sin entrar en 180 días o que nunca
  entraron) para exportar. La contraseña de Clinic no se guarda aquí.
- **Microsoft 365** (menú *Microsoft 365*): inventario de cuentas y
  solicitudes con flujo: *pendiente → aprobada → en proceso → completada*.
  Cada tipo genera sus pasos (alta, licencias, bloqueo, desbloqueo,
  renombre, baja por retiro, eliminación) y cada paso se marca con su
  evidencia (correo creado, licencias, ubicación del PST, quién recibe el
  buzón, correo nuevo). En cargos de **jefatura** (gerente, jefe,
  director) la baja exige **respaldo PST** y **convertir en buzón
  compartido**. Al completar, la cuenta se actualiza y queda la
  **constancia** de cada cambio (renombre de → a, reasignación del buzón y
  a quién, PST, baja); una cuenta eliminada no se borra del inventario.
- **La aplicación no escribe en el tenant**: los cambios se hacen en el
  centro de administración de Microsoft 365, Exchange o Purview (PST y
  buzón compartido no existen en Microsoft Graph). Opcionalmente
  (*Microsoft 365 > Conexión*, solo admin) lee el tenant con una aplicación
  de Entra ID con permisos **de solo lectura** `User.Read.All` y
  `Organization.Read.All`: trae las cuentas existentes, si pueden iniciar
  sesión, sus licencias y las licencias compradas/usadas, y marca las
  **diferencias** con lo registrado (ej. "desactivada aquí, puede iniciar
  sesión en el tenant"). Se lee todos los días a las 06:20. El secreto se
  guarda cifrado.

Prueba: `E2E_PERMITIR=1 node tests/solicitudes.e2e.js` (Graph simulado).

## 6. Roles de usuario

- **admin**: acceso total, incluye Usuarios, Configuración, Permisos y
  Auditoría. Nunca se le puede restringir el acceso a ningún módulo (así
  no puede auto-bloquearse la pantalla de Permisos).
- **editor**: puede crear, editar y eliminar en los módulos que tenga
  habilitados (ver 6.1), pero no accede a Usuarios, Configuración,
  Permisos ni Auditoría.
- **lector**: solo puede ver — nunca crear, editar ni eliminar, sin
  importar qué módulos tenga habilitados.

Gestiona usuarios desde **Usuarios** (solo visible para `admin`).

### 6.1 Permisos por módulo

Desde **Permisos** (solo `admin`) decides qué módulos puede **abrir**
cada rol (`editor`/`lector`) — licencias, dominios, contratos ISP,
servidores, certificados, celulares, empleados, red, inventario GLPI y
reportes. Instalar esta función **no le quita acceso a nadie**: por
defecto todos los módulos quedan habilitados para ambos roles (el mismo
comportamiento que ya existía antes de que existiera esta pantalla) hasta
que un `admin` desmarca algo a propósito.

Esto solo controla qué pantallas puede **abrir** cada rol — nunca amplía
lo que puede **escribir**: un `lector` con todos los módulos habilitados
sigue sin poder crear/editar/eliminar nada (eso lo sigue decidiendo el
rol en sí), y un `editor` al que se le apaga un módulo simplemente ya no
puede ni entrar a verlo (el enlace tampoco aparece en el menú ni en el
panel principal).

## 7. Verificación en dos pasos (2FA)

La aplicación exige **2FA obligatorio** (TOTP) para los tres roles
(admin/editor/lector). No depende de SMTP: usa una app autenticadora
(Google Authenticator, Microsoft Authenticator, Authy, etc.).

- **Primer login**: después de la contraseña, se pide escanear un código QR
  y confirmar con el código de 6 dígitos que muestra la app. Recién ahí
  queda activo el 2FA y se completa el inicio de sesión.
- **Logins siguientes**: después de la contraseña, se pide el código de 6
  dígitos vigente.
- **Si pierdes tu dispositivo (con autoservicio, recomendado)**: usa uno
  de tus **códigos de respaldo** (ver 7.5) en la pantalla de verificación
  — no necesitas ni otro admin ni acceso al servidor.
- **Si un usuario pierde su dispositivo y no le quedan códigos de
  respaldo**: un `admin` puede restablecer su 2FA desde **Usuarios** →
  botón "Restablecer 2FA" — la próxima vez que esa persona inicie sesión,
  se le pedirá configurar el 2FA de nuevo desde cero.
- **Si el único admin pierde su dispositivo y no le quedan códigos de
  respaldo** (nadie más puede restablecerlo desde la UI): con acceso al
  servidor, corre
  `docker compose exec app npm run reset-2fa -- correo@ejemplo.com`
  (o `npm run reset-2fa -- correo@ejemplo.com` en desarrollo local sin
  Docker).

### 7.1 Bloqueo de cuenta por intentos fallidos

Además del límite de intentos por IP (rate-limit), hay un **bloqueo por
cuenta**: tras 5 intentos de contraseña incorrecta seguidos, la cuenta
queda bloqueada (aunque se use la contraseña correcta después) hasta que
un `admin` la desbloquea desde **Usuarios** → botón "Desbloquear". Cada
intento fallido y cada bloqueo/desbloqueo queda registrado en Auditoría
(ver 7.3).

### 7.2 "Confiar en este navegador"

Al verificar el código de 6 dígitos (tanto en el primer enrolamiento como
en logins posteriores), hay una casilla opcional "Confiar en este
navegador por 30 días". Si la marcas, ese equipo no vuelve a pedir el
código de 2FA hasta que pasen 30 días o revoques el dispositivo tú mismo
desde **Mi cuenta**. Internamente guarda solo el *hash* de un token
aleatorio en una cookie `httpOnly` — igual que una contraseña, el valor
real nunca queda en la base de datos y no se puede reconstruir a partir
del hash.

Es un balance deliberado entre seguridad y comodidad: úsalo solo en
equipos de confianza (tu propia laptop de trabajo), nunca en un equipo
compartido.

### 7.3 Mi cuenta (autoservicio)

Cualquier usuario logueado (no solo `admin`) puede entrar a **Mi
cuenta** (el nombre/rol arriba a la derecha) para:

- Cambiar su propia contraseña (pide la actual para confirmar).
- Ver y revocar sus dispositivos de confianza.
- Ver sus últimos inicios de sesión (éxitos y fallos).
- **Reconfigurar 2FA (nuevo QR)**: reemplaza el secreto TOTP actual por
  uno nuevo sin necesidad de un admin — útil si cambiaste de celular.
- **Generar códigos de respaldo nuevos**: invalida los códigos actuales
  y muestra un set nuevo (ver 7.5).

### 7.4 Auditoría

**Auditoría** (solo `admin`) muestra un registro de solo-lectura de
quién hizo qué: inicios y cierres de sesión (éxito y fallo), cambios de
configuración, alta/edición/eliminación de usuarios, bloqueos/
desbloqueos de cuenta, cambios de permisos, y descargas/restauraciones
de respaldo — con fecha, correo, acción, objetivo, detalle e IP.
Filtrable por acción, correo y rango de fechas. Nunca se edita ni borra
desde la aplicación, solo se agrega.

### 7.5 Códigos de respaldo

Al activar el 2FA por primera vez (y cada vez que los regeneras desde
**Mi cuenta**), la app te muestra **10 códigos de un solo uso** — es la
**única vez** que se ven, así que guárdalos en un lugar seguro (gestor de
contraseñas, impreso, etc.) apenas aparezcan.

Si pierdes tu celular, en la pantalla de verificación en dos pasos abre
"¿Perdiste tu celular? Usa un código de respaldo" e ingresa uno (no
importa mayúsculas/minúsculas ni el guion). Cada código sirve una sola
vez — una vez usado, queda invalidado. Esto resuelve el caso del **admin
único sin acceso al servidor**: ya no depende de otro admin ni de la
terminal para recuperar el acceso.

Solo se guarda el *hash* de cada código (igual que una contraseña o el
token de "confiar en este navegador") — el valor real nunca queda en la
base de datos, solo existe en pantalla en el momento de generarlo.

Si se te acaban los códigos (o los perdiste junto con el celular),
recurre a los pasos de arriba (otro admin, o el comando por terminal).

### 7.6 Duración de la sesión

La sesión se guarda en la base de datos (tabla `sessions`): un reinicio o
una actualización de la aplicación ya no cierra la sesión de nadie. Vence
por **inactividad**, no a una hora fija: con **"Mantener la sesión
iniciada en este equipo"** (marcado por defecto al ingresar) dura 30 días
mientras se use; sin marcarlo, se cierra tras 12 horas sin uso (para
equipos compartidos). Cada pocos minutos se vuelve a leer el usuario: si
un administrador lo desactiva o se bloquea, su sesión abierta se cierra
en ese momento, y un cambio de rol se aplica sin volver a ingresar.

### 7.7 Captcha y límite de solicitudes

El formulario de inicio de sesión pide un **código de verificación**: 5
caracteres dibujados como trazos deformados, sin texto en la página que un
script pueda leer. Lo genera la propia aplicación (no depende de internet
ni de un servicio externo), vale para un solo intento y caduca a los 5
minutos; "Otro código" muestra uno nuevo. Se comprueba antes que la
contraseña, así que un script que no lo resuelve no llega a gastar
intentos de ninguna cuenta.

Además, cada equipo tiene un tope de 300 solicitudes por minuto (sin
contar imágenes, estilos ni scripts): muy por encima del uso de una
persona, pero corta a un programa que recorre rutas o descarga pantallas
en serie. El captcha frena scripts genéricos; no reemplaza al bloqueo de
cuenta ni al 2FA, que siguen igual.

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
  se desarrolló — mismo caso que `invoiceExtractor.js`, ver sección 5). Si al
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
- **Archivado diario comprimido**: cada noche (00:30) se cierra el día
  anterior — se comprime (gzip) la conversación de cada contacto en
  `agent_message_log_archive` y se borran las filas "en vivo" de
  `agent_message_log`, para que esa tabla no crezca sin límite. No se
  pierde nada, solo cambia el formato de guardado. Se revisa/consulta
  desde el menú **Historial de chat** (solo admin), con un botón
  "Archivar ahora" para forzarlo sin esperar a la medianoche.

**Qué puede responder hoy**: cantidad y listado de vencimientos próximos
(licencias, dominios, contratos ISP, servidores, certificados), búsqueda
de un celular por IMEI (con su asignación actual), búsqueda de un
empleado por DNI o nombre, el resumen de celulares por área, y —si está
conectado el módulo DevOps Sidecar (ver `devops-sidecar/`)— estado de los
repositorios registrados, leaderboard de desarrolladores, resumen de la
última auditoría de IA de un repo, disparar una auditoría al instante, y
los últimos despliegues recibidos de Coolify. A propósito **no** se
expone por chat nada destructivo de DevOps Sidecar (rollback, revertir un
commit, restaurar un respaldo, hacer push a GitHub) — esas acciones
requieren confirmación explícita en la interfaz web, no un mensaje de
texto que alguien pudo escribir sin querer.

**Conectar el módulo DevOps Sidecar al agente** (menú Configuración →
tarjeta "DevOps Sidecar"): pega la URL interna (`http://devops-sidecar:8000`
por defecto, el nombre del servicio en `docker-compose.yml`, no el puerto
8091 publicado al host) y el mismo usuario/contraseña del
`DASHBOARD_USER`/`DASHBOARD_PASSWORD` del `.env` de `devops-sidecar`. Sin
esto configurado, el agente simplemente no puede responder preguntas
sobre repositorios (el resto de sus funciones sigue igual).

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

### 10.0 Respaldo completo programado (recomendado)

**Configuración > Respaldos** (solo `admin`). Un respaldo completo es un
solo archivo `respaldo_aplicacion_<fecha>.tar.gz` con todo lo necesario
para volver a levantar la aplicación en otro servidor:

| Dentro | Qué es |
|---|---|
| `basedatos.sql.gz` | la base completa (datos y toda la configuración) |
| `archivos/` | adjuntos, facturas, recibos y diagramas |
| `secretos.env.enc` | los `.env` de la aplicación y de DevOps Sidecar, cifrados con la **contraseña de recuperación** (AES-256, formato de OpenSSL) |
| `manifest.json` | versión, migraciones, cantidades y SHA-256 de cada archivo |
| `RESTAURAR.txt` | los pasos para recuperar todo |

- **Programado**: lo ejecuta DevOps Sidecar con su motor de respaldos. Al
  arrancar crea una vez el trabajo **"Aplicación completa (nocturno)"**
  (02:30, todos los destinos activos, 7 noches en el servidor y 30 en
  cada destino); se cambia en DevOps > Respaldos > Trabajos programados
  (casilla "Aplicación completa"). Los destinos externos son los del
  sidecar: OneDrive, Microsoft 365, Google Drive, carpeta de red SMB, S3,
  SFTP, WebDAV o un disco, con cifrado opcional (rclone crypt).
- **Contraseña de recuperación**: sin ella el respaldo no incluye los
  `.env`, y en un servidor nuevo no se podrían leer las API keys y tokens
  guardados (están cifrados con `CREDENTIALS_ENC_KEY`). Anótela fuera del
  servidor.
- **Restaurar**: en DevOps > Respaldos > Restaurar (explorar el destino,
  elegir el punto, "Restaurar en la aplicación", frase `RESTAURAR TODO`),
  o subiendo el `.tar.gz` en Configuración > Respaldos. Antes se revisa el
  SHA-256 de cada archivo y se guarda una copia de la base actual; después
  se aplican las migraciones que falten.

**Si se pierde el servidor**:
1. Instale la aplicación en el servidor nuevo (sección 2).
2. Recupere los `.env` del respaldo:
   `tar -xzf respaldo_aplicacion_*.tar.gz secretos.env.enc && openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -in secretos.env.enc -out secretos.env`
   y copie cada sección en `glpi-licencias-app/.env` y `devops-sidecar/.env`.
3. `docker compose up -d`; en DevOps agregue de nuevo el destino externo
   y restaure desde "Restaurar". Sin la aplicación: `RESTAURAR.txt`
   trae los comandos a mano (`gunzip | mariadb`, `docker cp archivos/`).

Toda la app vive en tres sitios: la **base de datos** (datos + configuración
completa: GLPI, SMTP, proveedores de IA, WhatsApp, Telegram — todo lo que se edita
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
- Antes de aplicar la restauración, la app guarda **automáticamente** un
  respaldo de cómo estaba la base de datos justo antes (en
  `uploads/pre_restore_backups/`, dentro del volumen `uploads_data`) — un
  punto de vuelta atrás inmediato si subiste el archivo equivocado. No
  reemplaza tener respaldos propios fuera del servidor.
- Cada restauración queda registrada en Auditoría (ver 7.4) y en los logs
  del contenedor (`docker compose logs app`) con qué usuario la ejecutó y
  el nombre del archivo.

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
#    tablas con los datos originales — no hace falta "npm run seed", el
#    dump ya trae los usuarios reales. Si el dump es de una version del
#    codigo mas vieja que la que estas desplegando, corre "npm run
#    migrate" despues para aplicar las migraciones que falten - es
#    incremental y seguro, no duplica ni pisa nada de lo restaurado)
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
- Entra a Configuración y confirma que GLPI/SMTP/IA/WhatsApp/Telegram
  ya aparecen con los valores del servidor anterior (vinieron en el dump).
- Abre un registro con un adjunto (por ejemplo, un contrato en Licencias)
  y confirma que el archivo se descarga correctamente.
- Ten en cuenta que las **sesiones activas no migran** (se guardan en
  memoria del proceso, no en la BD): todos los usuarios deberán volver a
  iniciar sesión en el servidor nuevo, aunque su 2FA ya esté configurado.

### 10.4 Mantenimiento de la base de datos y retención de históricos

En **Mantenimiento BD** (solo `admin`):

- **Tablas e índices**: columnas, filas, tamaño de datos e índices,
  espacio recuperable y la lista de índices de cada tabla. Las tablas con
  más de 20 columnas se marcan en amarillo y las de más de 30, en rojo
  (el tope del proyecto es 30).
- **Analizar** pone al día las estadísticas con las que el motor elige
  índices (rápido). **Optimizar** reconstruye la tabla y sus índices y
  recupera espacio; mientras dura, esa tabla no acepta cambios, así que
  conviene hacerlo fuera de horario. Por tabla o todas a la vez.
- **Retención de históricos**: la auditoría y el historial de chat se
  conservan **3 meses** (configurable; 0 = no borrar solo). Lo más antiguo
  se borra cada madrugada (01:15). **Borrar ahora** hace lo mismo a
  demanda, con el plazo que se indique: pide escribir `BORRAR HISTORIAL`
  y guarda antes una copia de la base en
  `uploads/pre_restore_backups/`. Los datos de trabajo (celulares, chips,
  recibos, licencias) no se borran por esta vía.

## 11. Módulo adicional: DevOps Sidecar

En `devops-sidecar/` vive un **módulo aparte** (Python/FastAPI/SQLite,
un stack distinto al del resto de esta app a propósito) que audita con
IA los repositorios de GitHub del equipo, recibe el historial de
despliegues de un webhook de Coolify, calcula un leaderboard de
actividad por desarrollador, y hace respaldos incrementales/totales de
cada repo.

Vive en este mismo repositorio y se levanta como un segundo servicio en
el mismo `docker-compose.yml` (puerto `8091` por defecto, con su propia
base de datos SQLite — no comparte nada con MariaDB ni con el proceso
Node de esta app). Desde el menú (solo `admin`) hay un enlace "DevOps"
que abre su dashboard en una pestaña nueva.

```bash
cd devops-sidecar
cp .env.example .env   # completar WEBHOOK_SECRET, DASHBOARD_USER/PASSWORD, API key de IA
cd ..
docker compose up -d --build devops-sidecar
```

Detalle completo (qué está verificado y qué no, cómo configurar el
webhook de Coolify, decisiones de seguridad, estructura interna) en
[`devops-sidecar/README.md`](devops-sidecar/README.md).

### 11.1 Un solo usuario para las dos aplicaciones

Con `SSO_SHARED_SECRET` (el **mismo** valor en `.env` y en
`devops-sidecar/.env`; el instalador lo genera) a DevOps Sidecar se entra
desde el menú **DevOps** de esta aplicación, con el mismo usuario:

- Esta aplicación es la única que pide contraseña, captcha y 2FA. Al
  pulsar DevOps emite un pase firmado, de un minuto y un solo uso, y el
  sidecar abre su sesión con él.
- Entra un `admin`, o un rol al que se le habilite **DevOps** en Permisos
  (viene apagado: dentro del sidecar no hay roles, quien entra puede
  restaurar o borrar).
- El usuario y la contraseña del dashboard (`DASHBOARD_USER` /
  `DASHBOARD_PASSWORD`) dejan de abrir el sidecar. Para conservarlos como
  entrada de emergencia: `DASHBOARD_BASIC_AUTH=on` en `devops-sidecar/.env`.
- Las consultas de esta aplicación al sidecar (reporte de repositorios,
  asistente) usan un pase de servicio: ya no hace falta guardar esas
  credenciales en Configuración.

Para activarlo en una instalación existente:

```bash
S=$(openssl rand -hex 32)
echo "SSO_SHARED_SECRET=$S" >> .env
echo "SSO_SHARED_SECRET=$S" >> devops-sidecar/.env
docker compose up -d
```

Sin ese secreto, todo sigue como antes (el sidecar pide su propio usuario
y contraseña).

## 12. Estructura del proyecto

```
sql/schema.sql        Esquema base completo (migracion "0001_baseline")
sql/migrations/        Migraciones incrementales numeradas (npm run migrate aplica todo)
src/config/           Configuración desde variables de entorno
src/db/               Pool de conexión, migración, seed del admin y reset-2fa
src/services/         Cliente GLPI, IA (aiService + ai/providers: Ollama, Gemini, Claude, compatibles con OpenAI; lectura de facturas), envío de correo, configuración, subida de archivos, TOTP (2FA), respaldo/restauración, auditoría, dispositivos de confianza
src/jobs/              Tarea programada de recordatorios (node-cron), sondeo de Telegram
src/middleware/        Autenticación, permisos por módulo, y protección CSRF
src/routes/             Rutas de cada módulo (licencias, dominios, isp, servidores, certificados, celulares, empleados, red, glpi, reportes, configuración, usuarios, 2FA, permisos, auditoría, mi-cuenta)
views/                  Plantillas EJS (Bootstrap 5)
uploads/                Archivos subidos (adjuntos y diagramas de red)
```
