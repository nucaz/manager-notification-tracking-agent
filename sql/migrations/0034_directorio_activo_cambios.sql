-- Directorio activo, fase 2: cambios en el dominio con aprobacion.
-- Un superadministrador ejecuta directo; los demas usuarios con el modulo
-- piden el cambio (queda pendiente hasta que un superadministrador lo
-- aprueba) o lo ejecutan solos mientras tengan un permiso temporal vigente.
-- Ver src/services/adWriteService.js y src/services/adChangeService.js.

-- Permiso temporal: el superadministrador habilita a un usuario a ejecutar
-- ciertos tipos de cambio (operations: grupos de operaciones separados por
-- coma) hasta expires_at, sin pasar por la aprobacion.
CREATE TABLE IF NOT EXISTS ad_grants (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  operations VARCHAR(255) NOT NULL,
  note VARCHAR(500) NULL,
  granted_by INT NULL,
  granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  revoked_by INT NULL,
  uses_count INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_ad_grant_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ad_grant_by FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_ad_grant_revoked_by FOREIGN KEY (revoked_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_ad_grant_user_exp (user_id, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cada cambio pedido o ejecutado. El objeto se identifica por su GUID (no
-- cambia al moverlo o renombrarlo); al ejecutar se vuelve a leer del
-- dominio y se vuelven a comprobar las protecciones.
-- secret_enc: contrasena generada, cifrada, solo para mostrarla UNA vez a
-- quien pidio el cambio; se borra al verla o a las 24 horas.
CREATE TABLE IF NOT EXISTS ad_change_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  operation VARCHAR(40) NOT NULL,
  target_kind VARCHAR(20) NOT NULL,
  target_guid CHAR(36) NULL,
  target_dn VARCHAR(700) NULL,
  target_label VARCHAR(255) NOT NULL,
  params_json TEXT NULL,
  reason VARCHAR(500) NULL,
  status ENUM('pendiente','ejecutada','rechazada','fallida','cancelada','vencida') NOT NULL DEFAULT 'pendiente',
  via ENUM('directa','aprobacion','permiso_temporal') NOT NULL DEFAULT 'aprobacion',
  batch_id CHAR(12) NULL,
  requested_by INT NULL,
  requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by INT NULL,
  decided_at DATETIME NULL,
  decision_note VARCHAR(500) NULL,
  grant_id INT NULL,
  executed_at DATETIME NULL,
  result VARCHAR(1000) NULL,
  secret_enc VARCHAR(500) NULL,
  secret_until DATETIME NULL,
  expires_at DATETIME NOT NULL,
  CONSTRAINT fk_ad_req_requested_by FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_ad_req_decided_by FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_ad_req_grant FOREIGN KEY (grant_id) REFERENCES ad_grants(id) ON DELETE SET NULL,
  INDEX idx_ad_req_status_date (status, requested_at),
  INDEX idx_ad_req_requested_by (requested_by, requested_at),
  INDEX idx_ad_req_decided_by (decided_by),
  INDEX idx_ad_req_grant (grant_id),
  INDEX idx_ad_req_target (target_guid),
  INDEX idx_ad_req_batch (batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
