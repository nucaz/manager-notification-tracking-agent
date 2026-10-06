-- Ver sql/schema.sql para la explicacion completa.
--
-- Ultima conexion de cada cuenta de Microsoft 365 (1:1), leida del tenant:
-- el inicio de sesion exacto (signInActivity: requiere AuditLog.Read.All y
-- Microsoft Entra ID P1) y/o la ultima actividad por servicio del informe
-- de uso de Microsoft 365 (Reports.Read.All, sin licencia premium; llega
-- con unos dos dias de retraso).
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
