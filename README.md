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
  equipo) y devolución a stock, y un **resumen por área** con checklist
  de auditoría física (estatus, última fecha, observación)
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
  equipos/entidades para vincular registros, y sincronización de licencias,
  dominios, contratos ISP, servidores/activos y certificados como objetos
  "Contract" en GLPI
- **Tipo de cambio USD → PEN**: se muestra en el panel principal y junto a
  cada monto en dólares, usando la API pública y gratuita del BCRP (Banco
  Central de Reserva del Perú) — sin API key
- **Importación masiva (CSV/Excel)**: carga por lote de licencias, dominios,
  contratos ISP, servidores, certificados y celulares ya existentes, con
  plantilla descargable y reporte de filas con error

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

- **Integración GLPI**: URL base de la API REST (ej.
  `https://svrmonitor-dp.ad.depilzone.com.pe/apirest.php`), App-Token y
  User-Token. El botón "Probar ahora" valida la conexión.
  - El App-Token se genera en GLPI: *Configuración → General → pestaña API*
    (habilitar la API REST y generar/copiar el App-Token).
  - El User-Token se genera desde el perfil del usuario de servicio en GLPI:
    *Preferencias → pestaña "Claves API personales"*.
  - Ese usuario de GLPI debe tener perfil con permisos sobre `Contract`,
    `Computer` y `Entity` en las entidades donde quieras buscar/crear datos.
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

## 9. Copias de seguridad

- **Base de datos**: `docker compose exec db mariadb-dump -u root -p licencias_app > backup.sql`
- **Archivos adjuntos y diagramas de red**: viven en el volumen Docker
  `uploads_data` (montado en `/app/uploads` dentro del contenedor). Inclúyelo
  en tu rutina de backups del servidor.

## 10. Estructura del proyecto

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
