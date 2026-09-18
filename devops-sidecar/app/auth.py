"""HTTP Basic Auth minima para el dashboard/API (no para el webhook de
Coolify, que usa su propio token - ver routers/webhooks.py). Este modulo
corre en red interna igual que el resto de la plataforma, pero maneja
datos sensibles (diffs de codigo, alertas de secretos), asi que no se
deja completamente sin proteccion."""
import secrets

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from .config import settings

security = HTTPBasic()


def require_dashboard_auth(credentials: HTTPBasicCredentials = Depends(security)) -> str:
    user_ok = secrets.compare_digest(credentials.username, settings.dashboard_user)
    pass_ok = secrets.compare_digest(credentials.password, settings.dashboard_password)
    if not (user_ok and pass_ok):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenciales invalidas.",
            headers={"WWW-Authenticate": "Basic"},
        )
    return credentials.username
