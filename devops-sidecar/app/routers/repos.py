from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import models, schemas, scheduler
from ..auth import require_dashboard_auth
from ..config import settings
from ..database import get_db

router = APIRouter(prefix="/api/repos", tags=["repos"], dependencies=[Depends(require_dashboard_auth)])


@router.get("", response_model=list[schemas.RepoOut])
def list_repos(db: Session = Depends(get_db)):
    return db.query(models.Repo).order_by(models.Repo.name).all()


@router.post("", response_model=schemas.RepoOut, status_code=201)
def create_repo(payload: schemas.RepoCreate, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    local_path = str(Path(settings.repos_base_path) / payload.name)
    repo = models.Repo(
        name=payload.name,
        github_url=payload.github_url,
        github_token=payload.github_token or None,
        local_path=local_path,
        sync_interval_minutes=payload.sync_interval_minutes,
    )
    db.add(repo)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'Ya existe un repositorio con el nombre "{payload.name}".')
    db.refresh(repo)

    scheduler.schedule_repo_sync(repo)
    # Clona de inmediato en segundo plano - no hace falta esperar al
    # primer intervalo para tener el repo disponible.
    background_tasks.add_task(scheduler.sync_repo_job, repo.id)

    return repo


@router.post("/{repo_id}/sync", response_model=schemas.RepoOut)
def sync_now(repo_id: int, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    repo = db.get(models.Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repositorio no encontrado.")
    background_tasks.add_task(scheduler.sync_repo_job, repo.id)
    return repo


@router.delete("/{repo_id}", status_code=204)
def delete_repo(repo_id: int, db: Session = Depends(get_db)):
    repo = db.get(models.Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repositorio no encontrado.")
    scheduler.unschedule_repo_sync(repo_id)
    db.delete(repo)
    db.commit()
    return None
