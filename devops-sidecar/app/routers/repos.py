import tempfile
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import models, schemas, scheduler, scoring
from ..auth import require_dashboard_auth
from ..config import settings
from ..database import get_db
from ..services import ai_client, audit_engine, backup_service, git_service

router = APIRouter(prefix="/api/repos", tags=["repos"], dependencies=[Depends(require_dashboard_auth)])


@router.get("", response_model=list[schemas.RepoOut])
def list_repos(db: Session = Depends(get_db)):
    return db.query(models.Repo).order_by(models.Repo.name).all()


@router.get("/{repo_id}/commits-hoy")
def commits_hoy(repo_id: int, db: Session = Depends(get_db)):
    """Commits/lineas de HOY por autor, sin correr la auditoria de IA
    (rapido, sin costo) - lo usa el chatbot para 'verificar los commits
    del dia' sin tener que disparar un analisis completo. Refresca las
    stats con git antes de responder, para que quede al dia aunque
    todavia no haya corrido la auditoria de hoy."""
    import datetime

    repo = db.get(models.Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repositorio no encontrado.")
    if (Path(repo.local_path) / ".git").exists():
        git_service.update_commit_stats(db, repo)
    rows = (
        db.query(models.CommitStat)
        .filter(models.CommitStat.repo_id == repo_id, models.CommitStat.commit_date == datetime.date.today())
        .order_by(models.CommitStat.commits_count.desc())
        .all()
    )
    return {
        "repo": repo.name,
        "authors": [
            {"author": r.author, "commits": r.commits_count, "lines_added": r.lines_added, "lines_deleted": r.lines_deleted}
            for r in rows
        ],
    }


@router.get("/{repo_id}/reports/latest")
def latest_report(repo_id: int, db: Session = Depends(get_db)):
    """Ultimo reporte de auditoria IA de este repo, en texto plano - lo
    usa el chatbot (WhatsApp/Telegram) para responder sin tener que
    renderizar HTML/Markdown."""
    repo = db.get(models.Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repositorio no encontrado.")
    report = (
        db.query(models.AuditReport)
        .filter(models.AuditReport.repo_id == repo_id)
        .order_by(models.AuditReport.created_at.desc())
        .first()
    )
    if not report:
        return {"repo": repo.name, "found": False}
    return {
        "repo": repo.name,
        "found": True,
        "report_date": report.report_date.isoformat(),
        "ai_provider_used": report.ai_provider_used,
        "report_markdown": report.report_markdown,
    }


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


@router.post("/{repo_id}/audit-now")
async def audit_now(repo_id: int, db: Session = Depends(get_db)):
    """Corre la auditoria de IA de este repo de inmediato (sin esperar al
    ciclo diario de las 18:00) - util para probar la configuracion de IA
    o revisar los cambios de hoy en el momento."""
    repo = db.get(models.Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repositorio no encontrado.")
    if not (Path(repo.local_path) / ".git").exists():
        raise HTTPException(
            status_code=409,
            detail="Todavía no se sincronizó este repositorio. Dale \"Sincronizar\" primero y espera a que termine.",
        )
    git_service.update_commit_stats(db, repo)
    report = await audit_engine.run_audit_for_repo(db, repo)
    return {"report_id": report.id}


@router.post("/{repo_id}/backup-now")
def backup_now(repo_id: int, backup_type: str = "diario", db: Session = Depends(get_db)):
    """Corre un respaldo de inmediato, sin esperar al horario programado.
    'diario' = diff de los commits recientes; 'completo' = mirror git
    comprimido (.tar.gz, solo lo puede leer git, pesa menos); 'archivos'
    = los archivos reales del working tree tal cual, comprimidos (mas
    pesado, pero se puede abrir sin git)."""
    repo = db.get(models.Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repositorio no encontrado.")
    if not (Path(repo.local_path) / ".git").exists():
        raise HTTPException(status_code=409, detail="Todavía no se sincronizó este repositorio. Dale \"Sincronizar\" primero.")

    if backup_type == "completo":
        source_stats = backup_service.working_tree_stats(repo.local_path)
        try:
            tar_path = backup_service.run_weekly_mirror(repo)
        except RuntimeError as e:
            raise HTTPException(status_code=500, detail=f"Fallo el respaldo completo: {e}")
        run = models.BackupRun(
            repo_id=repo.id, backup_type="weekly_mirror",
            file_path=str(tar_path), size_bytes=tar_path.stat().st_size,
        )
        db.add(run)
        db.commit()
        db.refresh(run)
        return {
            "backup_id": run.id,
            "file_path": str(tar_path),
            "tar_size_bytes": tar_path.stat().st_size,
            "source_files": source_stats["files"],
            "source_bytes": source_stats["bytes"],
        }

    if backup_type == "archivos":
        source_stats = backup_service.working_tree_stats(repo.local_path)
        tar_path = backup_service.run_full_content_backup(repo)
        run = models.BackupRun(
            repo_id=repo.id, backup_type="full_content",
            file_path=str(tar_path), size_bytes=tar_path.stat().st_size,
        )
        db.add(run)
        db.commit()
        db.refresh(run)
        return {
            "backup_id": run.id,
            "file_path": str(tar_path),
            "tar_size_bytes": tar_path.stat().st_size,
            "source_files": source_stats["files"],
            "source_bytes": source_stats["bytes"],
        }

    diff_text = git_service.get_daily_diff(repo.local_path)
    if not diff_text.strip():
        raise HTTPException(
            status_code=409,
            detail="No hay commits recientes (últimas 24h) que respaldar como diferencial. Usa \"Respaldo completo\" para un mirror total del repo tal como está ahora.",
        )
    stats = backup_service.diff_stats(diff_text)
    run = backup_service.save_daily_diff(db, repo, diff_text)
    return {
        "backup_id": run.id,
        "file_path": run.file_path,
        "commits": stats["commits"],
        "files": stats["files"],
    }


@router.post("/{repo_id}/backups/{backup_id}/restore")
def restore_backup(repo_id: int, backup_id: int, db: Session = Depends(get_db)):
    """Restaura un respaldo SOBRE el clon local actual - es destructivo
    (reemplaza lo que haya ahora), por eso pausa el auto-sync del repo
    despues (si no, el proximo ciclo de sincronizacion lo deshace solo)."""
    repo = db.get(models.Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repositorio no encontrado.")
    run = db.get(models.BackupRun, backup_id)
    if not run or run.repo_id != repo_id:
        raise HTTPException(status_code=404, detail="Respaldo no encontrado para este repositorio.")
    if not Path(run.file_path).exists():
        raise HTTPException(status_code=410, detail="El archivo de respaldo ya no existe en disco.")

    try:
        if run.backup_type == "weekly_mirror":
            backup_service.restore_from_mirror(run.file_path, repo)
        elif run.backup_type == "full_content":
            backup_service.restore_full_content(run.file_path, repo)
        else:
            raise HTTPException(status_code=400, detail="Este tipo de respaldo (diferencial) no se puede restaurar directamente — es un diff de texto, no una copia completa.")
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=f"Fallo la restauración: {e}")

    scheduler.unschedule_repo_sync(repo_id)
    repo.active = False
    repo.last_sync_status = f"Restaurado desde respaldo #{run.id} ({run.backup_type}) — auto-sync pausado"
    db.commit()
    return {"ok": True, "message": "Restaurado. El auto-sync de este repo quedó pausado para no perder la restauración."}


class RollbackPayload(BaseModel):
    sha: str


@router.post("/{repo_id}/rollback")
def rollback(repo_id: int, payload: RollbackPayload, db: Session = Depends(get_db)):
    """Deja el CLON LOCAL como estaba en ese commit, para inspeccionar o
    probar antes de decidir si se revierte de verdad. Pausa el auto-sync
    del repo (si no, el proximo ciclo lo deshace)."""
    repo = db.get(models.Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repositorio no encontrado.")
    try:
        git_service.rollback_local_to_commit(repo.local_path, payload.sha)
    except git_service.GitError as e:
        raise HTTPException(status_code=400, detail=str(e))

    scheduler.unschedule_repo_sync(repo_id)
    repo.active = False
    repo.last_sync_status = f"Rollback local a {payload.sha[:10]} — auto-sync pausado"
    db.commit()
    return {"ok": True, "message": "Clon local llevado a ese commit. El auto-sync quedó pausado."}


@router.post("/{repo_id}/reanudar-sync")
def reanudar_sync(repo_id: int, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Deshace una pausa por rollback/restore: vuelve a activar el
    auto-sync y de inmediato sincroniza con el remoto real (fetch +
    reset --hard origin/rama), devolviendo el clon a la punta actual."""
    repo = db.get(models.Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repositorio no encontrado.")
    repo.active = True
    db.commit()
    scheduler.schedule_repo_sync(repo)
    background_tasks.add_task(scheduler.sync_repo_job, repo.id)
    return {"ok": True, "message": "Auto-sync reanudado — sincronizando con el remoto ahora mismo."}


class RevertPayload(BaseModel):
    sha: str


@router.post("/{repo_id}/commits/{sha}/resumir")
async def resumir_commit(repo_id: int, sha: str, forzar: bool = False, db: Session = Depends(get_db)):
    """Resumen itemizado de UN commit, generado por IA a pedido. Se cachea
    en commit_summaries - si ya se pidio antes, se devuelve sin volver a
    llamar a la IA (a menos que se pida ?forzar=true)."""
    repo = db.get(models.Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repositorio no encontrado.")

    if not forzar:
        cached = (
            db.query(models.CommitSummary)
            .filter(models.CommitSummary.repo_id == repo_id, models.CommitSummary.commit_sha == sha)
            .first()
        )
        if cached:
            return {"summary": cached.summary_markdown, "provider": cached.ai_provider_used, "cached": True}

    try:
        diff = git_service.show_commit(repo.local_path, sha)
    except git_service.GitError as e:
        raise HTTPException(status_code=400, detail=str(e))

    prompt = f"""Eres un auditor tecnico. A continuacion el diff completo (git show) de UN SOLO commit del repositorio "{repo.name}":

```diff
{diff[:settings.max_diff_chars]}
```

Responde EN ESPAÑOL, en Markdown, con una lista de puntos (bullets) CONCISA de los cambios importantes de ESTE commit - que se agrego, modifico o elimino, y en que archivo/funcion cuando el diff lo permita. Maximo 8 puntos. Si es un cambio trivial (typo, formato), dilo en un solo punto."""

    try:
        summary = await ai_client.generate(prompt)
        provider = settings.ai_provider
    except ai_client.AIClientError as e:
        raise HTTPException(status_code=502, detail=f"No se pudo generar el resumen: {e}")

    existing = (
        db.query(models.CommitSummary)
        .filter(models.CommitSummary.repo_id == repo_id, models.CommitSummary.commit_sha == sha)
        .first()
    )
    if existing:
        existing.summary_markdown = summary
        existing.ai_provider_used = provider
    else:
        db.add(models.CommitSummary(repo_id=repo_id, commit_sha=sha, summary_markdown=summary, ai_provider_used=provider))
    db.commit()

    return {"summary": summary, "provider": provider, "cached": False}


@router.post("/{repo_id}/commits/{sha}/revertir-local")
def revertir_local(repo_id: int, sha: str, db: Session = Depends(get_db)):
    """Crea un commit nuevo en el CLON LOCAL que deshace ese commit (git
    revert). No toca GitHub todavia - eso es el paso siguiente (push),
    separado a proposito para poder revisar el resultado antes de subirlo."""
    repo = db.get(models.Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repositorio no encontrado.")
    try:
        new_sha = git_service.revert_commit_local(repo.local_path, sha)
    except git_service.GitError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"ok": True, "new_commit": new_sha}


@router.post("/{repo_id}/push")
def push_to_github(repo_id: int, db: Session = Depends(get_db)):
    """Sube el clon local a GitHub de verdad (git push). Requiere que el
    token del repo tenga permiso de escritura. Accion irreversible sobre
    el repositorio remoto real — pensada para confirmarse explícitamente
    desde la interfaz antes de llamarse."""
    repo = db.get(models.Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repositorio no encontrado.")
    branch = git_service.current_branch(repo.local_path)
    ok, detail = git_service.push_branch(repo, branch)
    if not ok:
        raise HTTPException(status_code=502, detail=f"El push a GitHub falló: {detail}")
    return {"ok": True, "branch": branch, "detail": detail}


@router.get("/{repo_id}/commits/{sha}/descargar")
def descargar_commit(repo_id: int, sha: str, db: Session = Depends(get_db)):
    """Descarga el codigo TAL COMO ESTABA en ese commit (git archive) -
    de solo lectura, no modifica el clon local para nada."""
    repo = db.get(models.Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repositorio no encontrado.")
    tmp = tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False)
    tmp.close()
    try:
        git_service.archive_commit(repo.local_path, sha, tmp.name)
    except git_service.GitError as e:
        Path(tmp.name).unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=str(e))
    cleanup = BackgroundTasks()
    cleanup.add_task(lambda: Path(tmp.name).unlink(missing_ok=True))
    filename = f"{repo.name}_{sha[:10]}.tar.gz"
    return FileResponse(tmp.name, filename=filename, media_type="application/gzip", background=cleanup)


@router.delete("/{repo_id}", status_code=204)
def delete_repo(repo_id: int, db: Session = Depends(get_db)):
    repo = db.get(models.Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repositorio no encontrado.")
    scheduler.unschedule_repo_sync(repo_id)
    db.delete(repo)
    db.commit()
    return None
