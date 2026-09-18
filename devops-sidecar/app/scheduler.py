"""Orquestacion en segundo plano con APScheduler (dentro del mismo
proceso de FastAPI - un solo contenedor, sin necesidad de un worker
aparte). Tres tipos de tarea:
1. Sincronizacion de cada repo, a SU PROPIO intervalo (minutos/horas) -
   se agrega/quita un job dinamicamente cuando se crea/borra un repo.
2. Auditoria diaria con IA + respaldo diferencial diario, a una hora fija
   (por defecto 18:00, configurable).
3. Respaldo semanal (mirror completo comprimido) + limpieza por
   retencion, a un dia/hora fijos (por defecto domingo 02:00).
"""
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from . import models
from .config import settings
from .database import SessionLocal
from .services import audit_engine, backup_service, git_service

logger = logging.getLogger("scheduler")
scheduler = AsyncIOScheduler(timezone="America/Lima")


def _sync_job_id(repo_id: int) -> str:
    return f"sync_repo_{repo_id}"


def sync_repo_job(repo_id: int) -> None:
    """Sincroniza este repo YA - lo llaman tanto el scheduler periodico
    como un click manual de 'Sincronizar'/'Reanudar sync'. Un repo pausado
    (active=False) ya esta desprogramado del scheduler periodico (ver
    unschedule_repo_sync), asi que aqui NO se vuelve a filtrar por
    `active` - si alguien lo llama a mano (ej. justo al reanudar), debe
    ejecutar igual."""
    db = SessionLocal()
    try:
        repo = db.get(models.Repo, repo_id)
        if not repo:
            return
        ok, detail = git_service.sync_repo(repo)
        repo.last_sync_status = ("OK: " if ok else "ERROR: ") + detail
        from datetime import datetime

        repo.last_synced_at = datetime.utcnow()
        db.commit()
        logger.info("Sync %s: %s", repo.name, repo.last_sync_status)
    finally:
        db.close()


def schedule_repo_sync(repo: models.Repo) -> None:
    scheduler.add_job(
        sync_repo_job,
        trigger=IntervalTrigger(minutes=repo.sync_interval_minutes),
        id=_sync_job_id(repo.id),
        args=[repo.id],
        replace_existing=True,
    )


def unschedule_repo_sync(repo_id: int) -> None:
    job = scheduler.get_job(_sync_job_id(repo_id))
    if job:
        job.remove()


async def daily_job() -> None:
    db = SessionLocal()
    try:
        await audit_engine.run_daily_audit_all(db)
        backup_service.run_daily_backup_all(db)
    finally:
        db.close()


def weekly_job() -> None:
    db = SessionLocal()
    try:
        backup_service.run_weekly_backup_all(db)
    finally:
        db.close()


def start_scheduler() -> None:
    db = SessionLocal()
    try:
        repos = db.query(models.Repo).filter(models.Repo.active.is_(True)).all()
        for repo in repos:
            schedule_repo_sync(repo)
    finally:
        db.close()

    scheduler.add_job(
        daily_job,
        trigger=CronTrigger(hour=settings.audit_hour, minute=settings.audit_minute),
        id="daily_audit_and_backup",
        replace_existing=True,
    )
    scheduler.add_job(
        weekly_job,
        trigger=CronTrigger(day_of_week=settings.weekly_backup_day_of_week, hour=settings.weekly_backup_hour),
        id="weekly_backup",
        replace_existing=True,
    )
    scheduler.start()
    logger.info(
        "Scheduler activo: auditoria diaria %02d:%02d, respaldo semanal %s %02d:00, %d repo(s) sincronizandose.",
        settings.audit_hour, settings.audit_minute,
        settings.weekly_backup_day_of_week, settings.weekly_backup_hour,
        len(repos),
    )
