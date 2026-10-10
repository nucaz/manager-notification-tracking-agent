-- Red > Omada: acciones sobre clientes (bloquear, desbloquear, reconectar).
-- Apagadas por defecto: cada controlador las habilita aparte, y su aplicacion
-- Open API necesita un rol con permiso de modificar clientes.
ALTER TABLE omada_controllers ADD COLUMN IF NOT EXISTS allow_actions TINYINT(1) NOT NULL DEFAULT 0 AFTER enabled;
ALTER TABLE omada_clients ADD COLUMN IF NOT EXISTS blocked TINYINT(1) NOT NULL DEFAULT 0 AFTER active;
