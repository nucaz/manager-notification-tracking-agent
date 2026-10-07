-- Ver sql/schema.sql para la explicacion completa.
--
-- Rol superadmin: todo el control de la aplicacion (credenciales de
-- conexion, usuarios, permisos, respaldos, mantenimiento, DevOps). El rol
-- admin gestiona los modulos pero no lo critico. Los administradores que
-- ya existian pasan a superadmin para que nadie pierda acceso: despues el
-- superadmin baja a administrador a quien corresponda.
ALTER TABLE users MODIFY role ENUM('superadmin','admin','editor','lector') NOT NULL DEFAULT 'lector';
SET @ya := (SELECT COUNT(*) FROM users WHERE role = 'superadmin');
UPDATE users SET role = 'superadmin' WHERE role = 'admin' AND @ya = 0;
