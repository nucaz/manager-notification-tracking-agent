"""API de destinos externos y trabajos de respaldo programados.
Los secretos de un destino (tokens, claves, contrasenas) entran por aqui
pero nunca vuelven a salir: la lista solo informa que campos estan
configurados. Al editar, un campo secreto vacio conserva el valor guardado."""
import json
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import models, scheduler
from ..auth import require_dashboard_auth
from ..database import get_db
from ..services import backup_jobs, rclone_service

router = APIRouter(prefix="/api", tags=["respaldos-externos"], dependencies=[Depends(require_dashboard_auth)])


# ------------------------------- destinos ---------------------------------
class DestinationPayload(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: str
    remote_path: str = "devops-sidecar"
    encrypt: bool = False
    enabled: bool = True
    config: dict = {}


def _dest_out(d: models.BackupDestination) -> dict:
    try:
        cfg = rclone_service.load_config(d)
    except rclone_service.RcloneError:
        cfg = {}
    secret = rclone_service.secret_keys(d.kind) if d.kind in rclone_service.KINDS else set()
    return {
        "id": d.id, "name": d.name, "kind": d.kind,
        "kind_label": rclone_service.KINDS.get(d.kind, {}).get("label", d.kind),
        "remote_path": d.remote_path, "encrypt": d.encrypt, "enabled": d.enabled,
        "account_label": d.account_label,
        # Valores no secretos (para rellenar el formulario al editar) y
        # solo el nombre de los secretos configurados.
        "config": {k: v for k, v in cfg.items() if k not in secret},
        "secrets_set": sorted(k for k in cfg if k in secret and cfg[k]),
        "last_test_at": d.last_test_at.isoformat() if d.last_test_at else None,
        "last_test_ok": d.last_test_ok, "last_test_message": d.last_test_message,
    }


def _normalize(kind: str, config: dict) -> dict:
    clean = {k: (v.strip() if isinstance(v, str) and k not in ("key_pem",) else v) for k, v in config.items()}
    if kind in ("onedrive", "gdrive") and clean.get("token"):
        try:
            clean["token"] = json.dumps(json.loads(clean["token"]), separators=(",", ":"))
        except ValueError:
            pass
    return {k: v for k, v in clean.items() if v not in (None, "")}


def _apply_destination(db: Session, dest: models.BackupDestination, payload: DestinationPayload) -> None:
    if payload.kind not in rclone_service.KINDS:
        raise HTTPException(status_code=422, detail=f"Tipo de destino desconocido: {payload.kind}")
    previous = {}
    if dest.config_enc and dest.kind == payload.kind:
        previous = rclone_service.load_config(dest)
    incoming = _normalize(payload.kind, payload.config)
    merged = dict(previous)
    merged.update(incoming)
    # Un campo no secreto que se vacio en el formulario se borra de verdad.
    secret = rclone_service.secret_keys(payload.kind)
    for k in list(merged):
        if k not in secret and k not in incoming and k in previous:
            merged.pop(k)
    remote_path = payload.remote_path.strip()
    if payload.kind == "smb":
        # Ruta pegada del Explorador (\\\\servidor\\recurso\\carpeta): se guarda
        # como recurso/carpeta y, si falta, se toma el servidor de ahi.
        path, found = rclone_service.smb_path(remote_path, merged.get("host", ""))
        if found and not merged.get("host"):
            merged["host"] = found
        problems = rclone_service.validate(payload.kind, merged, payload.encrypt, remote_path)
        remote_path = path or remote_path
    else:
        problems = rclone_service.validate(payload.kind, merged, payload.encrypt, remote_path)
    if problems:
        raise HTTPException(status_code=422, detail=" ".join(problems))
    if payload.kind == "onedrive" and ("token" in incoming or not merged.get("drive_id")) and \
            merged.get("drive_type", "auto") in ("auto", "personal", "business") and not incoming.get("drive_id"):
        try:
            info = rclone_service.discover_onedrive(merged["token"])
        except rclone_service.RcloneError as e:
            raise HTTPException(status_code=422, detail=str(e))
        merged["drive_id"] = info["drive_id"]
        merged["drive_type"] = info["drive_type"]
        dest.account_label = info["account"] or dest.account_label
    identity_changed = any(incoming.get(k) != previous.get(k) for k in ("tenant", "client_id", "target_type", "target"))
    if payload.kind == "onedrive_app" and (not incoming.get("drive_id") or identity_changed):
        try:
            info = rclone_service.discover_onedrive_app(merged)
        except rclone_service.RcloneError as e:
            raise HTTPException(status_code=422, detail=str(e))
        merged["drive_id"] = info["drive_id"]
        merged["drive_type"] = info["drive_type"]
        dest.account_label = info["account"] or dest.account_label
    if merged.get("drive_type") == "auto":
        merged["drive_type"] = "personal"
    dest.name = payload.name.strip()
    dest.kind = payload.kind
    dest.remote_path = remote_path
    dest.encrypt = payload.encrypt
    dest.enabled = payload.enabled
    if payload.kind not in ("onedrive", "onedrive_app"):
        dest.account_label = merged.get("user") or merged.get("host") or merged.get("access_key_id") or dest.account_label
    rclone_service.store_config(dest, merged)


@router.get("/backup-destinations/kinds")
def destination_kinds():
    return {"kinds": rclone_service.KINDS, "crypt_fields": rclone_service.CRYPT_FIELDS}


@router.get("/backup-destinations")
def list_destinations(db: Session = Depends(get_db)):
    return [_dest_out(d) for d in db.query(models.BackupDestination).order_by(models.BackupDestination.name).all()]


@router.post("/backup-destinations", status_code=201)
def create_destination(payload: DestinationPayload, db: Session = Depends(get_db)):
    dest = models.BackupDestination(config_enc="")
    _apply_destination(db, dest, payload)
    db.add(dest)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'Ya existe un destino llamado "{payload.name}".')
    db.refresh(dest)
    return _dest_out(dest)


