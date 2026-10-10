-- Red > Omada: conexion por la nube con una aplicacion de la cuenta TP-Link
-- (Account-Level Open API). Una sola aplicacion ve varios controladores
-- (organizaciones); cada sitio guarda a cual pertenece y por donde se alcanza.
ALTER TABLE omada_controllers ADD COLUMN IF NOT EXISTS mode VARCHAR(10) NOT NULL DEFAULT 'local' AFTER allow_actions;
ALTER TABLE omada_sites ADD COLUMN IF NOT EXISTS org_name VARCHAR(100) NULL AFTER region;
ALTER TABLE omada_sites ADD COLUMN IF NOT EXISTS api_root VARCHAR(400) NULL AFTER org_name;
