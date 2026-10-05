"""Pases firmados entre la aplicacion principal y este modulo (acceso unico).

La aplicacion principal es la unica que autentica personas (usuario,
contrasena, captcha y 2FA). Para entrar aqui emite un pase de corta
duracion firmado con un secreto que solo conocen las dos aplicaciones
(SSO_SHARED_SECRET); este modulo lo verifica y abre su propia sesion.

Formato: v1.<carga en base64url (JSON)>.<HMAC-SHA256 en base64url>
La carga lleva siempre `aud` (para que sirve el pase) y `exp` (vence):
  - sidecar-sso      pase de entrada de un usuario; de un solo uso
  - sidecar-session  la sesion de este modulo (cookie)
  - sidecar-origin   de que aplicacion principal vino (para volver a ella)
  - sidecar-api      llamadas de la aplicacion principal a esta API
  - app-backup       respaldo completo de la aplicacion principal (generar / restaurar)
  - app-ai           este modulo pide a la aplicacion principal que genere
                     con la IA configurada alla (configuracion unica)

El mismo formato lo implementa src/services/ssoService.js (Node): si se
cambia algo aqui, hay que cambiarlo alla.
"""
import base64
import hashlib
import hmac
import json
import threading
import time

from ..config import settings

SESSION_SECONDS = 8 * 60 * 60        # igual que la sesion de la aplicacion principal
ORIGIN_SECONDS = 30 * 24 * 60 * 60

_used_lock = threading.Lock()
_used_passes: dict[str, float] = {}  # jti -> vencimiento; pases de entrada ya usados


def enabled() -> bool:
    return bool(settings.sso_shared_secret)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _signature(body: str) -> str:
    key = settings.sso_shared_secret.encode()
    return _b64(hmac.new(key, f"v1.{body}".encode(), hashlib.sha256).digest())


def sign(payload: dict) -> str:
    body = _b64(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode())
    return f"v1.{body}.{_signature(body)}"


def verify(token: str | None, audience: str) -> dict | None:
    """Carga del pase si la firma es valida, no vencio y es para `audience`; si no, None."""
    if not enabled() or not token or token.count(".") != 2:
        return None
    version, body, signature = token.split(".")
    if version != "v1" or not hmac.compare_digest(signature, _signature(body)):
        return None
    try:
        payload = json.loads(_unb64(body))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("aud") != audience:
        return None
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)) or exp < time.time():
        return None
    return payload


def consume_pass(payload: dict) -> bool:
    """Un pase de entrada sirve una sola vez: True la primera, False si ya se uso."""
    jti = str(payload.get("jti") or "")
    if not jti:
        return False
    now = time.time()
    with _used_lock:
        for key in [k for k, exp in _used_passes.items() if exp < now]:
            del _used_passes[key]
        if jti in _used_passes:
            return False
        _used_passes[jti] = float(payload["exp"])
    return True


def session_token(payload: dict) -> str:
    return sign({
        "aud": "sidecar-session", "exp": int(time.time()) + SESSION_SECONDS,
        "sub": payload.get("sub"), "name": payload.get("name"), "role": payload.get("role"),
    })


def app_backup_pass() -> str:
    """Pase para pedir o restaurar el respaldo completo de la aplicacion principal."""
    return sign({"aud": "app-backup", "exp": int(time.time()) + 300, "sub": "devops-sidecar"})


def app_ai_pass() -> str:
    """Pase corto para pedir a la aplicacion principal que genere con su IA."""
    return sign({"aud": "app-ai", "exp": int(time.time()) + 60, "sub": "devops-sidecar"})


def origin_token(app_url: str) -> str:
    return sign({"aud": "sidecar-origin", "exp": int(time.time()) + ORIGIN_SECONDS, "app": app_url})