@router.put("/backup-destinations/{dest_id}")
def update_destination(dest_id: int, payload: DestinationPayload, db: Session = Depends(get_db)):
    dest = db.get(models.BackupDestination, dest_id)
    if not dest:
        raise HTTPException(status_code=404, detail="Destino no encontrado.")
    _apply_destination(db, dest, payload)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'Ya existe un destino llamado "{payload.name}".')
    return _dest_out(dest)


@router.delete("/backup-destinations/{dest_id}")
def delete_destination(dest_id: int, db: Session = Depends(get_db)):
    dest = db.get(models.BackupDestination, dest_id)
    if not dest:
        raise HTTPException(status_code=404, detail="Destino no encontrado.")
    using = [j.name for j in db.query(models.BackupJob).all() if dest_id in backup_jobs.job_destination_ids(j)]
    if using:
        raise HTTPException(status_code=409, detail="Lo usan estos trabajos; quitelo de ellos primero: " + ", ".join(using))
    db.query(models.BackupTransfer).filter(models.BackupTransfer.destination_id == dest_id).delete()
    db.delete(dest)
    db.commit()
    return {"ok": True, "message": "Destino eliminado. Los respaldos ya subidos a ese destino NO se borraron."}


@router.post("/backup-destinations/{dest_id}/test")
def test_destination(dest_id: int, db: Session = Depends(get_db)):
    dest = db.get(models.BackupDestination, dest_id)
    if not dest:
        raise HTTPException(status_code=404, detail="Destino no encontrado.")
    ok, message = rclone_service.test_destination(db, dest)
    dest.last_test_at = datetime.utcnow()
    dest.last_test_ok = ok
    dest.last_test_message = message
    db.commit()
    return {"ok": ok, "message": message}


