-- =====================================================================
-- Esquema de base de datos: Licencias, Dominios, Contratos ISP y Red
-- Aplicación complementaria a GLPI (integración vía API REST)
-- =====================================================================

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
-- Adjuntos: contratos, adendas, facturas — vinculados de forma polimórfica
-- a licencias, dominios, contratos ISP, servidores o certificados
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entity_type ENUM('license','domain','isp_contract','server','certificate') NOT NULL,
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
  ('gemini_model', 'gemini-2.5-flash')
ON DUPLICATE KEY UPDATE `key`=`key`;
