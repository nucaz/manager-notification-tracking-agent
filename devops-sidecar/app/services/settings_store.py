"""Aplica sobre el singleton `settings` (config.py) los valores que el
usuario haya guardado desde el dashboard (tabla app_settings). Los campos
de .env siguen sirviendo como default de arranque - esto solo los
sobreescribe en memoria cuando hay un valor guardado, sin reiniciar el
contenedor."""
from sqlalchemy.orm import Session

from .. import models
from ..config import settings
from . import crypto_service

OVERRIDABLE_KEYS = [
    "ai_provider",
    "gemini_api_key",
    "gemini_model",
    "anthropic_api_key",
    "anthropic_model",
    "ollama_base_url",
    "ollama_model",
]

# Cuales de las anteriores son credenciales - se cifran en BD (ver
# crypto_service.py). Las demas (proveedor elegido, nombres de modelo,
# URL de Ollama) no son secretas, se guardan tal cual.
SECRET_KEYS = {"gemini_api_key", "anthropic_api_key"}


def _persist(db: Session, values: dict) -> None:
    for key, value in values.items():
        if key not in OVERRIDABLE_KEYS or not value:
            continue
        stored = crypto_service.encrypt(value) if key in SECRET_KEYS else value
        row = db.get(models.AppSetting, key)
        if row:
            row.value = stored
        else:
            db.add(models.AppSetting(key=key, value=stored))
    db.commit()


def load_overrides_into_settings(db: Session) -> None:
    rows = db.query(models.AppSetting).filter(models.AppSetting.key.in_(OVERRIDABLE_KEYS)).all()
    legacy_plaintext: dict[str, str] = {}
    for row in rows:
        if not row.value:
            continue
        value = row.value
        if row.key in SECRET_KEYS:
            if crypto_service.is_encrypted(value):
                value = crypto_service.decrypt(value)
            else:
                # Fila de antes de agregar cifrado (o instancia sin
                # CREDENTIALS_ENC_KEY todavia) - se usa tal cual y se
                # re-guarda cifrada mas abajo, sin que el usuario tenga
                # que volver a escribirla.
                legacy_plaintext[row.key] = value
        setattr(settings, row.key, value)
    if legacy_plaintext:
        _persist(db, legacy_plaintext)


def save_overrides(db: Session, values: dict) -> None:
    _persist(db, values)
    load_overrides_into_settings(db)
