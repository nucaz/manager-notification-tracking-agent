// Claves de la tabla `settings` que son credenciales/secretos: se cifran
// en la base de datos (ver cryptoService/settingsService) y en la UI
// nunca se vuelve a mostrar el valor real, solo un placeholder si ya
// estan configuradas (ver views/settings/index.ejs) - dejarlas en blanco
// al guardar mantiene el valor existente en vez de borrarlo.
// Unica fuente de verdad: antes vivia duplicada solo en routes/settings.js.
const SECRET_KEYS = new Set([
  'glpi_app_token', 'glpi_user_token',
  'smtp_pass',
  'gemini_api_key',
  'whatsapp_access_token', 'whatsapp_app_secret',
  'telegram_bot_token',
  'devops_sidecar_password',
]);

module.exports = { SECRET_KEYS };
