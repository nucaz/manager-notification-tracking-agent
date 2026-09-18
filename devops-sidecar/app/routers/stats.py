from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models, schemas, scoring
from ..auth import require_dashboard_auth
from ..database import get_db

router = APIRouter(prefix="/api", tags=["stats"], dependencies=[Depends(require_dashboard_auth)])


@router.get("/leaderboard", response_model=list[schemas.LeaderboardRow])
def leaderboard(period: str = "week", db: Session = Depends(get_db)):
    if period not in scoring.PERIODS:
        period = "week"
    return scoring.leaderboard(db, period=period)


@router.get("/resumen")
def resumen(db: Session = Depends(get_db)):
    """Resumen general de todo el modulo (repos, despliegues, respaldos,
    auditorias de hoy) en una sola llamada - lo usa el chatbot de
    WhatsApp/Telegram para responder preguntas amplias sin tener que
    encadenar varias herramientas."""
    total_repos = db.query(models.Repo).count()

    total_deployments = db.query(models.Deployment).count()
    exitosos = db.query(models.Deployment).filter(models.Deployment.status.ilike("%success%")).count()
    fallidos = db.query(models.Deployment).filter(models.Deployment.status.ilike("%fail%")).count()

    total_backups = db.query(models.BackupRun).count()
    backups_por_tipo = dict(
        db.query(models.BackupRun.backup_type, func.count(models.BackupRun.id))
        .group_by(models.BackupRun.backup_type)
        .all()
    )
    ultimo_backup = db.query(models.BackupRun).order_by(models.BackupRun.created_at.desc()).first()

    auditorias_hoy = (
        db.query(models.AuditReport).filter(models.AuditReport.report_date == date.today()).all()
    )

    return {
        "total_repos": total_repos,
        "deployments": {"total": total_deployments, "exitosos": exitosos, "fallidos": fallidos},
        "backups": {
            "total": total_backups,
            "por_tipo": backups_por_tipo,
            "ultimo": {
                "repo": ultimo_backup.repo.name if ultimo_backup and ultimo_backup.repo else None,
                "tipo": ultimo_backup.backup_type,
                "fecha": ultimo_backup.created_at.isoformat(),
            } if ultimo_backup else None,
        },
        "auditorias_hoy": [
            {"repo": a.repo.name if a.repo else a.repo_id, "provider": a.ai_provider_used}
            for a in auditorias_hoy
        ],
    }
