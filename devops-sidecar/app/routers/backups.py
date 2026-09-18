from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import models
from ..auth import require_dashboard_auth
from ..database import get_db

router = APIRouter(prefix="/api/backups", tags=["backups"], dependencies=[Depends(require_dashboard_auth)])


@router.get("")
def listar_backups(repo_id: int | None = None, limit: int = 50, db: Session = Depends(get_db)):
    """Lista de respaldos (para el dashboard JSON y el chatbot) - cuenta
    total y detalle de los mas recientes."""
    query = db.query(models.BackupRun)
    if repo_id:
        query = query.filter(models.BackupRun.repo_id == repo_id)
    total = query.count()
    runs = query.order_by(models.BackupRun.created_at.desc()).limit(min(limit, 200)).all()
    return {
        "total": total,
        "items": [
            {
                "id": r.id,
                "repo": r.repo.name if r.repo else r.repo_id,
                "backup_type": r.backup_type,
                "size_bytes": r.size_bytes,
                "created_at": r.created_at.isoformat(),
            }
            for r in runs
        ],
    }


@router.get("/{backup_id}/descargar")
def descargar_backup(backup_id: int, db: Session = Depends(get_db)):
    """Descarga el archivo de un respaldo (mirror .tar.gz, archivos
    .tar.gz o diff .diff) tal como quedo guardado en el volumen Docker."""
    run = db.get(models.BackupRun, backup_id)
    if not run:
        raise HTTPException(status_code=404, detail="Respaldo no encontrado.")
    path = Path(run.file_path)
    if not path.exists():
        raise HTTPException(status_code=410, detail="El archivo de este respaldo ya no existe en disco.")
    return FileResponse(str(path), filename=path.name, media_type="application/octet-stream")


@router.delete("/{backup_id}")
def eliminar_backup(backup_id: int, db: Session = Depends(get_db)):
    run = db.get(models.BackupRun, backup_id)
    if not run:
        raise HTTPException(status_code=404, detail="Respaldo no encontrado.")
    Path(run.file_path).unlink(missing_ok=True)
    db.delete(run)
    db.commit()
    return {"ok": True}


class BulkDeletePayload(BaseModel):
    ids: list[int]


@router.post("/eliminar-varios")
def eliminar_varios(payload: BulkDeletePayload, db: Session = Depends(get_db)):
    borrados = 0
    for backup_id in payload.ids:
        run = db.get(models.BackupRun, backup_id)
        if not run:
            continue
        Path(run.file_path).unlink(missing_ok=True)
        db.delete(run)
        borrados += 1
    db.commit()
    return {"ok": True, "borrados": borrados}
