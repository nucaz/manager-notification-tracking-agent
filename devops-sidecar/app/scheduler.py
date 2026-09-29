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
    if ok:
        from .services import git_targets  # import diferido, igual que backup_jobs

        git_targets.run_after_sync(repo_id)


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


DIAS = {"mon": "lunes", "tue": "martes", "wed": "miercoles", "thu": "jueves", "fri": "viernes", "sat": "sabado", "sun": "domingo"}


def _backup_job_id(job_id: int) -> str:
    return f"backup_job_{job_id}"


def backup_trigger(job: models.BackupJob) -> CronTrigger:
    """Trigger de un trabajo de respaldo. Lanza ValueError con un mensaje
    claro si la programacion no es valida (la API lo muestra al guardar)."""
    tz = scheduler.timezone
    if job.frequency == "daily":
        return CronTrigger(hour=job.hour, minute=job.minute, timezone=tz)
    if job.frequency == "weekly":
        return CronTrigger(day_of_week=job.day_of_week, hour=job.hour, minute=job.minute, timezone=tz)
    if job.frequency == "monthly":
        return CronTrigger(day=job.day_of_month, hour=job.hour, minute=job.minute, timezone=tz)
    if job.frequency == "cron":
        try:
            return CronTrigger.from_crontab(job.cron_expr or "", timezone=tz)
        except ValueError as e:
            raise ValueError(f"Expresion cron no valida ('{job.cron_expr}'): use 5 campos, ej. '0 2 * * 1-5'.") from e
    raise ValueError(f"Frecuencia desconocida: {job.frequency}")


def describe_schedule(job: models.BackupJob) -> str:
    hhmm = f"{job.hour:02d}:{job.minute:02d}"
    if job.frequency == "daily":
        return f"Todos los dias a las {hhmm}"
    if job.frequency == "weekly":
        return f"Cada {DIAS.get(job.day_of_week, job.day_of_week)} a las {hhmm}"
    if job.frequency == "monthly":
        return f"El dia {job.day_of_month} de cada mes a las {hhmm}"
    return f"Cron: {job.cron_expr}"


def schedule_backup_job(job: models.BackupJob) -> None:
    from .services import backup_jobs  # import diferido: backup_jobs importa database/models

    if not job.enabled:
        unschedule_backup_job(job.id)
        return
    scheduler.add_job(
        backup_jobs.run_job,
        trigger=backup_trigger(job),
        id=_backup_job_id(job.id),
        args=[job.id],
        replace_existing=True,
        max_instances=1,
        coalesce=True,
        misfire_grace_time=3600,
    )


def unschedule_backup_job(job_id: int) -> None:
    job = scheduler.get_job(_backup_job_id(job_id))
    if job:
        job.remove()


def next_backup_run(job_id: int):
    job = scheduler.get_job(_backup_job_id(job_id))
    return getattr(job, "next_run_time", None) if job else None


def start_scheduler() -> None:
    db = SessionLocal()
    try:
        repos = db.query(models.Repo).filter(models.Repo.active.is_(True)).all()
        for repo in repos:
            schedule_repo_sync(repo)
        for job in db.query(models.BackupJob).filter(models.BackupJob.enabled.is_(True)).all():
            try:
                schedule_backup_job(job)
            except ValueError as e:
                logger.error("Trabajo de respaldo '%s' sin programar: %s", job.name, e)
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
