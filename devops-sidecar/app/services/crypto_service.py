"""Cifra/descifra los valores "secretos" guardados en app_settings (API
keys de Gemini/Claude) con Fernet (AES-128-CBC + HMAC, autenticado), para
que un dump de la base de datos SQLite no los exponga en texto plano. La
clave sale de CREDENTIALS_ENC_KEY en .env (formato urlsafe-base64 de 32
bytes - el mismo que genera Fernet.generate_key(), o
`openssl rand 32 | base64 | tr '+/' '-_'`).

Si esa variable no esta configurada, encrypt()/decrypt() se comportan
como una funcion identidad (devuelven el valor tal cual) en vez de
reventar - misma logica que el lado Node (ver
glpi-licencias-app/src/services/cryptoService.js) - para que una
instancia ya en marcha siga funcionando igual hasta que se le agregue la
clave nueva y se reinicie el contenedor.
"""
from cryptography.fernet import Fernet, InvalidToken

from ..config import settings

PREFIX = "enc:v1:"


def _get_fernet() -> Fernet | None:
    key = settings.credentials_enc_key
    if not key:
        return None
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError):
        return None


def is_encrypted(value) -> bool:
    return isinstance(value, str) and value.startswith(PREFIX)


def encrypt(text):
    fernet = _get_fernet()
    if not fernet or not text:
        return text
    token = fernet.encrypt(text.encode()).decode()
    return f"{PREFIX}{token}"


def decrypt(value):
    if not is_encrypted(value):
        return value  # legado en texto plano, o vacio
    fernet = _get_fernet()
    if not fernet:
        return value  # sin clave configurada: no se puede descifrar
    token = value[len(PREFIX):]
    try:
        return fernet.decrypt(token.encode()).decode()
    except (InvalidToken, ValueError):
        # Clave rotada/incorrecta o dato corrupto - mejor devolver el
        # valor cifrado que reventar la app por un solo campo ilegible.
        return value
