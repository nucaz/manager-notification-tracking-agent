-- Ver sql/schema.sql para la explicacion completa.

-- El asistente "Preguntar a la IA" filtra, agrupa y ordena en MariaDB (ver
-- src/services/assistantData.js). Indices para lo que se consulta seguido;
-- los compuestos reemplazan a los simples que quedan como su prefijo.

-- Celulares: "estado" y luego sede/area (stock por sede); orden del listado.
ALTER TABLE mobile_devices
  ADD INDEX IF NOT EXISTS idx_mobile_device_status_sede (status, sede, area),
  ADD INDEX IF NOT EXISTS idx_mobile_device_lugar (sede, area, asset_code);
ALTER TABLE mobile_devices DROP INDEX IF EXISTS idx_mobile_device_status;
ALTER TABLE mobile_devices DROP INDEX IF EXISTS idx_mobile_device_sede;

-- Chips: estado y operadora juntos ("activos de Entel"); con device_id el
-- indice cubre el conteo con sus JOIN (sin leer cada fila).
ALTER TABLE mobile_lines ADD INDEX IF NOT EXISTS idx_mobile_line_estado_operadora (estado, operadora, device_id);
ALTER TABLE mobile_lines DROP INDEX IF EXISTS idx_mobile_line_estado;

-- Historial de asignaciones: vigentes y por fecha.
ALTER TABLE mobile_device_assignments
  ADD INDEX IF NOT EXISTS idx_assignment_vigente (returned_date, assigned_date),
  ADD INDEX IF NOT EXISTS idx_assignment_desde (assigned_date, device_id);

-- Incidentes: tipo y fecha ("decomisos de este ano").
ALTER TABLE mobile_device_incidents ADD INDEX IF NOT EXISTS idx_mobile_incident_tipo_fecha (tipo, fecha);
ALTER TABLE mobile_device_incidents DROP INDEX IF EXISTS idx_mobile_incident_tipo;

-- Auditoria: accion y fecha.
ALTER TABLE audit_log ADD INDEX IF NOT EXISTS idx_audit_log_action_fecha (action, created_at);
ALTER TABLE audit_log DROP INDEX IF EXISTS idx_audit_log_action;

-- Adjuntos: los mas recientes.
ALTER TABLE attachments ADD INDEX IF NOT EXISTS idx_attachment_subido (uploaded_at);

-- Inventario de GLPI copiado aqui (lo renueva src/services/externalSyncService.js):
-- el asistente consulta esta tabla en vez de descargar todo GLPI en cada pregunta.
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