# ------------------------------- trabajos ---------------------------------
class JobPayload(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    enabled: bool = True
    repo_ids: list[int] = []
    include_bundle: bool = True
    include_content: bool = False
    include_diff: bool = True
    include_sidecar_db: bool = True
    include_repos: bool = True
    include_main_app: bool = False
    frequency: str = "daily"
    hour: int = Field(2, ge=0, le=23)
    minute: int = Field(0, ge=0, le=59)
    day_of_week: str = "sun"
    day_of_month: int = Field(1, ge=1, le=28)
    cron_expr: str | None = None
    incrementals_per_full: int = Field(6, ge=0, le=365)
    keep_chains_local: int = Field(2, ge=1, le=100)
    keep_chains_remote: int = Field(4, ge=1, le=1000)
    destination_ids: list[int] = []


def _job_out(db: Session, job: models.BackupJob) -> dict:
    repo_ids = backup_jobs.job_repo_ids(job)
    dest_ids = backup_jobs.job_destination_ids(job)
    repos = db.query(models.Repo).filter(models.Repo.id.in_(repo_ids)).all() if repo_ids else []
    dests = db.query(models.BackupDestination).filter(models.BackupDestination.id.in_(dest_ids)).all() if dest_ids else []
    nxt = scheduler.next_backup_run(job.id)
    return {
        "id": job.id, "name": job.name, "enabled": job.enabled,
        "repo_ids": repo_ids, "repo_names": [r.name for r in repos] or ["Todos los repositorios activos"],
        "include_bundle": job.include_bundle, "include_content": job.include_content,
        "include_diff": job.include_diff, "include_sidecar_db": job.include_sidecar_db,
        "include_repos": job.include_repos, "include_main_app": job.include_main_app,
        "frequency": job.frequency, "hour": job.hour, "minute": job.minute, "day_of_week": job.day_of_week,
        "day_of_month": job.day_of_month, "cron_expr": job.cron_expr,
        "schedule_text": scheduler.describe_schedule(job),
        "next_run": nxt.strftime("%Y-%m-%d %H:%M") if nxt else None,
        "incrementals_per_full": job.incrementals_per_full,
        "keep_chains_local": job.keep_chains_local, "keep_chains_remote": job.keep_chains_remote,
        "destination_ids": dest_ids, "destination_names": [d.name for d in dests],
        "last_run_at": job.last_run_at.isoformat() if job.last_run_at else None,
        "last_status": job.last_status, "running": backup_jobs.is_running(job.id),
    }


def _apply_job(db: Session, job: models.BackupJob, p: JobPayload) -> None:
    if p.frequency not in ("daily", "weekly", "monthly", "cron"):
        raise HTTPException(status_code=422, detail="Frecuencia no valida.")
    if p.day_of_week not in scheduler.DIAS:
        raise HTTPException(status_code=422, detail="Dia de la semana no valido.")
    if not ((p.include_repos and (p.include_bundle or p.include_content or p.include_diff)) or p.include_sidecar_db or p.include_main_app):
        raise HTTPException(status_code=422, detail="Elija al menos un contenido para respaldar.")
    known_dests = {d.id for d in db.query(models.BackupDestination).all()}
    if any(d not in known_dests for d in p.destination_ids):
        raise HTTPException(status_code=422, detail="Uno de los destinos elegidos ya no existe.")
    for field in ("name", "enabled", "include_bundle", "include_content", "include_diff", "include_sidecar_db", "include_repos", "include_main_app",
                  "frequency", "hour", "minute", "day_of_week", "day_of_month", "incrementals_per_full",
                  "keep_chains_local", "keep_chains_remote"):
        setattr(job, field, getattr(p, field))
    job.name = p.name.strip()
    job.cron_expr = (p.cron_expr or "").strip() or None
    job.repo_ids_json = json.dumps(sorted(set(p.repo_ids)))
    job.destination_ids_json = json.dumps(sorted(set(p.destination_ids)))
    try:
        scheduler.backup_trigger(job)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.get("/backup-jobs")
def list_jobs(db: Session = Depends(get_db)):
    return [_job_out(db, j) for j in db.query(models.BackupJob).order_by(models.BackupJob.name).all()]


@router.post("/backup-jobs", status_code=201)
def create_job(payload: JobPayload, db: Session = Depends(get_db)):
    job = models.BackupJob()
    _apply_job(db, job, payload)
    db.add(job)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'Ya existe un trabajo llamado "{payload.name}".')
    db.refresh(job)
    scheduler.schedule_backup_job(job)
    return _job_out(db, job)


@router.put("/backup-jobs/{job_id}")
def update_job(job_id: int, payload: JobPayload, db: Session = Depends(get_db)):
    job = db.get(models.BackupJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Trabajo no encontrado.")
    _apply_job(db, job, payload)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'Ya existe un trabajo llamado "{payload.name}".')
    scheduler.schedule_backup_job(job)
    return _job_out(db, job)


