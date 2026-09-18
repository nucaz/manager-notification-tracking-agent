"""Aplica sobre el singleton `settings` (config.py) los valores que el
usuario haya guardado desde el dashboard (tabla app_settings). Los campos
de .env siguen sirviendo como default de arranque - esto solo los
sobreescribe en memoria cuando hay un valor guardado, sin reiniciar el
contenedor."""
from sqlalchemy.orm import Session

from .. import models
from ..config import settings

OVERRIDABLE_KEYS = [
    "ai_provider",
    "gemini_api_key",
    "gemini_model",
    "anthropic_api_key",
    "anthropic_model",
    "ollama_base_url",
    "ollama_model",
]


def load_overrides_into_settings(db: Session) -> None:
    rows = db.query(models.AppSetting).filter(models.AppSetting.key.in_(OVERRIDABLE_KEYS)).all()
    for row in rows:
        if row.value:
            setattr(settings, row.key, row.value)


def save_overrides(db: Session, values: dict) -> None:
    for key, value in values.items():
        if key not in OVERRIDABLE_KEYS or not value:
            continue
        row = db.get(models.AppSetting, key)
        if row:
            row.value = value
        else:
            db.add(models.AppSetting(key=key, value=value))
    db.commit()
    load_overrides_into_settings(db)
