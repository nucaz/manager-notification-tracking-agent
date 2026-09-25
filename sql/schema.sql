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
  role ENUM('admin','editor','lector') NOT NULL DEFAULT 'lector',
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
  area VARCHAR(100) NOT NULL,                   -- area/departamento (texto libre)
  sede VARCHAR(100),                            -- sede fisica (texto libre)
  status ENUM('en_stock','asignado','en_reparacion','de_baja') NOT NULL DEFAULT 'en_stock',
  notes VARCHAR(250),
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_mobile_device_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_mobile_device_area (area),
  INDEX idx_mobile_device_status (status),
  INDEX idx_mobile_device_phone_country (phone_country_code_id)
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
  notes TEXT,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_employee_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_employee_dni (dni)
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
  assigned_date DATE,
  returned_date DATE NULL,                      -- NULL = asignacion activa
  observacion TEXT,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_assignment_device FOREIGN KEY (device_id) REFERENCES mobile_devices(id) ON DELETE CASCADE,
  CONSTRAINT fk_assignment_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL,
  CONSTRAINT fk_assignment_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_assignment_device (device_id, returned_date)
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
-- terminal y refleja mobile_devices.status = 'de_baja'.
CREATE TABLE IF NOT EXISTS mobile_device_incidents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  device_id INT NOT NULL,
  tipo ENUM('reparacion','accidente','baja') NOT NULL,
  fecha DATE NOT NULL,
  descripcion TEXT,
  costo DECIMAL(10,2) NULL,
  fecha_resolucion DATE NULL,                   -- solo 'reparacion': cuando volvio a servicio
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_mobile_incident_device FOREIGN KEY (device_id) REFERENCES mobile_devices(id) ON DELETE CASCADE,
  CONSTRAINT fk_mobile_incident_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_mobile_incident_device (device_id),
  INDEX idx_mobile_incident_fecha (fecha),
  INDEX idx_mobile_incident_tipo (tipo)
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
  channel ENUM('whatsapp','telegram') NOT NULL,
  contact VARCHAR(32) NOT NULL,                 -- numero de WhatsApp o chat_id de Telegram
  user_id INT NULL,                             -- NULL si el contacto no estaba autorizado
  direction ENUM('entrante','saliente') NOT NULL,
  message_text TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_agent_log_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_agent_log_contact (channel, contact)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cada noche se "cierra" el dia anterior de agent_message_log: se
-- comprime (gzip) en una fila aca y se borran las filas crudas de arriba,
-- para no dejar crecer esa tabla sin limite (ver
-- src/jobs/archiveChatLogs.js). Un registro por (canal, contacto, dia).
CREATE TABLE IF NOT EXISTS agent_message_log_archive (
  id INT AUTO_INCREMENT PRIMARY KEY,
  channel ENUM('whatsapp','telegram') NOT NULL,
  contact VARCHAR(32) NOT NULL,
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
  INDEX idx_audit_log_action (action),
  INDEX idx_audit_log_created (created_at)
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
  INDEX idx_trusted_device_token (token_hash)
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
  INDEX idx_attachment_entity (entity_type, entity_id)
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
