"""Entrada por acceso unico: la aplicacion principal envia aqui (POST de
un formulario, no en la URL, para que el pase no quede en historiales ni
en logs) un pase firmado de un solo uso, y este modulo abre su sesion.
Ver services/sso_service.py y auth.py."""
import html
from urllib.parse import urlsplit

from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from ..auth import ORIGIN_COOKIE, SESSION_COOKIE, main_app_url
from ..services import sso_service

router = APIRouter(tags=["sso"])


def _is_https(request: Request) -> bool:
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "").split(",")[0].strip()
    return proto == "https"


def _page(title: str, message: str, link: str | None, status_code: int) -> HTMLResponse:
    back = f'<p><a href="{html.escape(link, quote=True)}">Volver a la aplicación principal</a></p>' if link else ""
    return HTMLResponse(
        f"<!doctype html><html lang='es'><meta charset='utf-8'><title>{title}</title>"
        f"<body style='font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem'>"
        f"<h3>{title}</h3><p>{message}</p>{back}</body></html>",
        status_code=status_code,
    )


@router.post("/sso")
def sso_login(request: Request, token: str = Form("")):
    payload = sso_service.verify(token, "sidecar-sso")
    if not payload or not sso_service.consume_pass(payload):
        return _page("No se pudo entrar a DevOps", "El pase de acceso no es válido, venció o ya se usó. Vuelva a entrar desde la aplicación principal (menú DevOps).",
                     main_app_url(request), 401)
    secure = _is_https(request)
    response = RedirectResponse("/", status_code=303)
    response.set_cookie(SESSION_COOKIE, sso_service.session_token(payload), max_age=sso_service.SESSION_SECONDS,
                        httponly=True, samesite="lax", secure=secure, path="/")
    app_url = str(payload.get("app") or "")
    if urlsplit(app_url).scheme in ("http", "https"):
        response.set_cookie(ORIGIN_COOKIE, sso_service.origin_token(app_url.rstrip("/")), max_age=sso_service.ORIGIN_SECONDS,
                            httponly=True, samesite="lax", secure=secure, path="/")
    return response


@router.get("/salir")
def logout(request: Request):
    app_url = main_app_url(request)
    response = RedirectResponse(app_url, status_code=303) if app_url else _page(
        "Sesión de DevOps cerrada", "Para volver a entrar use el menú DevOps de la aplicación principal.", None, 200)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return response
