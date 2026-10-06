-- Ver sql/schema.sql para la explicacion completa.

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

-- Inventario de usuarios de la aplicacion Clinic (registro propio, con
-- importacion del listado de Clinic). Perfil, sede y area salen de los
-- catalogos (catalog_items: perfil_clinic, sede, area).
CREATE TABLE IF NOT EXISTS clinic_users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(150) NOT NULL,
  username VARCHAR(60) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'activo', -- activo | inactivo | baja
  perfil VARCHAR(100) NULL,
  sede VARCHAR(100) NULL,
  area VARCHAR(100) NULL,
  supervisor_id INT NULL,                       -- otro usuario de Clinic
  approved TINYINT(1) NOT NULL DEFAULT 0,
  clinic_registered_by VARCHAR(150) NULL,       -- "Registrado por" en Clinic (texto del listado)
  clinic_registered_at DATETIME NULL,
  employee_id INT NULL,
  request_id INT NULL,                          -- solicitud de alta
  baja_date DATE NULL,
  baja_reason VARCHAR(255) NULL,
  notes TEXT NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_clinic_supervisor FOREIGN KEY (supervisor_id) REFERENCES clinic_users(id) ON DELETE SET NULL,
  CONSTRAINT fk_clinic_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL,
  CONSTRAINT fk_clinic_request FOREIGN KEY (request_id) REFERENCES service_requests(id) ON DELETE SET NULL,
  CONSTRAINT fk_clinic_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_clinic_username (username),
  INDEX idx_clinic_status (status, sede),
  INDEX idx_clinic_name (full_name)
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
