import tempfile
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import require_dashboard_auth
from ..config import settings
from ..database import get_db
from ..services import ai_client, db_backup_service, settings_store

# Frase exacta que hay que escribir para confirmar una restauracion -
# ademas de estar autenticado con el Basic Auth del dashboard, una
# segunda barrera deliberada contra un click accidental en una accion
# destructiva (reemplaza TODA la configuracion actual).
RESTORE_CONFIRMATION_PHRASE = "RESTAURAR SIDECAR"

router = APIRouter(dependencies=[Depends(require_dashboard_auth)])
templates = Jinja2Templates(directory="app/templates")


def _mask(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "•" * len(value)
    return f"{value[:4]}…{value[-4:]} (ya configurada)"


@router.get("/configuracion", response_class=HTMLResponse)
def settings_page(
    request: Request,
    saved: bool = False,
    restored: bool = False,
    restore_error: str | None = None,
    snapshot: str | None = None,
):
    return templates.TemplateResponse(
        "settings.html",
        {
            "request": request,
            "saved": saved,
            "restored": restored,
            "restore_error": restore_error,
            "snapshot": snapshot,
            "settings": settings,
            "gemini_key_masked": _mask(settings.gemini_api_key),
            "anthropic_key_masked": _mask(settings.anthropic_api_key),
        },
    )


@router.get("/configuracion/respaldo/descargar")
def download_backup():
    """Descarga un .tar.gz con TODA la configuracion de este modulo
    (repos registrados, proveedor de IA, historial) - pensado para
    migrar a otro servidor que ya tenga la app y Docker instalados."""
    archive_path = db_backup_service.create_backup_archive()
    cleanup = BackgroundTasks()
    cleanup.add_task(lambda: archive_path.unlink(missing_ok=True))
    return FileResponse(
        archive_path, filename=archive_path.name, media_type="application/gzip", background=cleanup
    )


@router.post("/configuracion/respaldo/restaurar")
async def restore_backup(confirmacion: str = Form(...), file: UploadFile = File(...)):
    """Restaura sidecar.db desde un respaldo subido. Destructivo -
    reemplaza TODA la configuracion actual (guarda un snapshot de
    seguridad automatico antes, ver db_backup_service)."""
    if confirmacion != RESTORE_CONFIRMATION_PHRASE:
        return RedirectResponse(url="/configuracion?restore_error=confirmacion", status_code=303)

    tmp_path = Path(tempfile.gettempdir()) / f"sidecar_upload_{file.filename}"
    try:
        with open(tmp_path, "wb") as f:
            f.write(await file.read())
        snapshot_name = db_backup_service.restore_from_upload(tmp_path)
    except Exception:
        return RedirectResponse(url="/configuracion?restore_error=invalido", status_code=303)
    finally:
        tmp_path.unlink(missing_ok=True)

    return RedirectResponse(url=f"/configuracion?restored=1&snapshot={snapshot_name}", status_code=303)


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
