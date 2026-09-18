from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import require_dashboard_auth
from ..config import settings
from ..database import get_db
from ..services import ai_client, settings_store

router = APIRouter(dependencies=[Depends(require_dashboard_auth)])
templates = Jinja2Templates(directory="app/templates")


def _mask(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "•" * len(value)
    return f"{value[:4]}…{value[-4:]} (ya configurada)"


@router.get("/configuracion", response_class=HTMLResponse)
def settings_page(request: Request, saved: bool = False):
    return templates.TemplateResponse(
        "settings.html",
        {
            "request": request,
            "saved": saved,
            "settings": settings,
            "gemini_key_masked": _mask(settings.gemini_api_key),
            "anthropic_key_masked": _mask(settings.anthropic_api_key),
        },
    )


@router.post("/configuracion")
async def save_settings(request: Request, db: Session = Depends(get_db)):
    form = await request.form()
    values = {}
    for key in settings_store.OVERRIDABLE_KEYS:
        val = (form.get(key) or "").strip()
        if val:
            values[key] = val
    settings_store.save_overrides(db, values)
    return RedirectResponse(url="/configuracion?saved=1", status_code=303)


class TestPayload(BaseModel):
    provider: str
    gemini_api_key: str | None = None
    gemini_model: str | None = None
    anthropic_api_key: str | None = None
    anthropic_model: str | None = None
    ollama_base_url: str | None = None
    ollama_model: str | None = None


@router.post("/api/settings/test")
async def test_settings(payload: TestPayload):
    ok, message = await ai_client.test_connection(payload.provider, payload.model_dump(exclude_none=True))
    return {"ok": ok, "message": message}
