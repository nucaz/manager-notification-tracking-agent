"""API de restauracion (ver services/restore_service.py). El token para
'subir a un repositorio Git' se usa solo en memoria durante la
restauracion: no se guarda en ningun lado."""
import json
import re
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import models
from ..auth import require_dashboard_auth
from ..database import get_db
from ..services import backup_jobs, external_restore, external_sources, git_service, git_targets, rclone_service, restore_service

router = APIRouter(prefix="/api", tags=["restauracion"], dependencies=[Depends(require_dashboard_auth)])


class RestorePayload(BaseModel):
    mode: str  # verificar | descargar | subir | aplicar (aplicacion completa) | nueva_base (sistema externo)
    confirmacion: str | None = None  # "RESTAURAR TODO" para aplicar
    # Opcion A: un punto conocido por el sidecar + de donde leerlo.
    point_id: int | None = None
    source: str | None = None  # "local" o el id del destino
    # Opcion B: una cadena encontrada explorando un destino.
    destination_id: int | None = None
    chain_path: str | None = None
    seq: int | None = None
    push_url: str | None = None
    push_user: str | None = None
    push_token: str | None = None
    # nueva_base: conexion del destino (se usa solo en memoria, no se guarda).
    target: dict | None = None


def _out(rr: models.RestoreRun) -> dict:
    return {"id": rr.id, "source": rr.source_label, "chain_path": rr.chain_path, "repo": rr.repo_name, "seq": rr.seq,
            "mode": rr.mode, "status": rr.status, "log": rr.log or "", "outputs": json.loads(rr.outputs_json or "[]"),
            "progress": rr.progress or 0, "step": rr.step, "steps": json.loads(rr.steps_json or "[]"),
            "created_at": rr.created_at.isoformat(), "finished_at": rr.finished_at.isoformat() if rr.finished_at else None}


def _destination(db: Session, dest_id: int) -> models.BackupDestination:
    dest = db.get(models.BackupDestination, dest_id)
    if not dest:
        raise HTTPException(status_code=404, detail="Destino no encontrado.")
    return dest


@router.get("/backup-destinations/{dest_id}/explorar")
def explore(dest_id: int, db: Session = Depends(get_db)):
    dest = _destination(db, dest_id)
    try:
        return {"destination": dest.name, "encrypted": dest.encrypt, "chains": restore_service.explore_destination(db, dest)}
    except (restore_service.RestoreError, rclone_service.RcloneError) as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/backup-points/{point_id}/sources")
def point_sources(point_id: int, db: Session = Depends(get_db)):
    p = db.get(models.BackupPoint, point_id)
    if not p:
        raise HTTPException(status_code=404, detail="Punto no encontrado.")
    sources = []
    if not p.local_deleted:
        sources.append({"source": "local", "label": "Servidor (copia local)"})
    seen = set()
    for t in p.transfers:
        if t.status == "ok" and t.destination and t.destination_id not in seen:
            seen.add(t.destination_id)
            sources.append({"source": str(t.destination_id), "label": t.destination.name + (" (cifrado)" if t.destination.encrypt else "")})
    return {"point": {"id": p.id, "job": p.job.name, "repo": p.repo_name, "chain_label": p.chain_label, "seq": p.seq,
                      "kind": p.kind, "created_at": p.created_at.isoformat(), "is_db": p.repo_name == backup_jobs.DB_KEY,
                      "is_app": p.repo_name == backup_jobs.APP_KEY, "is_ext": restore_service.is_external(p.repo_name),
                      "ext_kind": _ext_kind(db, p.repo_name, RestorePayload(mode="verificar", point_id=p.id))
                      if restore_service.is_external(p.repo_name) else None,
                      "prefill": _prefill(db, p.repo_name)},
            "sources": sources}