@router.delete("/backup-jobs/{job_id}")
def delete_job(job_id: int, db: Session = Depends(get_db)):
    job = db.get(models.BackupJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Trabajo no encontrado.")
    if backup_jobs.is_running(job_id):
        raise HTTPException(status_code=409, detail="El trabajo se esta ejecutando; espere a que termine.")
    scheduler.unschedule_backup_job(job_id)
    db.delete(job)
    db.commit()
    return {"ok": True, "message": "Trabajo eliminado. Los archivos ya generados (en el servidor y en los destinos) no se borraron."}


@router.post("/backup-jobs/{job_id}/run")
def run_job_now(job_id: int, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    job = db.get(models.BackupJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Trabajo no encontrado.")
    if backup_jobs.is_running(job_id):
        raise HTTPException(status_code=409, detail="Este trabajo ya se esta ejecutando.")
    background_tasks.add_task(backup_jobs.run_job, job_id, "manual")
    return {"ok": True, "message": "Trabajo iniciado en segundo plano. Actualice en unos momentos para ver el resultado."}


@router.post("/backup-jobs/{job_id}/test")
def test_job(job_id: int, db: Session = Depends(get_db)):
    """Prueba previa a ejecutar: cada destino del trabajo (escribe, lee y
    borra un archivo de prueba) y cada repositorio (clonado y legible).
    No genera respaldos."""
    job = db.get(models.BackupJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Trabajo no encontrado.")
    checks = []
    repo_ids = backup_jobs.job_repo_ids(job)
    q = db.query(models.Repo).filter(models.Repo.id.in_(repo_ids)) if repo_ids else         db.query(models.Repo).filter(models.Repo.active.is_(True))
    repos = q.order_by(models.Repo.name).all() if job.include_repos else []
    if job.include_main_app:
        ok, msg = backup_jobs.check_main_app()
        checks.append({"kind": "aplicacion", "name": "Aplicación principal", "ok": ok, "message": msg})
    if not repos and not job.include_sidecar_db and not job.include_main_app:
        checks.append({"kind": "repo", "name": "Repositorios", "ok": False, "message": "El trabajo no tiene repositorios que respaldar."})
    for repo in repos:
        ok, msg = backup_jobs.check_repo_ready(repo)
        checks.append({"kind": "repo", "name": repo.name, "ok": ok, "message": msg})
    ok, msg = backup_jobs.check_local_space()
    checks.append({"kind": "servidor", "name": "Disco del servidor", "ok": ok, "message": msg})
    dest_ids = backup_jobs.job_destination_ids(job)
    dests = db.query(models.BackupDestination).filter(models.BackupDestination.id.in_(dest_ids)).all() if dest_ids else []
    if not dests:
        checks.append({"kind": "destino", "name": "Destinos", "ok": True, "message": "Sin destinos externos: los respaldos quedan solo en el servidor."})
    for dest in dests:
        if not dest.enabled:
            checks.append({"kind": "destino", "name": dest.name, "ok": False, "message": "El destino esta desactivado: el trabajo lo omitira."})
            continue
        ok, msg = rclone_service.test_destination(db, dest)
        dest.last_test_at = datetime.utcnow()
        dest.last_test_ok = ok
        dest.last_test_message = msg
        db.commit()
        checks.append({"kind": "destino", "name": dest.name, "ok": ok, "message": msg})
    return {"ok": all(c["ok"] for c in checks), "checks": checks}


@router.get("/backup-jobs/{job_id}/points")
def job_points(job_id: int, db: Session = Depends(get_db)):
    job = db.get(models.BackupJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Trabajo no encontrado.")
    points = db.query(models.BackupPoint).filter_by(job_id=job_id).order_by(models.BackupPoint.id.desc()).limit(500).all()
    return [{
        "id": p.id, "repo": p.repo_name, "kind": p.kind, "seq": p.seq, "chain_label": p.chain_label,
        "created_at": p.created_at.isoformat(), "total_bytes": p.total_bytes, "local_deleted": p.local_deleted,
        "files": json.loads(p.files_json),
        "transfers": [{"destination": t.destination.name if t.destination else t.destination_id, "status": t.status,
                       "verified": t.verified, "message": t.message, "at": t.finished_at.isoformat()}
                      for t in p.transfers],
    } for p in points]


@router.get("/backup-jobs/{job_id}/runs")
def job_runs(job_id: int, db: Session = Depends(get_db)):
    runs = db.query(models.BackupJobRun).filter_by(job_id=job_id).order_by(models.BackupJobRun.id.desc()).limit(50).all()
    return [{"id": r.id, "trigger": r.trigger, "status": r.status, "started_at": r.started_at.isoformat(),
             "finished_at": r.finished_at.isoformat() if r.finished_at else None, "log": r.log or ""} for r in runs]
