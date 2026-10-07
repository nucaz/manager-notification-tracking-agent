-- =====================================================================
-- Esquema de base de datos: Licencias, Dominios, Contratos ISP y Red
-- Aplicación complementaria a GLPI (integración vía API REST)
-- =====================================================================
--
-- Este archivo es la LINEA BASE completa (se aplica como la migracion
-- "0001_baseline" - ver src/db/migrate.js): siempre debe reflejar el
-- esquema completo y actualizado, para que una base de datos nueva quede
-- lista de un solo saque. TODO CAMBIO a este archivo (columna nueva,
-- tabla nueva, indice nuevo) en una tabla que ya pudo existir en una base
-- de datos ya desplegada TAMBIEN necesita su propio archivo incremental
-- en sql/migrations/000X_descripcion.sql (con SOLO el cambio puntual,
-- usando clausulas idempotentes de MariaDB: ADD COLUMN IF NOT EXISTS,
-- CREATE TABLE IF NOT EXISTS, etc.) - de lo contrario, un servidor en
-- produccion que ya tenia la tabla se queda sin la columna nueva al
-- correr "npm run migrate". Ver sql/migrations/README.md.

SET NAMES utf8mb4;
SET time_zone = '-05:00';

-- ---------------------------------------------------------------------
-- Usuarios de la aplicación (independiente de GLPI)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('superadmin','admin','editor','lector') NOT NULL DEFAULT 'lector', -- superadmin: todo; admin: modulos sin lo critico
  active TINYINT(1) NOT NULL DEFAULT 1,
  otp_secret VARCHAR(64) NULL,                  -- secreto TOTP (base32), NULL hasta enrolar
  otp_enabled TINYINT(1) NOT NULL DEFAULT 0,     -- 1 una vez confirmado el enrolamiento 2FA
  otp_confirmed_at DATETIME NULL,
  whatsapp_number VARCHAR(20) NULL UNIQUE,       -- formato E.164 sin "+", ej: 51987654321
  telegram_chat_id VARCHAR(32) NULL UNIQUE,      -- id numerico de chat de Telegram (lo revela el bot con /start)
  failed_login_attempts INT NOT NULL DEFAULT 0,  -- se resetea a 0 en cada login exitoso
  locked TINYINT(1) NOT NULL DEFAULT 0,          -- 1 tras demasiados intentos fallidos seguidos; solo un admin lo destraba
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Configuración general de la app (SMTP, GLPI, umbrales de recordatorio)
-- almacenada como pares clave/valor editables desde la UI
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  `key` VARCHAR(100) PRIMARY KEY,
  `value` TEXT,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Licencias de software (Microsoft 365, Power BI, Office, antivirus, etc.)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS software_licenses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_name VARCHAR(150) NOT NULL,          -- ej: Microsoft 365 E3, Power BI Pro, Office 2021
  vendor VARCHAR(150),                          -- ej: Microsoft, Adobe
  license_type VARCHAR(100),                    -- ej: Suscripción anual, Perpetua, OEM
  license_key VARCHAR(255),
  seats INT DEFAULT 1,                          -- número de asientos/usuarios
  assigned_to VARCHAR(150),                     -- área/usuario asignado
  cost DECIMAL(12,2),
  currency VARCHAR(10) DEFAULT 'PEN',
  purchase_date DATE,
  start_date DATE,
  expiration_date DATE,
  auto_renew TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('activa','por_vencer','vencida','cancelada') NOT NULL DEFAULT 'activa',
  site_location VARCHAR(150),                   -- local/sede al que corresponde la licencia
  glpi_entity_id INT NULL,                      -- vínculo opcional a entidad GLPI
  glpi_computer_id INT NULL,                    -- vínculo opcional a equipo GLPI
  glpi_contract_id INT NULL,                    -- id del objeto Contract creado/sincronizado en GLPI
  notes TEXT,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_license_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_license_expiration (expiration_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Dominios (renovación/vencimiento)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS domains (
  id INT AUTO_INCREMENT PRIMARY KEY,
  domain_name VARCHAR(255) NOT NULL,
  registrar VARCHAR(150),                       -- ej: GoDaddy, NIC.pe
  dns_provider VARCHAR(150),
  registration_date DATE,
  expiration_date DATE,
  renewal_cost DECIMAL(12,2),
  currency VARCHAR(10) DEFAULT 'PEN',
  auto_renew TINYINT(1) NOT NULL DEFAULT 0,
  responsible VARCHAR(150),                     -- responsable interno
  site_location VARCHAR(150),                   -- local/sede al que corresponde el dominio
  status ENUM('activo','por_vencer','vencido','cancelado') NOT NULL DEFAULT 'activo',
  glpi_contract_id INT NULL,                    -- id del objeto Contract creado/sincronizado en GLPI
  notes TEXT,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_domain_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_domain_expiration (expiration_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Contratos con proveedores de internet (ISP)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS isp_contracts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  provider VARCHAR(150) NOT NULL,               -- ej: Claro, Movistar, WOW
  contract_number VARCHAR(100),
  service_type VARCHAR(100),                    -- ej: Fibra dedicada, Internet residencial, Enlace punto a punto
  bandwidth_down VARCHAR(50),                   -- ej: 100 Mbps
  bandwidth_up VARCHAR(50),                     -- ej: 100 Mbps
  monthly_cost DECIMAL(12,2),
  currency VARCHAR(10) DEFAULT 'PEN',
  start_date DATE,
  end_date DATE,
  auto_renew TINYINT(1) NOT NULL DEFAULT 0,
  sla_notes TEXT,
  contact_name VARCHAR(150),
  contact_phone VARCHAR(50),
  contact_email VARCHAR(150),
  site_location VARCHAR(150),                   -- local/sede al que corresponde el contrato
  status ENUM('activo','por_vencer','vencido','cancelado') NOT NULL DEFAULT 'activo',
  glpi_contract_id INT NULL,                    -- id del objeto Contract creado/sincronizado en GLPI
  notes TEXT,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_isp_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_isp_expiration (end_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Servidores / Activos TI (fisicos, virtuales, nube, contenedores)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS servers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,                   -- nombre / hostname del activo
  asset_type ENUM('fisico','virtual','nube','contenedor','otro') NOT NULL DEFAULT 'otro',
  environment ENUM('produccion','pruebas','calidad','desarrollo') NOT NULL DEFAULT 'produccion',
  criticality ENUM('critica','alta','media','baja') NOT NULL DEFAULT 'media',
  ip_address VARCHAR(100),
  operating_system VARCHAR(150),
  provider VARCHAR(150),                        -- proveedor cloud/hosting o fabricante
  responsible VARCHAR(150),                     -- responsable interno
  site_location VARCHAR(150),                   -- local/sede o datacenter
  purchase_date DATE,
  support_expiration_date DATE,                 -- vencimiento de soporte/garantia (dispara recordatorios)
  cost DECIMAL(12,2),
  currency VARCHAR(10) DEFAULT 'PEN',
  status ENUM('activo','mantenimiento','baja') NOT NULL DEFAULT 'activo',
  dependencies TEXT,                            -- que servicios/procesos dependen de este activo (texto libre)
  glpi_computer_id INT NULL,                    -- vinculo opcional a equipo GLPI
  glpi_contract_id INT NULL,                    -- id del objeto Contract creado/sincronizado en GLPI (soporte)
  notes TEXT,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_server_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_server_support_expiration (support_expiration_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Certificados TLS/SSL
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS certificates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  common_name VARCHAR(255) NOT NULL,            -- dominio/subdominio cubierto
  certificate_type ENUM('single','wildcard','san','otro') NOT NULL DEFAULT 'single',
  issuer VARCHAR(150),                          -- entidad certificadora: Let's Encrypt, DigiCert, etc.
  domain_id INT NULL,                           -- vinculo opcional al dominio ya registrado
  issue_date DATE,
  expiration_date DATE,
  auto_renew TINYINT(1) NOT NULL DEFAULT 0,
  cost DECIMAL(12,2),
  currency VARCHAR(10) DEFAULT 'PEN',
  responsible VARCHAR(150),
  site_location VARCHAR(150),
  status ENUM('activo','por_vencer','vencido','revocado') NOT NULL DEFAULT 'activo',
  glpi_contract_id INT NULL,                    -- id del objeto Contract creado/sincronizado en GLPI
  notes TEXT,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_certificate_domain FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE SET NULL,
  CONSTRAINT fk_certificate_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_certificate_expiration (expiration_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Codigos de pais para el numero de linea de celulares (menu desplegable
-- extensible desde Configuracion > Catalogos). mobile_length es la
-- cantidad de digitos del numero SIN el codigo de pais (Peru = 9). Sin FK
-- desde mobile_devices a proposito - mismo criterio que catalog_items:
-- sugiere/estandariza, no restringe a nivel de base de datos.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS phone_country_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  country_name VARCHAR(80) NOT NULL,
  calling_code VARCHAR(5) NOT NULL,             -- sin el "+", ej: '51'
  mobile_length TINYINT UNSIGNED NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_phone_country_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_phone_country (country_name, calling_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Celulares / activos moviles
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mobile_devices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  imei VARCHAR(30) NOT NULL,                    -- estandar mundial: 15 digitos numericos (TAC 8 + serie 6 + digito de control 1)
  phone_country_code_id INT NULL,               -- ver phone_country_codes; sin FK dura (ver nota arriba)
  phone_number VARCHAR(30),                     -- solo el numero local (sin codigo de pais), NULL si no tiene chip
  has_chip TINYINT(1) NOT NULL DEFAULT 0,
  asset_code VARCHAR(12),                       -- codigo interno, ej: A-00868 (prefijo+correlativo, ver settings mobile_asset_code_*)
  brand VARCHAR(100),                           -- marca, ej: Samsung, Oppo
  model VARCHAR(20),
  operadora VARCHAR(50),                        -- Entel, Claro, Movistar, Bitel... (catalog_items, extensible)
  purchase_date DATE,                           -- fecha de compra del equipo
  condicion ENUM('nuevo','usado'),              -- estado del equipo al ingresar al inventario
  area VARCHAR(100) NOT NULL,                   -- area/departamento (texto libre)
  sede VARCHAR(100),                            -- sede fisica (texto libre)
  status ENUM('en_stock','asignado','en_reparacion','en_decomiso','de_baja') NOT NULL DEFAULT 'en_stock',
  notes VARCHAR(250),
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_mobile_device_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_mobile_device_area (area),
  INDEX idx_mobile_device_status_sede (status, sede, area),
  INDEX idx_mobile_device_phone_country (phone_country_code_id),
  INDEX idx_mobile_device_imei (imei),
  INDEX idx_mobile_device_asset_code (asset_code),
  INDEX idx_mobile_device_lugar (sede, area, asset_code),
  INDEX idx_mobile_device_phone_number (phone_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Directorio de empleados (DNI, nombres, apellidos, area/sede/cargo).
-- Reutilizado al asignar celulares (y a futuro otros activos) para no
-- retipear y estandarizar el dato de la persona.
CREATE TABLE IF NOT EXISTS employees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  dni VARCHAR(20) NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  area VARCHAR(100),
  sede VARCHAR(100),
  cargo VARCHAR(150),
  source VARCHAR(20) NULL,                      -- NULL = directorio/planilla; 'clinic' = creado desde el listado de Clinic
  notes TEXT,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_employee_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_employee_dni (dni),
  INDEX idx_employee_source (source),
  INDEX idx_employee_name (last_name, first_name),
  INDEX idx_employee_area (area),
  INDEX idx_employee_sede (sede)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historial de asignaciones de celulares. A lo sumo una fila con
-- returned_date NULL por device_id (la asignacion activa); esa regla se
-- aplica en la app, no como constraint de BD.
CREATE TABLE IF NOT EXISTS mobile_device_assignments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  device_id INT NOT NULL,
  employee_id INT NULL,                         -- vinculo al directorio de empleados
  holder_name VARCHAR(150) NOT NULL,            -- snapshot inmutable (nombres+apellidos al momento de asignar)
  cargo VARCHAR(150),
  turno VARCHAR(50),
  area VARCHAR(100) NULL,                       -- donde estuvo el equipo durante esta asignacion
  sede VARCHAR(100) NULL,
  assigned_date DATE,
  returned_date DATE NULL,                      -- NULL = asignacion activa
  estado_final VARCHAR(20) NULL,                -- como termino: reasignado | en_stock | de_baja | en_decomiso
  observacion TEXT,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_assignment_device FOREIGN KEY (device_id) REFERENCES mobile_devices(id) ON DELETE CASCADE,
  CONSTRAINT fk_assignment_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL,
  CONSTRAINT fk_assignment_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_assignment_device (device_id, returned_date),
  INDEX idx_assignment_vigente (returned_date, assigned_date),
  INDEX idx_assignment_desde (assigned_date, device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Checklist fisico por area (hoja "RESUMEN" del Excel original). Una fila
-- por area, se auto-crea (INSERT IGNORE) cuando aparece un area nueva.
CREATE TABLE IF NOT EXISTS mobile_device_area_audits (
  area VARCHAR(100) PRIMARY KEY,
  estatus ENUM('pendiente','verificado','con_diferencias') NOT NULL DEFAULT 'pendiente',
  ultima_fecha DATE,
  observacion TEXT,
  updated_by INT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_area_audit_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historial permanente de reparaciones, accidentes y bajas por dano de
-- cada celular (no es exclusivo de un mes: se registra cada vez que
-- ocurre y el reporte mensual de inventario simplemente filtra por
-- fecha). 'reparacion' es el unico tipo "cerrable" (fecha_resolucion);
-- 'accidente' queda como registro informativo del hecho; 'baja' es
-- terminal y refleja mobile_devices.status = 'de_baja'. 'decomiso'
-- (motivo: denuncia, investigacion u observado) deja el equipo
-- 'en_decomiso' y tambien se cierra con fecha_resolucion: al resolverlo el
-- equipo vuelve a stock.
CREATE TABLE IF NOT EXISTS mobile_device_incidents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  device_id INT NOT NULL,
  tipo ENUM('reparacion','accidente','baja','decomiso') NOT NULL,
  motivo VARCHAR(20) NULL,                      -- solo 'decomiso': denuncia | investigacion | observado
  fecha DATE NOT NULL,
  descripcion TEXT,
  costo DECIMAL(10,2) NULL,
  fecha_resolucion DATE NULL,                   -- 'reparacion' y 'decomiso': cuando volvio a servicio / a stock
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_mobile_incident_device FOREIGN KEY (device_id) REFERENCES mobile_devices(id) ON DELETE CASCADE,
  CONSTRAINT fk_mobile_incident_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_mobile_incident_device (device_id),
  INDEX idx_mobile_incident_fecha (fecha),
  INDEX idx_mobile_incident_tipo_fecha (tipo, fecha)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Chips (lineas). Un chip es siempre un numero de linea; puede estar
-- puesto en un celular (device_id), asignado a una persona sin celular
-- (mobile_line_assignments: 'personal' = lo usa en su propio equipo,
-- 'emergencia' = numero de respaldo aunque ya tenga celular con chip) o en
-- stock. mobile_devices.phone_number/has_chip se mantienen como el chip
-- principal del equipo y los sincroniza src/services/mobileLineService.js.
CREATE TABLE IF NOT EXISTS mobile_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  phone_country_code_id INT NULL,
  phone_number VARCHAR(30) NOT NULL,
  iccid VARCHAR(22) NULL,
  operadora VARCHAR(50) NULL,
  plan VARCHAR(60) NULL,
  costo_plan DECIMAL(10,2) NULL,                -- cargo fijo mensual SIN descuento
  descuento_plan DECIMAL(10,2) NULL,            -- descuento mensual vigente; se paga costo_plan - descuento_plan
  descuento_nota VARCHAR(150) NULL,             -- de donde sale el descuento y hasta cuando (ej. fidelizacion 11/18)
  estado ENUM('activo','suspendido','de_baja') NOT NULL DEFAULT 'activo',
  fecha_baja DATE NULL,                         -- solo con estado 'de_baja': desde cuando ya no se paga
  motivo_baja VARCHAR(150) NULL,
  device_id INT NULL,
  notes VARCHAR(250) NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_mobile_line_device FOREIGN KEY (device_id) REFERENCES mobile_devices(id) ON DELETE SET NULL,
  CONSTRAINT fk_mobile_line_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_mobile_line_number (phone_number),
  INDEX idx_mobile_line_device (device_id),
  INDEX idx_mobile_line_estado_operadora (estado, operadora, device_id),
  INDEX idx_mobile_line_operadora (operadora),
  INDEX idx_mobile_line_iccid (iccid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mobile_line_assignments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  line_id INT NOT NULL,
  employee_id INT NULL,
  holder_name VARCHAR(150) NOT NULL,
  uso ENUM('personal','emergencia','repuesto') NOT NULL DEFAULT 'personal', -- repuesto: chip extra que guarda la persona (mas alla de los 2 que admite un celular)
  assigned_date DATE NULL,
  returned_date DATE NULL,
  observacion VARCHAR(250) NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_mobile_line_asg_line FOREIGN KEY (line_id) REFERENCES mobile_lines(id) ON DELETE CASCADE,
  CONSTRAINT fk_mobile_line_asg_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL,
  CONSTRAINT fk_mobile_line_asg_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_mobile_line_asg_line (line_id),
  INDEX idx_mobile_line_asg_employee (employee_id),
  INDEX idx_mobile_line_asg_active (line_id, returned_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Recibos de las operadoras (subidos en PDF o Excel). Se guarda lo que el
-- recibo factura: una fila por linea (mobile_bill_lines) y una por cargo a
-- nivel de cuenta (mobile_bill_charges: las cuotas de equipos traen IMEI).
-- El cruce contra el inventario NO se guarda: se calcula al consultarlo
-- (src/services/mobileBillService.js), asi refleja el inventario de hoy.
-- El recibo no relaciona numero con IMEI: son dos listas independientes.
CREATE TABLE IF NOT EXISTS mobile_bills (
  id INT AUTO_INCREMENT PRIMARY KEY,
  operadora VARCHAR(50) NOT NULL,
  recibo_nro VARCHAR(40) NOT NULL,
  cuenta VARCHAR(40) NULL,
  razon_social VARCHAR(150) NULL,
  ruc VARCHAR(20) NULL,
  fecha_emision DATE NULL,
  periodo_inicio DATE NULL,
  periodo_fin DATE NULL,
  fecha_vencimiento DATE NULL,
  total_pagar DECIMAL(12,2) NULL,
  total_lineas DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_cargos DECIMAL(12,2) NOT NULL DEFAULT 0,
  saldo_anterior DECIMAL(12,2) NOT NULL DEFAULT 0,
  origen ENUM('pdf','excel') NOT NULL,
  archivo_nombre VARCHAR(255) NULL,
  archivo_guardado VARCHAR(255) NULL,
  uploaded_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_mobile_bill_user FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_mobile_bill (operadora, recibo_nro),
  INDEX idx_mobile_bill_emision (fecha_emision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mobile_bill_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bill_id INT NOT NULL,
  phone_number VARCHAR(30) NOT NULL,
  plan VARCHAR(80) NULL,
  cargo_fijo DECIMAL(10,2) NOT NULL DEFAULT 0,
  descuento DECIMAL(10,2) NOT NULL DEFAULT 0,
  otros DECIMAL(10,2) NOT NULL DEFAULT 0,
  monto_total DECIMAL(10,2) NOT NULL DEFAULT 0,
  descuento_tipo VARCHAR(120) NULL,
  descuento_cuota SMALLINT NULL,
  descuento_cuotas SMALLINT NULL,
  CONSTRAINT fk_mobile_bill_line_bill FOREIGN KEY (bill_id) REFERENCES mobile_bills(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_mobile_bill_line (bill_id, phone_number),
  INDEX idx_mobile_bill_line_number (phone_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mobile_bill_charges (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bill_id INT NOT NULL,
  descripcion VARCHAR(255) NOT NULL,
  imei VARCHAR(30) NULL,
  modelo VARCHAR(100) NULL,
  folio VARCHAR(40) NULL,
  cuota_nro SMALLINT NULL,
  cuota_total SMALLINT NULL,
  monto DECIMAL(10,2) NOT NULL DEFAULT 0,
  CONSTRAINT fk_mobile_bill_charge_bill FOREIGN KEY (bill_id) REFERENCES mobile_bills(id) ON DELETE CASCADE,
  INDEX idx_mobile_bill_charge_bill (bill_id),
  INDEX idx_mobile_bill_charge_imei (imei)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Catalogos genericos (maestros): sede, area, marca, modelo, etc.
-- Los modulos que los usan (por ahora, Celulares) guardan el VALOR como
-- texto libre, no una FK — el catalogo sugiere/estandariza, no restringe
-- a nivel de base de datos (para no romper datos ya importados).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  catalog_type VARCHAR(50) NOT NULL,
  value VARCHAR(150) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_catalog_item_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_catalog_value (catalog_type, value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Bitacora del agente conversacional (WhatsApp y/o Telegram): quien
-- pregunto que y que se le respondio, por canal. Ambos son canales
-- accesibles desde fuera de la red interna, asi que queda este registro
-- por trazabilidad/auditoria.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_message_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  channel ENUM('whatsapp','telegram','web') NOT NULL, -- 'web' = asistente dentro de la aplicacion
  contact VARCHAR(100) NOT NULL,                -- numero de WhatsApp, chat_id de Telegram o correo del usuario (web)
  user_id INT NULL,                             -- NULL si el contacto no estaba autorizado
  direction ENUM('entrante','saliente') NOT NULL,
  message_text TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_agent_log_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_agent_log_contact (channel, contact),
  INDEX idx_agent_log_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cada noche se "cierra" el dia anterior de agent_message_log: se
-- comprime (gzip) en una fila aca y se borran las filas crudas de arriba,
-- para no dejar crecer esa tabla sin limite (ver
-- src/jobs/archiveChatLogs.js). Un registro por (canal, contacto, dia).
CREATE TABLE IF NOT EXISTS agent_message_log_archive (
  id INT AUTO_INCREMENT PRIMARY KEY,
  channel ENUM('whatsapp','telegram','web') NOT NULL,
  contact VARCHAR(100) NOT NULL,
  user_id INT NULL,
  log_date DATE NOT NULL,
  message_count INT NOT NULL,
  compressed_data LONGBLOB NOT NULL,              -- gzip de un JSON [{direction, message_text, created_at}, ...]
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_agent_log_archive_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uq_agent_log_archive (channel, contact, log_date),
  INDEX idx_agent_log_archive_date (log_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Auditoria: quien hizo que, desde donde. Se escribe en login (exito y
-- fallo), cambios de configuracion, gestion de usuarios, y respaldo/
-- restauracion de la base de datos. Solo se agrega, nunca se edita ni
-- borra desde la app. user_id puede quedar NULL (login fallido con
-- usuario inexistente, o el usuario fue eliminado despues) - por eso
-- user_email queda ademas como texto plano, para que el registro siga
-- siendo legible aunque la cuenta ya no exista.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  user_email VARCHAR(150) NULL,
  action VARCHAR(64) NOT NULL,        -- ej: 'login', 'login_failed', 'settings_update', 'backup_restore'
  target VARCHAR(255) NULL,           -- sobre que actuo, ej: nombre de un usuario o registro
  detail TEXT NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_log_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_audit_log_action_fecha (action, created_at),
  INDEX idx_audit_log_created (created_at),
  INDEX idx_audit_log_email (user_email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Permisos por modulo: que modulos puede ABRIR cada rol configurable
-- (editor, lector) - admin siempre ve todo, nunca aparece aca (para que
-- nunca pueda auto-bloquearse esta misma pantalla). La ausencia de una
-- fila para (role, module) significa "usar el default de fabrica" (ver
-- MODULES/DEFAULT_MODULE_ACCESS en src/middleware/modules.js), NO
-- "habilitado" - asi instalar esto no cambia el acceso de nadie hasta que
-- un admin toque un checkbox en /permisos. Esto SOLO protege las rutas de
-- vista de cada modulo; las rutas de escritura siguen con su propio
-- canWrite/isAdmin de siempre, sin tocar - nunca amplia lo que un rol ya
-- podia hacer, solo decide que pantallas puede abrir.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS role_modules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  role ENUM('editor','lector') NOT NULL,
  module VARCHAR(32) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uniq_role_module (role, module)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- "Confiar en este navegador": permite saltar el codigo TOTP por un
-- tiempo en un equipo ya verificado una vez. Se guarda el hash del token
-- (nunca el valor crudo), igual que una contrasena - la cookie del
-- navegador solo tiene el valor crudo, que nunca se puede reconstruir a
-- partir del hash guardado aca.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trusted_devices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  label VARCHAR(200) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  CONSTRAINT fk_trusted_device_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_trusted_device_token (token_hash),
  INDEX idx_trusted_device_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Codigos de respaldo de un solo uso para el 2FA: permiten que un admin
-- unico recupere el acceso sin depender de otro admin ni de la terminal
-- del servidor si pierde su celular. Se generan 10 al activar el 2FA (y
-- cada vez que el usuario los regenera desde Mi cuenta), se muestran UNA
-- sola vez, y solo se guarda el hash de cada uno (igual que una
-- contrasena) - nunca el valor en texto plano.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backup_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  code_hash VARCHAR(255) NOT NULL,
  used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_backup_code_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_backup_code_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Adjuntos: contratos, adendas, facturas — vinculados de forma polimórfica
-- a licencias, dominios, contratos ISP, servidores, certificados o celulares
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entity_type ENUM('license','domain','isp_contract','server','certificate','mobile_device') NOT NULL,
  entity_id INT NOT NULL,
  doc_type ENUM('contrato','adenda','factura','otro') NOT NULL DEFAULT 'otro',
  original_name VARCHAR(255) NOT NULL,
  stored_path VARCHAR(500) NOT NULL,
  mime_type VARCHAR(150),
  size_bytes BIGINT,
  description VARCHAR(255),
  uploaded_by INT NULL,
  uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- --- Datos extraídos automáticamente por IA (factura/recibo) ---
  extraction_status ENUM('pendiente','completado','error') NOT NULL DEFAULT 'pendiente',
  extraction_error TEXT,
  extracted_amount DECIMAL(12,2),
  extracted_currency VARCHAR(10),
  extracted_concept VARCHAR(255),
  extracted_provider VARCHAR(150),
  extracted_invoice_number VARCHAR(100),
  extracted_tax_id VARCHAR(50),                 -- RUC/NIT del proveedor
  extracted_issue_date DATE,
  extracted_due_date DATE,
  extracted_site VARCHAR(150),                  -- local/sede mencionado en el documento
  extracted_at DATETIME NULL,
  applied_at DATETIME NULL,                     -- cuando se copiaron estos datos al registro principal
  CONSTRAINT fk_attachment_user FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_attachment_entity (entity_type, entity_id),
  INDEX idx_attachment_subido (uploaded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Módulo de Red: topologías y diagramas de arquitectura
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS network_diagrams (
  id INT AUTO_INCREMENT PRIMARY KEY,
  category ENUM(
    'arquitectura_web',
    'infraestructura_ti',
    'datacenter',
    'networking',
    'azure',
    'aws',
    'vps_hosting',
    'housing',
    'otro'
  ) NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  original_name VARCHAR(255) NOT NULL,
  stored_path VARCHAR(500) NOT NULL,
  mime_type VARCHAR(150),
  size_bytes BIGINT,
  version INT NOT NULL DEFAULT 1,
  replaces_id INT NULL,                         -- versión anterior, si aplica
  uploaded_by INT NULL,
  uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_diagram_user FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_diagram_replaces FOREIGN KEY (replaces_id) REFERENCES network_diagrams(id) ON DELETE SET NULL,
  INDEX idx_diagram_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Log de recordatorios enviados (evita duplicados por umbral)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reminder_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entity_type ENUM('license','domain','isp_contract','server','certificate') NOT NULL,
  entity_id INT NOT NULL,
  threshold_days INT NOT NULL,
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  recipients TEXT,
  UNIQUE KEY uniq_reminder (entity_type, entity_id, threshold_days)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Valores iniciales de configuración
-- ---------------------------------------------------------------------
INSERT INTO settings (`key`, `value`) VALUES
  ('reminder_thresholds_days', '90,60,30,15,7,1'),
  ('reminder_recipients', ''),
  ('reminder_send_hour', '8'),
  ('glpi_base_url', ''),
  ('glpi_app_token', ''),
  ('glpi_user_token', ''),
  ('smtp_host', ''),
  ('smtp_port', '587'),
  ('smtp_secure', 'false'),
  ('smtp_user', ''),
  ('smtp_pass', ''),
  ('smtp_from', 'monitoreo@depilzone.com.pe'),
  ('app_name', 'Gestión de Licencias, Dominios y Contratos'),
  ('ai_provider', 'gemini'),
  ('gemini_api_key', ''),
  ('gemini_model', 'gemini-2.5-flash'),
  ('whatsapp_phone_number_id', ''),
  ('whatsapp_access_token', ''),
  ('whatsapp_verify_token', ''),
  ('whatsapp_app_secret', ''),
  ('telegram_bot_token', ''),
  ('telegram_polling_enabled', 'true'),
  ('telegram_last_update_id', '0'),
  ('mobile_asset_code_prefix', 'A-'),
  ('mobile_asset_code_digits', '5')
ON DUPLICATE KEY UPDATE `key`=`key`;

-- ---------------------------------------------------------------------
-- Catalogos iniciales (valores ya usados en las hojas de la organizacion)
-- ---------------------------------------------------------------------
INSERT IGNORE INTO catalog_items (catalog_type, value) VALUES
  ('sede', 'SURCO'),
  ('sede', 'MEGA PLAZA'),
  ('sede', 'IZAGUIRRE'),
  ('sede', 'PUEBLO LIBRE'),
  ('area', 'ADMINISTRADORAS'),
  ('area', 'BO'),
  ('area', 'ESPECIALISTAS PL'),
  ('area', 'VENTAS'),
  ('area', 'CAPACITACION'),
  ('area', 'CAPACITACION ESPECIALISTA'),
  ('area', 'CM'),
  ('area', 'MARKETING'),
  ('area', 'CONEXION'),
  ('area', 'TESORERIA'),
  ('area', 'LOGISTICA'),
  ('area', 'RRHH'),
  ('area', 'CONTABILIDAD'),
  ('area', 'SEGURIDAD'),
  ('area', 'SISTEMAS'),
  ('area', 'GERENCIA'),
  ('area', 'MANTENIMIENTO'),
  ('marca', 'Samsung'),
  ('marca', 'Oppo'),
  ('marca', 'Motorola'),
  ('marca', 'Xiaomi'),
  ('modelo', 'A76'),
  ('modelo', 'A75'),
  ('modelo', 'A55'),
  ('operadora', 'Entel'),
  ('operadora', 'Claro'),
  ('operadora', 'Movistar'),
  ('operadora', 'Bitel'),
  ('area', 'BACKOFFICE'),
  ('area', 'C-MANAGER'),
  ('area', 'ESPECIALISTAS'),
  ('area', 'STOCK SISTEMAS'),
  ('area', 'CONEXXION'),
  ('area', 'SURCO'),
  ('area', 'MEGA PLAZA'),
  ('area', 'IZAGUIRRE'),
  ('marca', 'ZTE'),
  ('marca', 'Apple'),
  ('marca', 'Huawei'),
  ('marca', 'LG'),
  ('modelo', 'A54'),
  ('modelo', 'Galaxy A12'),
  ('modelo', 'Galaxy A10s'),
  ('modelo', 'Galaxy A04'),
  ('modelo', 'Galaxy J2'),
  ('modelo', 'Galaxy J7'),
  ('modelo', 'iPhone 13'),
  ('modelo', 'iPhone 15 Pro'),
  ('modelo', 'iPhone 17 Pro');

-- Codigos de pais para el numero de linea. Peru primero (el operador es
-- de Peru); el resto son de referencia y se pueden agregar mas a futuro
-- desde Configuracion > Catalogos.
INSERT IGNORE INTO phone_country_codes (country_name, calling_code, mobile_length) VALUES
  ('Perú', '51', 9),
  ('Chile', '56', 9),
  ('Colombia', '57', 10),
  ('Ecuador', '593', 9),
  ('Bolivia', '591', 8),
  ('Argentina', '54', 10),
  ('México', '52', 10),
  ('España', '34', 9),
  ('Estados Unidos', '1', 10),
  ('Brasil', '55', 11);

-- ---------------------------------------------------------------------
-- Sesiones de inicio de sesion (src/services/sessionStore.js). Guardadas
-- aqui sobreviven a un reinicio o despliegue de la aplicacion. Cada fila
-- vence con su cookie; las vencidas se borran solas.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  sid VARCHAR(128) NOT NULL PRIMARY KEY,
  expires DATETIME NOT NULL,
  data MEDIUMTEXT NOT NULL,
  INDEX idx_sessions_expires (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Modelos de celular, cada uno ligado a su marca (las marcas estan en
-- catalog_items, tipo "marca"). El formulario del celular ofrece solo los
-- modelos de la marca elegida. Ver src/services/mobileModelService.js.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mobile_models (
  id INT AUTO_INCREMENT PRIMARY KEY,
  brand VARCHAR(100) NOT NULL,
  model VARCHAR(20) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_mobile_model_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_mobile_model (brand, model),
  INDEX idx_mobile_model_model (model)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Widgets que cada usuario arma en el Tablero de celulares y chips
-- (agrupar por un campo, medir, filtrar, tipo de grafico).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  title VARCHAR(80) NOT NULL,
  config TEXT NOT NULL,                         -- JSON validado por src/services/dashboardService.js (nunca SQL)
  shared TINYINT(1) NOT NULL DEFAULT 0,         -- 1 = lo ven todos; 0 = solo quien lo creo
  position INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_dashboard_widget_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_dashboard_widget_user (user_id, shared)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Configuracion unica de IA, compartida con DevOps Sidecar: proveedores
-- locales (Ollama) y en la nube (Gemini, Claude, compatibles con OpenAI).
-- Que proveedor usa cada funcion va en `settings` (claves ai_uso_*); el
-- proveedor inicial lo agrega la migracion 0025. Ver src/services/aiService.js.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_providers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  label VARCHAR(80) NOT NULL,
  kind VARCHAR(20) NOT NULL,                    -- ollama | gemini | anthropic | openai
  location VARCHAR(10) NOT NULL DEFAULT 'nube', -- local (los datos no salen de la empresa) | nube
  base_url VARCHAR(255) NULL,                   -- vacio = la direccion publica del proveedor
  model VARCHAR(150) NOT NULL,
  api_key TEXT NULL,                            -- cifrada (enc:v1:, ver cryptoService.js)
  supports_tools TINYINT(1) NOT NULL DEFAULT 0, -- llamada a herramientas nativa
  supports_vision TINYINT(1) NOT NULL DEFAULT 0,-- lee imagenes (y PDF en Gemini/Claude)
  supports_web TINYINT(1) NOT NULL DEFAULT 0,   -- busqueda en internet integrada (Gemini)
  context_tokens INT NULL,                      -- Ollama: num_ctx (vacio = el del servidor)
  timeout_seconds INT NOT NULL DEFAULT 120,
  active TINYINT(1) NOT NULL DEFAULT 1,
  last_test_at DATETIME NULL,
  last_test_ok TINYINT(1) NULL,
  last_test_message VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_ai_provider_label (label),
  INDEX idx_ai_provider_active (active, location)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Copias locales de fuentes externas para el asistente (GLPI y los
-- repositorios de DevOps Sidecar): se consultan con indices en vez de
-- descargarlas en cada pregunta. Las renueva src/services/externalSyncService.js
-- (tarea cada 30 min y, si estan viejas, al consultarlas).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS glpi_assets (
  asset_type VARCHAR(20) NOT NULL,              -- computadoras | monitores | impresoras
  glpi_id INT NOT NULL,
  name VARCHAR(255) NULL,
  state VARCHAR(100) NULL,
  type VARCHAR(100) NULL,
  manufacturer VARCHAR(150) NULL,
  model VARCHAR(150) NULL,
  serial VARCHAR(150) NULL,
  otherserial VARCHAR(150) NULL,
  location VARCHAR(255) NULL,
  user_name VARCHAR(150) NULL,
  entity VARCHAR(255) NULL,
  date_mod VARCHAR(30) NULL,
  os VARCHAR(150) NULL,
  os_version VARCHAR(100) NULL,
  processor VARCHAR(255) NULL,
  memory_type VARCHAR(100) NULL,
  memory VARCHAR(60) NULL,
  ip VARCHAR(255) NULL,
  PRIMARY KEY (asset_type, glpi_id),
  INDEX idx_glpi_asset_state (asset_type, state),
  INDEX idx_glpi_asset_location (asset_type, location),
  INDEX idx_glpi_asset_entity (asset_type, entity),
  INDEX idx_glpi_asset_model (asset_type, manufacturer, model),
  INDEX idx_glpi_asset_serial (serial)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Repositorios de DevOps Sidecar copiados aqui (misma razon).
CREATE TABLE IF NOT EXISTS devops_repos (
  id INT NOT NULL PRIMARY KEY,                  -- id del repositorio en el sidecar
  name VARCHAR(200) NOT NULL,
  github_url VARCHAR(500) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sync_interval_minutes INT NULL,
  last_synced_at VARCHAR(30) NULL,
  last_sync_status VARCHAR(100) NULL,
  last_audit VARCHAR(120) NULL,
  INDEX idx_devops_repo_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cuando se copio cada fuente externa por ultima vez, y si fallo.
CREATE TABLE IF NOT EXISTS external_sync_state (
  source VARCHAR(40) NOT NULL PRIMARY KEY,      -- glpi_computadoras, glpi_monitores, glpi_impresoras, devops_repos
  synced_at DATETIME NULL,
  row_count INT NULL,
  last_error VARCHAR(500) NULL,
  last_attempt_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Solicitudes (celulares, Microsoft 365, Clinic), usuarios de Clinic y
-- cuentas de Microsoft 365 (migracion 0027).
-- ---------------------------------------------------------------------
-- Solicitudes: quien pide algo para otra persona (un jefe o gerente pide
-- un celular, una cuenta de Microsoft 365 o un usuario de Clinic). Una
-- sola tabla para todos los modulos: asi se ve todo lo que pidio alguien.
-- El solicitante se guarda como foto (nombre, cargo, area al momento de
-- pedir) y, si esta en el directorio, vinculado al empleado.
CREATE TABLE IF NOT EXISTS service_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  module VARCHAR(20) NOT NULL,                  -- celular | m365 | clinic
  request_type VARCHAR(30) NOT NULL,            -- asignacion | alta | baja | licencia | bloqueo | renombre | ...
  status VARCHAR(20) NOT NULL DEFAULT 'pendiente', -- pendiente | aprobada | en_proceso | completada | rechazada | cancelada
  entity_id INT NULL,                           -- celular, cuenta M365 o usuario Clinic al que se refiere
  requested_by_employee_id INT NULL,
  requested_by_name VARCHAR(150) NOT NULL,
  requested_by_cargo VARCHAR(150) NULL,
  requested_by_area VARCHAR(100) NULL,
  request_date DATE NOT NULL,
  request_ref VARCHAR(80) NULL,                 -- ticket, correo o memo de la solicitud
  beneficiary_name VARCHAR(150) NULL,           -- para quien se pide
  details_json TEXT NULL,                       -- datos propios del tipo (cargo, licencias, correo propuesto...)
  decided_by INT NULL,
  decided_at DATETIME NULL,
  completed_at DATETIME NULL,
  notes TEXT NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_request_requester FOREIGN KEY (requested_by_employee_id) REFERENCES employees(id) ON DELETE SET NULL,
  CONSTRAINT fk_request_decided_by FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_request_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_request_entity (module, entity_id),
  INDEX idx_request_status (status, module),
  INDEX idx_request_date (request_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Pasos de una solicitud (checklist): cada uno con quien lo hizo, cuando y
-- su evidencia (ej. ruta del PST, correo nuevo, a quien se dio acceso).
CREATE TABLE IF NOT EXISTS service_request_tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  request_id INT NOT NULL,
  seq INT NOT NULL,
  task_key VARCHAR(40) NOT NULL,
  label VARCHAR(255) NOT NULL,
  required TINYINT(1) NOT NULL DEFAULT 1,
  evidence_label VARCHAR(120) NULL,             -- que evidencia pide el paso (vacio = ninguna)
  done_by INT NULL,
  done_at DATETIME NULL,
  evidence VARCHAR(500) NULL,
  CONSTRAINT fk_task_request FOREIGN KEY (request_id) REFERENCES service_requests(id) ON DELETE CASCADE,
  CONSTRAINT fk_task_done_by FOREIGN KEY (done_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_task_request_key (request_id, task_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Celulares: la asignacion guarda que solicitud la origino.
ALTER TABLE mobile_device_assignments ADD COLUMN IF NOT EXISTS request_id INT NULL AFTER observacion;
SET @fk := (SELECT COUNT(*) FROM information_schema.table_constraints
            WHERE table_schema = DATABASE() AND table_name = 'mobile_device_assignments' AND constraint_name = 'fk_assignment_request');
SET @sql := IF(@fk = 0, 'ALTER TABLE mobile_device_assignments ADD CONSTRAINT fk_assignment_request FOREIGN KEY (request_id) REFERENCES service_requests(id) ON DELETE SET NULL', 'SELECT 1');
PREPARE st FROM @sql;
EXECUTE st;
DEALLOCATE PREPARE st;

-- Usuarios de la aplicacion Clinic. Perfiles y sedes de Clinic tienen tabla
-- propia (con su Id de Clinic, para importar el listado tal cual); la sede
-- de Clinic apunta a la sede del catalogo general y el perfil sugiere el
-- area de sus usuarios. Todo por clave foranea: un perfil, una sede o un
-- area en uso no se puede borrar (se desactiva).
CREATE TABLE IF NOT EXISTS clinic_sedes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  clinic_id INT NULL,                           -- IdSede en Clinic
  name VARCHAR(100) NOT NULL,
  address VARCHAR(255) NULL,
  opens_at TIME NULL,
  closes_at TIME NULL,
  sede_item_id INT NULL,                        -- la misma sede en el catalogo general (catalog_items 'sede')
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_clinic_sede_item FOREIGN KEY (sede_item_id) REFERENCES catalog_items(id),
  UNIQUE KEY uniq_clinic_sede_clinic_id (clinic_id),
  UNIQUE KEY uniq_clinic_sede_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS clinic_profiles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  clinic_id INT NULL,                           -- IdPerfil en Clinic
  name VARCHAR(100) NOT NULL,
  area_item_id INT NULL,                        -- area que se asume para sus usuarios (catalog_items 'area')
  description VARCHAR(255) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_clinic_profile_area FOREIGN KEY (area_item_id) REFERENCES catalog_items(id),
  UNIQUE KEY uniq_clinic_profile_clinic_id (clinic_id),
  UNIQUE KEY uniq_clinic_profile_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cada importacion del listado de Clinic: archivo, conteos, errores y avisos.
CREATE TABLE IF NOT EXISTS clinic_imports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  file_name VARCHAR(255) NOT NULL,
  rows_total INT NOT NULL DEFAULT 0,
  created_count INT NOT NULL DEFAULT 0,
  updated_count INT NOT NULL DEFAULT 0,
  unchanged_count INT NOT NULL DEFAULT 0,
  error_count INT NOT NULL DEFAULT 0,
  summary_json MEDIUMTEXT NULL,                 -- errores y avisos de la importacion
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_clinic_import_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_clinic_import_date (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- El usuario de acceso NO es unico: Clinic tiene dos usuarios iguales (uno con un
-- espacio invisible). La clave de Clinic es su IdUsuario (clinic_id). El
-- area propia es opcional: si falta, vale la del perfil.
CREATE TABLE IF NOT EXISTS clinic_users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  clinic_id INT NULL,                           -- IdUsuario en Clinic (vacio si se registro aqui antes de importar)
  full_name VARCHAR(150) NOT NULL,
  username VARCHAR(60) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'activo', -- activo | inactivo | baja
  profile_id INT NULL,
  sede_id INT NULL,
  area_item_id INT NULL,
  supervisor_id INT NULL,                       -- otro usuario de Clinic
  approved TINYINT NOT NULL DEFAULT 0,          -- "Aprobado" de Clinic: 0, 1 o 3
  dni VARCHAR(12) NULL,
  email VARCHAR(150) NULL,
  phone VARCHAR(30) NULL,
  employee_id INT NULL,
  request_id INT NULL,                          -- solicitud de alta
  notes TEXT NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_clinic_supervisor FOREIGN KEY (supervisor_id) REFERENCES clinic_users(id) ON DELETE SET NULL,
  CONSTRAINT fk_clinic_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL,
  CONSTRAINT fk_clinic_request FOREIGN KEY (request_id) REFERENCES service_requests(id) ON DELETE SET NULL,
  CONSTRAINT fk_clinic_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_clinic_user_profile FOREIGN KEY (profile_id) REFERENCES clinic_profiles(id),
  CONSTRAINT fk_clinic_user_sede FOREIGN KEY (sede_id) REFERENCES clinic_sedes(id),
  CONSTRAINT fk_clinic_user_area FOREIGN KEY (area_item_id) REFERENCES catalog_items(id),
  UNIQUE KEY uniq_clinic_user_clinic_id (clinic_id),
  INDEX idx_clinic_username (username),
  INDEX idx_clinic_status (status),
  INDEX idx_clinic_profile (profile_id, status),
  INDEX idx_clinic_sede (sede_id, status),
  INDEX idx_clinic_area (area_item_id),
  INDEX idx_clinic_dni (dni),
  INDEX idx_clinic_name (full_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lo que dice Clinic de cada usuario (1:1): ultima conexion, quien lo creo
-- y lo edito alla, y de que importacion vino.
CREATE TABLE IF NOT EXISTS clinic_user_origin (
  clinic_user_id INT PRIMARY KEY,
  clinic_status VARCHAR(10) NULL,               -- lo que muestra Clinic (activo | inactivo); una baja aqui puede seguir activa alla
  last_login_at DATETIME NULL,
  registered_by VARCHAR(150) NULL,
  registered_at DATETIME NULL,
  edited_by VARCHAR(150) NULL,
  edited_at DATETIME NULL,
  import_id INT NULL,
  imported_at DATETIME NULL,
  CONSTRAINT fk_clinic_origin_user FOREIGN KEY (clinic_user_id) REFERENCES clinic_users(id) ON DELETE CASCADE,
  CONSTRAINT fk_clinic_origin_import FOREIGN KEY (import_id) REFERENCES clinic_imports(id) ON DELETE SET NULL,
  INDEX idx_clinic_origin_status (clinic_status),
  INDEX idx_clinic_origin_login (last_login_at),
  INDEX idx_clinic_origin_registered (registered_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historial de cada usuario: alta, edicion, baja (fecha y motivo),
-- reactivacion y lo que cambio en cada importacion. No se edita.
CREATE TABLE IF NOT EXISTS clinic_user_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  clinic_user_id INT NOT NULL,
  event_type VARCHAR(20) NOT NULL,              -- alta | edicion | baja | reactivacion | importacion
  event_date DATE NOT NULL,
  detail VARCHAR(1000) NULL,
  reason VARCHAR(255) NULL,
  request_id INT NULL,
  import_id INT NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_clinic_event_user FOREIGN KEY (clinic_user_id) REFERENCES clinic_users(id) ON DELETE CASCADE,
  CONSTRAINT fk_clinic_event_request FOREIGN KEY (request_id) REFERENCES service_requests(id) ON DELETE SET NULL,
  CONSTRAINT fk_clinic_event_import FOREIGN KEY (import_id) REFERENCES clinic_imports(id) ON DELETE SET NULL,
  CONSTRAINT fk_clinic_event_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_clinic_event_lookup (clinic_user_id, event_type, event_date),
  INDEX idx_clinic_event_date (event_type, event_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cuentas de Microsoft 365. Lo que dice el tenant (via Microsoft Graph,
-- solo lectura) se guarda aparte (tenant_*) para mostrar diferencias con
-- lo registrado aqui. Una cuenta eliminada no se borra: queda la constancia.
CREATE TABLE IF NOT EXISTS m365_accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  upn VARCHAR(255) NOT NULL,                    -- correo / nombre de inicio de sesion
  display_name VARCHAR(150) NOT NULL,
  employee_id INT NULL,
  cargo VARCHAR(150) NULL,
  area VARCHAR(100) NULL,
  sede VARCHAR(100) NULL,
  account_type VARCHAR(12) NOT NULL DEFAULT 'usuario', -- usuario | compartido | recurso | servicio
  status VARCHAR(12) NOT NULL DEFAULT 'activa', -- activa | bloqueada | desactivada | eliminada
  licenses VARCHAR(500) NULL,                   -- licencias registradas (nombres, separados por coma)
  is_manager TINYINT(1) NOT NULL DEFAULT 0,     -- jefatura: al retirarse, PST y buzon compartido
  entra_id CHAR(36) NULL,                       -- id del usuario en Entra ID
  tenant_enabled TINYINT(1) NULL,
  tenant_licenses VARCHAR(500) NULL,
  tenant_seen_at DATETIME NULL,
  notes TEXT NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_m365_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL,
  CONSTRAINT fk_m365_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_m365_upn (upn),
  UNIQUE KEY uniq_m365_entra (entra_id),
  INDEX idx_m365_status (status, area)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Constancia de cada cambio de una cuenta: alta, licencias, bloqueo,
-- renombre del correo, reasignacion del buzon a otra persona, PST, baja,
-- eliminacion. No se edita ni se borra.
CREATE TABLE IF NOT EXISTS m365_account_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_id INT NOT NULL,
  event_type VARCHAR(20) NOT NULL,
  from_value VARCHAR(255) NULL,
  to_value VARCHAR(255) NULL,
  related_employee_id INT NULL,                 -- a quien se reasigno o dio acceso
  related_name VARCHAR(150) NULL,
  request_id INT NULL,
  user_id INT NULL,
  notes VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_m365_event_account FOREIGN KEY (account_id) REFERENCES m365_accounts(id) ON DELETE CASCADE,
  CONSTRAINT fk_m365_event_related FOREIGN KEY (related_employee_id) REFERENCES employees(id) ON DELETE SET NULL,
  CONSTRAINT fk_m365_event_request FOREIGN KEY (request_id) REFERENCES service_requests(id) ON DELETE SET NULL,
  CONSTRAINT fk_m365_event_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_m365_event_type (event_type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ultima conexion de cada cuenta de Microsoft 365 (1:1): inicio de sesion
-- (signInActivity, requiere Entra ID P1) y/o ultima actividad por servicio
-- del informe de uso (Reports.Read.All). Ver m365Service.readActivity.
CREATE TABLE IF NOT EXISTS m365_account_activity (
  account_id INT PRIMARY KEY,
  last_signin_at DATETIME NULL,                 -- ultimo inicio de sesion (interactivo o no)
  last_interactive_at DATETIME NULL,            -- ultimo inicio de sesion de la persona (interactivo)
  last_activity_date DATE NULL,                 -- la mas reciente de las de abajo
  exchange_date DATE NULL,                      -- correo
  teams_date DATE NULL,
  onedrive_date DATE NULL,
  sharepoint_date DATE NULL,
  report_date DATE NULL,                        -- fecha de corte del informe de uso
  source VARCHAR(20) NULL,                      -- inicio_sesion | informe | ambos
  read_at DATETIME NULL,
  CONSTRAINT fk_m365_activity_account FOREIGN KEY (account_id) REFERENCES m365_accounts(id) ON DELETE CASCADE,
  INDEX idx_m365_activity_signin (last_signin_at),
  INDEX idx_m365_activity_date (last_activity_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Licencias del tenant (Microsoft Graph /subscribedSkus): compradas y usadas.
CREATE TABLE IF NOT EXISTS m365_skus (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sku_id CHAR(36) NOT NULL,
  part_number VARCHAR(100) NOT NULL,            -- ej. O365_BUSINESS_PREMIUM
  friendly_name VARCHAR(150) NULL,              -- ej. Microsoft 365 Business Standard
  prepaid INT NOT NULL DEFAULT 0,
  consumed INT NOT NULL DEFAULT 0,
  synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_m365_sku (sku_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Directorio activo (fase 1: solo lectura). Foto del dominio que se renueva
-- en cada lectura por LDAPS (adService.sync): usuarios, grupos y sus
-- miembros, unidades organizativas, computadoras, registros DNS integrados,
-- papelera y el registro de cada lectura. Usuarios, grupos, OUs y equipos
-- se identifican por objectGUID; lo que deja de verse queda con removed_at
-- (no se borra: sirve de historial).
CREATE TABLE IF NOT EXISTS ad_users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  object_guid CHAR(36) NOT NULL,
  sam VARCHAR(64) NOT NULL,
  upn VARCHAR(255) NULL,
  display_name VARCHAR(255) NULL,
  mail VARCHAR(255) NULL,
  title VARCHAR(150) NULL,
  department VARCHAR(150) NULL,
  description VARCHAR(500) NULL,
  dn VARCHAR(700) NOT NULL,
  ou_dn VARCHAR(700) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  locked TINYINT(1) NOT NULL DEFAULT 0,
  pwd_never_expires TINYINT(1) NOT NULL DEFAULT 0,
  pwd_last_set DATETIME NULL,
  last_logon_ts DATETIME NULL,                  -- lastLogonTimestamp (replicado, hasta ~14 dias de desfase)
  last_logon DATETIME NULL,                     -- lastLogon mas reciente entre todos los DC consultados
  when_created DATETIME NULL,
  admin_count TINYINT(1) NOT NULL DEFAULT 0,
  privileged_groups VARCHAR(500) NULL,          -- grupos privilegiados (directos o anidados); vacio = no privilegiado
  employee_id INT NULL,                         -- empleado con el mismo DNI (atributo employeeID)
  seen_at DATETIME NULL,
  removed_at DATETIME NULL,
  CONSTRAINT fk_ad_user_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_ad_user_guid (object_guid),
  INDEX idx_ad_user_sam (sam),
  INDEX idx_ad_user_upn (upn),
  INDEX idx_ad_user_state (removed_at, enabled),
  INDEX idx_ad_user_logon (last_logon_ts),
  INDEX idx_ad_user_ou (ou_dn(255))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_groups (
  id INT AUTO_INCREMENT PRIMARY KEY,
  object_guid CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  sam VARCHAR(255) NULL,
  sid VARCHAR(100) NULL,
  dn VARCHAR(700) NOT NULL,
  ou_dn VARCHAR(700) NULL,
  scope VARCHAR(12) NULL,                       -- global | local | universal
  kind VARCHAR(12) NULL,                        -- seguridad | distribucion
  description VARCHAR(500) NULL,
  member_count INT NOT NULL DEFAULT 0,
  privileged VARCHAR(60) NULL,                  -- clave del grupo privilegiado conocido (por SID), si lo es
  seen_at DATETIME NULL,
  removed_at DATETIME NULL,
  UNIQUE KEY uniq_ad_group_guid (object_guid),
  INDEX idx_ad_group_name (name),
  INDEX idx_ad_group_state (removed_at, privileged)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Miembros directos de cada grupo (se reemplazan en cada lectura).
CREATE TABLE IF NOT EXISTS ad_group_members (
  id INT AUTO_INCREMENT PRIMARY KEY,
  group_id INT NOT NULL,
  member_hash CHAR(40) NOT NULL,                -- SHA-1 del DN del miembro (unico por grupo)
  member_dn VARCHAR(700) NOT NULL,
  member_kind VARCHAR(10) NOT NULL,             -- usuario | grupo | equipo | otro
  user_id INT NULL,
  CONSTRAINT fk_ad_member_group FOREIGN KEY (group_id) REFERENCES ad_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_ad_member_user FOREIGN KEY (user_id) REFERENCES ad_users(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_ad_member (group_id, member_hash),
  INDEX idx_ad_member_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_ous (
  id INT AUTO_INCREMENT PRIMARY KEY,
  object_guid CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  dn VARCHAR(700) NOT NULL,
  parent_dn VARCHAR(700) NULL,
  kind VARCHAR(12) NOT NULL DEFAULT 'ou',       -- ou | contenedor
  description VARCHAR(500) NULL,
  users_count INT NOT NULL DEFAULT 0,
  computers_count INT NOT NULL DEFAULT 0,
  groups_count INT NOT NULL DEFAULT 0,
  seen_at DATETIME NULL,
  removed_at DATETIME NULL,
  UNIQUE KEY uniq_ad_ou_guid (object_guid),
  INDEX idx_ad_ou_parent (parent_dn(255))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_computers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  object_guid CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  dns_host VARCHAR(255) NULL,
  os VARCHAR(255) NULL,
  os_version VARCHAR(100) NULL,
  description VARCHAR(500) NULL,
  dn VARCHAR(700) NOT NULL,
  ou_dn VARCHAR(700) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  is_dc TINYINT(1) NOT NULL DEFAULT 0,
  last_logon_ts DATETIME NULL,
  last_logon DATETIME NULL,
  pwd_last_set DATETIME NULL,
  when_created DATETIME NULL,
  ips VARCHAR(255) NULL,                        -- de los registros DNS del equipo
  seen_at DATETIME NULL,
  removed_at DATETIME NULL,
  UNIQUE KEY uniq_ad_computer_guid (object_guid),
  INDEX idx_ad_computer_name (name),
  INDEX idx_ad_computer_state (removed_at, enabled),
  INDEX idx_ad_computer_logon (last_logon_ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Registros DNS de las zonas integradas en AD (se reemplazan en cada lectura).
CREATE TABLE IF NOT EXISTS ad_dns_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  zone VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  rtype VARCHAR(10) NOT NULL,
  data VARCHAR(500) NULL,
  ttl INT NULL,
  record_ts DATETIME NULL,                      -- registro dinamico: ultima actualizacion; NULL = estatico
  computer_id INT NULL,
  CONSTRAINT fk_ad_dns_computer FOREIGN KEY (computer_id) REFERENCES ad_computers(id) ON DELETE SET NULL,
  INDEX idx_ad_dns_name (zone, name),
  INDEX idx_ad_dns_computer (computer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Papelera de AD (CN=Deleted Objects), se reemplaza en cada lectura.
CREATE TABLE IF NOT EXISTS ad_deleted (
  id INT AUTO_INCREMENT PRIMARY KEY,
  object_guid CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  object_class VARCHAR(30) NULL,
  sam VARCHAR(255) NULL,
  last_known_parent VARCHAR(700) NULL,
  deleted_at DATETIME NULL,
  UNIQUE KEY uniq_ad_deleted_guid (object_guid),
  INDEX idx_ad_deleted_date (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cada lectura del dominio: cuando, contra que DC, resultado y resumen
-- (nivel funcional, papelera, politica de contrasenas, DC, certificado).
CREATE TABLE IF NOT EXISTS ad_sync_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'en_curso', -- en_curso | ok | con_avisos | error
  dc VARCHAR(255) NULL,
  summary_json MEDIUMTEXT NULL,
  error VARCHAR(1000) NULL,
  created_by INT NULL,
  CONSTRAINT fk_ad_sync_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_ad_sync_date (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