def _prefill(db: Session, repo_name: str) -> dict:
    """Valores no secretos del sistema de origen para precargar el destino
    (mismo servidor, puerto y usuario); la base se sugiere con otro nombre."""
    src = db.query(models.ExternalSource).filter_by(folder_key=repo_name).first()
    if not src:
        return {}
    cfg = external_sources.load_config(src)
    keep = {k: cfg[k] for k in ("host", "port", "tls", "sslmode", "protocol", "verify_cert", "db_host", "db_port", "db_tls") if cfg.get(k)}
    base = cfg.get("database") or cfg.get("db_name") or "sitio"
    keep["database"] = re.sub(r"[^A-Za-z0-9_]", "_", f"{base}_restaurada_{datetime.now():%Y%m%d}")[:60]
    if src.kind == "wordpress":
        keep["wp_path"] = (cfg.get("wp_path") or "public_html").rstrip("/") + "-restaurado"
    return keep


@router.post("/restores", status_code=202)
def start_restore(payload: RestorePayload, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    if payload.mode not in ("verificar", "descargar", "subir", "aplicar", "nueva_base"):
        raise HTTPException(status_code=422, detail="Modo no valido.")
    if restore_service.is_busy():
        raise HTTPException(status_code=409, detail="Ya hay una restauracion en curso; espere a que termine.")

    if payload.point_id:
        p = db.get(models.BackupPoint, payload.point_id)
        if not p:
            raise HTTPException(status_code=404, detail="Punto no encontrado.")
        repo_name, seq = p.repo_name, p.seq
        if payload.source == "local":
            if p.local_deleted:
                raise HTTPException(status_code=409, detail="Ese punto ya no esta en el servidor; elija un destino externo.")
            dest, chain_path, label = None, f"{p.job_id}/{p.repo_name}/{p.chain_label}", "Servidor"
        else:
            try:
                dest = _destination(db, int(payload.source or ""))
            except ValueError:
                raise HTTPException(status_code=422, detail="Origen no valido.")
            t = next((t for t in p.transfers if t.destination_id == dest.id and t.status == "ok"), None)
            if not t:
                raise HTTPException(status_code=409, detail="Ese punto no esta confirmado en ese destino.")
            chain_path, label = t.remote_path, dest.name
    else:
        if not payload.destination_id or not payload.chain_path or payload.seq is None or payload.seq < 0:
            raise HTTPException(status_code=422, detail="Indique el destino, la cadena y el punto.")
        if not restore_service.valid_chain_path(payload.chain_path):
            raise HTTPException(status_code=422, detail="Ruta de cadena no valida.")
        dest = _destination(db, payload.destination_id)
        chain_path, label = payload.chain_path.strip("/"), dest.name
        repo_name, seq = chain_path.split("/")[1], payload.seq

    push = None
    target = None
    if payload.mode == "nueva_base":
        if not restore_service.is_external(repo_name):
            raise HTTPException(status_code=422, detail="Solo el respaldo de un sistema externo se restaura en una base nueva.")
        kind = _ext_kind(db, repo_name, payload)
        if not kind:
            raise HTTPException(status_code=422, detail="No se reconoce el tipo de respaldo de esa cadena.")
        target = {k: (v.strip() if isinstance(v, str) and k not in ("password", "db_password") else v)
                  for k, v in (payload.target or {}).items() if v not in (None, "")}
        problems = external_restore.validate_target(kind, target)
        src = db.query(models.ExternalSource).filter_by(folder_key=repo_name).first()
        if src and kind != "wordpress":
            cfg = external_sources.load_config(src)
            if target.get("host") == cfg.get("host") and target.get("database") == cfg.get("database"):
                problems.append("Esa es la base de origen: elija un nombre de base nuevo.")
        if problems:
            raise HTTPException(status_code=422, detail=" ".join(problems))
        target["_kind"] = kind
    if payload.mode == "aplicar":
        if repo_name != backup_jobs.APP_KEY:
            raise HTTPException(status_code=422, detail="Solo un respaldo de la aplicacion completa se restaura en la aplicacion.")
        if (payload.confirmacion or "").strip() != "RESTAURAR TODO":
            raise HTTPException(status_code=422, detail='Escriba exactamente "RESTAURAR TODO" para confirmar.')
    if payload.mode == "subir":
        if repo_name in (backup_jobs.DB_KEY, backup_jobs.APP_KEY) or restore_service.is_external(repo_name):
            raise HTTPException(status_code=422, detail="Esta copia no se sube a Git: use Descargar.")
        url = (payload.push_url or "").strip()
        problem = git_targets.validate_url(url)
        if problem:
            raise HTTPException(status_code=422, detail=problem)
        push = {"url": url, "user": (payload.push_user or "").strip(), "token": (payload.push_token or "").strip()}

    restore_service.cleanup_old(db)
    rr = models.RestoreRun(destination_id=dest.id if dest else None, source_label=label, chain_path=chain_path,
                           repo_name=repo_name, seq=seq, mode=payload.mode)
    db.add(rr)
    db.commit()
    db.refresh(rr)
    background_tasks.add_task(restore_service.run_restore, rr.id, push, target)
    dest_txt = f" hacia {git_service.strip_credentials(push['url'])}" if push else ""
    return {"id": rr.id, "message": f"Restauracion #{rr.id} iniciada{dest_txt}; el avance aparece en el historial."}


def _ext_kind(db: Session, repo_name: str, payload: RestorePayload) -> str | None:
    src = db.query(models.ExternalSource).filter_by(folder_key=repo_name).first()
    if src:
        return src.kind
    if payload.point_id:
        p = db.get(models.BackupPoint, payload.point_id)
        return external_restore.kind_of_files([f["name"] for f in json.loads(p.files_json)]) if p else None
    return (payload.target or {}).get("_kind_hint") if (payload.target or {}).get("_kind_hint") in external_restore.RESTORE_FIELDS else None


@router.get("/restore-targets/fields")
def restore_target_fields():
    return {"fields": external_restore.RESTORE_FIELDS}


@router.get("/restores/{restore_id}/log")
def download_log(restore_id: int, db: Session = Depends(get_db)):
    """El log completo (con el mapa del error si fallo) como archivo."""
    rr = db.get(models.RestoreRun, restore_id)
    if not rr:
        raise HTTPException(status_code=404, detail="Restauracion no encontrada.")
    steps = "".join(f"  [{st['status']}] {st['name']}" + (f" - {st['detail']}" if st.get("detail") else "") + "\n"
                    for st in json.loads(rr.steps_json or "[]"))
    head = (f"Restauracion #{rr.id} - modo {rr.mode} - estado {rr.status} - avance {rr.progress}%\n"
            f"Origen: {rr.source_label} / {rr.chain_path} (punto #{rr.seq})\n"
            f"Inicio: {rr.created_at:%Y-%m-%d %H:%M:%S} UTC  Fin: {rr.finished_at or '-'}\n\n"
            f"Pasos:\n{steps}\nLog:\n")
    return PlainTextResponse(head + (rr.log or ""), headers={"Content-Disposition": f'attachment; filename="restauracion_{rr.id}.log"'})


@router.get("/restores")
def list_restores(db: Session = Depends(get_db)):
    return [_out(r) for r in db.query(models.RestoreRun).order_by(models.RestoreRun.id.desc()).limit(30).all()]


@router.get("/restores/{restore_id}")
def get_restore(restore_id: int, db: Session = Depends(get_db)):
    rr = db.get(models.RestoreRun, restore_id)
    if not rr:
        raise HTTPException(status_code=404, detail="Restauracion no encontrada.")
    return _out(rr)


@router.get("/restores/{restore_id}/archivo/{name}")
def download_output(restore_id: int, name: str, db: Session = Depends(get_db)):
    rr = db.get(models.RestoreRun, restore_id)
    if not rr or name not in {o["name"] for o in json.loads(rr.outputs_json or "[]")}:
        raise HTTPException(status_code=404, detail="Archivo no disponible (se borra a los 3 dias).")
    path = restore_service.restore_dir(restore_id) / name
    if not path.exists():
        raise HTTPException(status_code=404, detail="Archivo no disponible (se borra a los 3 dias).")
    return FileResponse(str(path), filename=name, media_type="application/octet-stream")
