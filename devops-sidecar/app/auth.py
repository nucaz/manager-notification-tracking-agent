"""Autenticacion del dashboard/API (no del webhook de Coolify, que usa su
propio token - ver routers/webhooks.py).

Dos modos, segun haya o no un secreto compartido con la aplicacion
principal (SSO_SHARED_SECRET):

- Con secreto (acceso unico): las personas entran desde la aplicacion
  principal (menu DevOps), con su mismo usuario, captcha y 2FA; aqui se
  recibe un pase firmado y se abre una sesion por cookie (ver
  routers/sso.py). La aplicacion principal llama a la API con un pase de
  servicio (Authorization: Bearer). El usuario/contrasena compartidos de
  HTTP Basic quedan apagados, salvo DASHBOARD_BASIC_AUTH=on.
- Sin secreto (instalacion anterior): HTTP Basic con DASHBOARD_USER /
  DASHBOARD_PASSWORD, como siempre.
"""
import secrets
from urllib.parse import urlsplit

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from .config import settings
from .services import sso_service

security = HTTPBasic(auto_error=False)

SESSION_COOKIE = "sidecar_session"
ORIGIN_COOKIE = "sidecar_origin"


def basic_enabled() -> bool:
    mode = (settings.dashboard_basic_auth or "auto").lower()
    if mode in ("on", "true", "1", "si", "sí"):
        return True
    if mode in ("off", "false", "0", "no"):
        return False
    return not sso_service.enabled()


def main_app_url(request: Request) -> str | None:
    """De que aplicacion principal vino este navegador (cookie firmada), o la configurada."""
    origin = sso_service.verify(request.cookies.get(ORIGIN_COOKIE), "sidecar-origin")
    url = (origin or {}).get("app") or settings.main_app_url
    if url and urlsplit(url).scheme in ("http", "https"):
        return url.rstrip("/")
    return None


def _same_origin(request: Request) -> bool:
    """Con sesion por cookie, un formulario solo vale si sale de este mismo sitio."""
    source = request.headers.get("origin") or request.headers.get("referer")
    if not source:
        return True  # sin cabecera (clientes no navegador): la cookie SameSite ya cubre el caso
    return urlsplit(source).netloc.lower() == (request.headers.get("host") or "").lower()


def require_dashboard_auth(request: Request, credentials: HTTPBasicCredentials | None = Depends(security)) -> str:
    # 1. Sesion abierta con un pase de la aplicacion principal.
    session = sso_service.verify(request.cookies.get(SESSION_COOKIE), "sidecar-session")
    if session:
        if request.method not in ("GET", "HEAD", "OPTIONS") and not _same_origin(request):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solicitud desde otro sitio rechazada.")
        request.state.user = {"email": session.get("sub"), "name": session.get("name") or session.get("sub"), "role": session.get("role")}
        request.state.main_app_url = main_app_url(request)
        return str(session.get("sub") or "usuario")

    # 2. Llamada de servicio de la aplicacion principal.
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        service = sso_service.verify(header[7:].strip(), "sidecar-api")
        if service:
            return str(service.get("sub") or "aplicacion-principal")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Pase de servicio invalido o vencido.")

    # 3. HTTP Basic (instalaciones sin acceso unico, o habilitado a proposito).
    if basic_enabled():
        if credentials is not None:
            user_ok = secrets.compare_digest(credentials.username, settings.dashboard_user)
            pass_ok = secrets.compare_digest(credentials.password, settings.dashboard_password)
            if user_ok and pass_ok:
                return credentials.username
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenciales invalidas.",
            headers={"WWW-Authenticate": "Basic"},
        )

    # Acceso unico sin sesion: un navegador vuelve a la aplicacion principal
    # (que emite un pase nuevo si su sesion sigue viva); la API responde 401.
    app_url = main_app_url(request)
    wants_html = "text/html" in (request.headers.get("accept") or "")
    if app_url and wants_html and request.method == "GET":
        raise HTTPException(status_code=status.HTTP_307_TEMPORARY_REDIRECT, headers={"Location": f"{app_url}/devops"})
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Sesion no iniciada. Entre desde la aplicacion principal (menu DevOps).",
    )
