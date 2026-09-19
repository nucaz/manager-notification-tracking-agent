"""Configuracion via variables de entorno (.env). Ningun valor sensible
tiene un default real - los defaults son solo para que la app arranque
en desarrollo sin configurar nada."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- Rutas (montadas como volumenes en docker-compose.yml) ---
    repos_base_path: str = "/data/repos"
    backups_path: str = "/data/backups"
    reports_path: str = "/data/reports"
    database_path: str = "/data/db/sidecar.db"

    # --- Seguridad ---
    # Token que Coolify debe mandar (header X-Webhook-Token o ?token=)
    # para que el webhook lo acepte. Vacio = sin verificar (NO recomendado
    # fuera de pruebas locales).
    webhook_secret: str = ""
    # HTTP Basic Auth para el dashboard/API (todo menos el webhook).
    dashboard_user: str = "admin"
    dashboard_password: str = "cambia_esta_password"
    # Clave Fernet (urlsafe-base64 de 32 bytes) para cifrar en BD las
    # API keys de IA guardadas desde el dashboard (ver crypto_service.py).
    # Vacio = quedan en texto plano (compatibilidad hacia atras).
    credentials_enc_key: str = ""

    # --- Proveedor de IA para el motor de auditoria ---
    ai_provider: str = "gemini"  # "gemini" | "claude" | "ollama"
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-pro"
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-5"
    ollama_base_url: str = "http://host.docker.internal:11434"
    ollama_model: str = "llama3"

    # --- Programacion (hora del servidor, ver TZ en docker-compose.yml) ---
    audit_hour: int = 18
    audit_minute: int = 0
    weekly_backup_day_of_week: str = "sun"  # cron: mon,tue,wed,thu,fri,sat,sun
    weekly_backup_hour: int = 2
    backup_retention_days: int = 30

    # --- Auditoria: tope de tamano del diff mandado a la IA ---
    max_diff_chars: int = 60000


settings = Settings()
