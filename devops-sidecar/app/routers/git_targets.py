"""API de mirrors Git de respaldo y sincronizacion colaborador -> principal
(ver services/git_targets.py). El token entra por aqui cifrado y nunca
vuelve a salir; al editar, un token vacio conserva el guardado."""
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..auth import require_dashboard_auth
from ..database import get_db
from ..services import crypto_service, git_service, git_targets

router = APIRouter(prefix="/api", tags=["git-destinos"], dependencies=[Depends(require_dashboard_auth)])


class GitTargetPayload(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    purpose: str
    url: str = Field(min_length=1, max_length=500)
    auth_user: str | None = None
    token: str | None = None
    clear_token: bool = False
    mirror_mode: str = "protegido"
    source_branch: str | None = None
    base_branch: str | None = None
    push_mode: str = "pr"
    schedule: str = "manual"
    enabled: bool = True


def _out(t: models.GitTarget) -> dict:
    return {
        "id": t.id, "repo_id": t.repo_id, "name": t.name, "purpose": t.purpose,
        "url": git_service.strip_credentials(t.url), "auth_user": t.auth_user,
        "default_user": git_targets.default_user(t.url), "token_set": bool(t.token_enc),
        "mirror_mode": t.mirror_mode, "source_branch": t.source_branch, "base_branch": t.base_branch,
        "push_mode": t.push_mode, "schedule": t.schedule, "enabled": t.enabled,
        "last_run_at": t.last_run_at.isoformat() if t.last_run_at else None,
        "last_status": t.last_status, "last_message": t.last_message, "last_pr_url": t.last_pr_url,
        "running": git_targets.is_running(t.id),
    }


def _apply(db: Session, repo: models.Repo, t: models.GitTarget, p: GitTargetPayload) -> None:
    if p.purpose not in ("mirror", "upstream"):
        raise HTTPException(status_code=422, detail="Tipo no valido (mirror o upstream).")
    if p.mirror_mode not in ("exacto", "protegido") or p.push_mode not in ("pr", "directo") or \
            p.schedule not in ("manual", "after_sync"):
        raise HTTPException(status_code=422, detail="Opcion no valida.")
    url = p.url.strip()
    problem = git_targets.validate_url(url)
    if problem:
        raise HTTPException(status_code=422, detail=problem)
    for label, branch in (("rama del colaborador", p.source_branch), ("rama base", p.base_branch)):
        if branch and not git_targets.valid_branch(branch.strip()):
            raise HTTPException(status_code=422, detail=f"Nombre de {label} no valido: {branch}")
    problem = git_targets.conflicts(db, repo, p.purpose, url)
    if problem:
        raise HTTPException(status_code=422, detail=problem)
    t.name = p.name.strip()
    t.purpose = p.purpose
    t.url = url
    t.auth_user = (p.auth_user or "").strip() or None
    if p.clear_token:
        t.token_enc = None
    elif p.token and p.token.strip():
        t.token_enc = crypto_service.encrypt(p.token.strip())
    t.mirror_mode = p.mirror_mode
    t.source_branch = (p.source_branch or "").strip() or None
    t.base_branch = (p.base_branch or "").strip() or None
    t.push_mode = p.push_mode
    t.schedule = p.schedule
    t.enabled = p.enabled


def _get(db: Session, target_id: int) -> models.GitTarget:
    t = db.get(models.GitTarget, target_id)
    if not t:
        raise HTTPException(status_code=404, detail="Destino Git no encontrado.")
    return t


@router.get("/repos/{repo_id}/git-targets")
def list_targets(repo_id: int, db: Session = Depends(get_db)):
    return [_out(t) for t in db.query(models.GitTarget).filter_by(repo_id=repo_id).order_by(models.GitTarget.name).all()]


@router.post("/repos/{repo_id}/git-targets", status_code=201)
def create_target(repo_id: int, payload: GitTargetPayload, db: Session = Depends(get_db)):
    repo = db.get(models.Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repositorio no encontrado.")
    t = models.GitTarget(repo_id=repo.id)
    _apply(db, repo, t, payload)
    db.add(t)
    db.commit()
    db.refresh(t)
    return _out(t)


@router.put("/git-targets/{target_id}")
def update_target(target_id: int, payload: GitTargetPayload, db: Session = Depends(get_db)):
    t = _get(db, target_id)
    if git_targets.is_running(target_id):
        raise HTTPException(status_code=409, detail="Se esta ejecutando; espere a que termine.")
    _apply(db, t.repo, t, payload)
    db.commit()
    return _out(t)


@router.delete("/git-targets/{target_id}")
def delete_target(target_id: int, db: Session = Depends(get_db)):
    t = _get(db, target_id)
    if git_targets.is_running(target_id):
        raise HTTPException(status_code=409, detail="Se esta ejecutando; espere a que termine.")
    git_targets.remove_workspace(t)
    db.delete(t)
    db.commit()
    return {"ok": True, "message": "Eliminado. El repositorio remoto no se toca."}


@router.post("/git-targets/{target_id}/test")
def test_target(target_id: int, db: Session = Depends(get_db)):
    ok, message = git_targets.test_target(db, _get(db, target_id))
    return {"ok": ok, "message": message}


@router.post("/git-targets/{target_id}/run")
def run_target(target_id: int, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    _get(db, target_id)
    if git_targets.is_running(target_id):
        raise HTTPException(status_code=409, detail="Ya se esta ejecutando.")
    background_tasks.add_task(git_targets.run_target, target_id, "manual")
    return {"ok": True, "message": "Iniciado en segundo plano; el resultado aparece en unos segundos."}


@router.get("/git-targets/{target_id}/runs")
def target_runs(target_id: int, db: Session = Depends(get_db)):
    runs = db.query(models.GitTargetRun).filter_by(target_id=target_id).order_by(models.GitTargetRun.id.desc()).limit(20).all()
    return [{"id": r.id, "trigger": r.trigger, "status": r.status, "started_at": r.started_at.isoformat(),
             "finished_at": r.finished_at.isoformat() if r.finished_at else None, "log": r.log or ""} for r in runs]
