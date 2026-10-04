-- Ver sql/schema.sql para la explicacion completa.

-- Configuracion unica de IA (aplicacion principal y DevOps Sidecar):
-- proveedores locales (Ollama) y en la nube (Gemini, Claude, compatibles
-- con OpenAI). Que proveedor usa cada funcion se guarda en `settings`
-- (claves ai_uso_*). Ver src/services/aiService.js.
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

-- Servidor Ollama de la empresa (gemma4). Se cambia de modelo desde
-- Configuracion > Inteligencia artificial, sin tocar codigo.
INSERT INTO ai_providers (label, kind, location, base_url, model, supports_tools, supports_vision, context_tokens, timeout_seconds)
SELECT 'Servidor local (Ollama)', 'ollama', 'local', 'http://172.16.1.22:11434', 'gemma4:26b', 1, 1, 16384, 300
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM ai_providers WHERE kind = 'ollama');

-- Gemini con la API key que ya estaba en Configuracion (se copia cifrada
-- tal cual: misma clave CREDENTIALS_ENC_KEY). Un nombre de modelo que no
-- es un identificador valido (ej. "Gemini 3 Flash-Lite") se reemplaza.
INSERT INTO ai_providers (label, kind, location, model, api_key, supports_tools, supports_vision, supports_web, timeout_seconds)
SELECT 'Google Gemini', 'gemini', 'nube',
       IF(m.`value` REGEXP '^[a-z0-9][a-z0-9.-]*$', m.`value`, 'gemini-2.5-flash'), k.`value`, 1, 1, 1, 90
FROM settings k LEFT JOIN settings m ON m.`key` = 'gemini_model'
WHERE k.`key` = 'gemini_api_key' AND k.`value` <> ''
  AND NOT EXISTS (SELECT 1 FROM ai_providers WHERE kind = 'gemini');

-- Que proveedor usa cada funcion: el local por defecto.
INSERT IGNORE INTO settings (`key`, `value`)
SELECT u.k, (SELECT id FROM ai_providers WHERE kind = 'ollama' ORDER BY id LIMIT 1)
FROM (SELECT 'ai_uso_asistente' AS k UNION ALL SELECT 'ai_uso_chatbot' UNION ALL SELECT 'ai_uso_facturas'
      UNION ALL SELECT 'ai_uso_sidecar_auditoria' UNION ALL SELECT 'ai_uso_sidecar_textos') u;
INSERT IGNORE INTO settings (`key`, `value`) VALUES ('ai_elegir_por_pregunta', 'true');
