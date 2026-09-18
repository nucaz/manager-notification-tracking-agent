"""Asistente de IA embebido en cada pantalla del dashboard: arma el
contexto real de esa pantalla (datos de la base de datos, no
alucinados) y se lo pasa junto con la pregunta del usuario al proveedor
de IA configurado (Gemini/Claude/Ollama, ver Configuracion). Es de solo
lectura - nunca ejecuta ninguna accion, solo responde preguntas."""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models, scoring
from ..auth import require_dashboard_auth
from ..database import get_db
from ..services import ai_client

router = APIRouter(prefix="/api/asistente", tags=["asistente"], dependencies=[Depends(require_dashboard_auth)])


class AsistentePayload(BaseModel):
    contexto: str
    pregunta: str
    repo_id: int | None = None
    period: str | None = None


def _build_context_text(db: Session, payload: AsistentePayload) -> str:
    if payload.contexto == "leaderboard":
        period = payload.period if payload.period in scoring.PERIODS else "week"
        rows = scoring.leaderboard(db, period=period)
        if not rows:
            return f"Leaderboard de desarrolladores, periodo '{period}': sin actividad registrada."
        lineas = "\n".join(
            f"- {r.author}: {r.commits} commits, +{r.lines_added}/-{r.lines_deleted} lineas, {r.score} pts"
            for r in rows
        )
        return f"Leaderboard de desarrolladores (periodo: {period}):\n{lineas}"

    if payload.contexto == "repos":
        repos = db.query(models.Repo).order_by(models.Repo.name).all()
        if not repos:
            return "No hay repositorios registrados en DevOps Sidecar."
        lineas = "\n".join(
            f"- {r.name} ({r.github_url}): {'activo' if r.active else 'PAUSADO (rollback/restore en curso)'}, "
            f"sincroniza cada {r.sync_interval_minutes} min, ultimo sync: {r.last_synced_at}, resultado: {r.last_sync_status}"
            for r in repos
        )
        return f"Repositorios registrados:\n{lineas}"

    if payload.contexto == "repo_detail":
        if not payload.repo_id:
            raise HTTPException(status_code=400, detail="Falta repo_id.")
        repo = db.get(models.Repo, payload.repo_id)
        if not repo:
            raise HTTPException(status_code=404, detail="Repositorio no encontrado.")
        today_stats = (
            db.query(models.CommitStat)
            .filter(models.CommitStat.repo_id == repo.id, models.CommitStat.commit_date == date.today())
            .all()
        )
        stats_txt = "\n".join(
            f"- {s.author}: {s.commits_count} commits, +{s.lines_added}/-{s.lines_deleted} lineas"
            for s in today_stats
        ) or "sin commits registrados hoy"
        latest_report = (
            db.query(models.AuditReport)
            .filter(models.AuditReport.repo_id == repo.id)
            .order_by(models.AuditReport.created_at.desc())
            .first()
        )
        reporte_txt = latest_report.report_markdown[:4000] if latest_report else "todavia no hay ninguna auditoria de IA para este repo"
        return (
            f"Repositorio: {repo.name} ({repo.github_url})\n"
            f"Estado: {'activo' if repo.active else 'PAUSADO'}, ultimo sync: {repo.last_synced_at}, resultado: {repo.last_sync_status}\n\n"
            f"Commits de HOY:\n{stats_txt}\n\n"
            f"Ultimo reporte de auditoria de IA:\n{reporte_txt}"
        )

    if payload.contexto == "deployments":
        deployments = db.query(models.Deployment).order_by(models.Deployment.received_at.desc()).limit(30).all()
        if not deployments:
            return "Sin despliegues registrados todavia (webhook de Coolify, POST /webhooks/coolify)."
        lineas = "\n".join(
            f"- {d.received_at}: proyecto={d.project}, aplicacion={d.application_name}, "
            f"entorno={d.environment}, estado={d.status}"
            for d in deployments
        )
        return f"Ultimos despliegues recibidos de Coolify:\n{lineas}"

    if payload.contexto == "reportes":
        reports = db.query(models.AuditReport).order_by(models.AuditReport.created_at.desc()).limit(8).all()
        if not reports:
            return "Sin auditorias de IA generadas todavia en ningun repositorio."
        bloques = "\n\n".join(
            f"[{r.repo.name if r.repo else r.repo_id} - {r.report_date}, proveedor {r.ai_provider_used or '?'}]\n{r.report_markdown[:1500]}"
            for r in reports
        )
        return f"Ultimos reportes de auditoria de IA:\n{bloques}"

    if payload.contexto == "backups":
        runs = db.query(models.BackupRun).order_by(models.BackupRun.created_at.desc()).limit(30).all()
        if not runs:
            return "Sin respaldos generados todavia."
        lineas = "\n".join(
            f"- {r.created_at}: repo={r.repo.name if r.repo else r.repo_id}, tipo={r.backup_type}, "
            f"tamano={round(r.size_bytes / 1024, 1) if r.size_bytes else '?'} KB"
            for r in runs
        )
        return f"Historial de respaldos:\n{lineas}"

    if payload.contexto == "analitica":
        desde = date.today() - timedelta(days=29)
        total = db.query(models.Deployment).count()
        exitosos = db.query(models.Deployment).filter(models.Deployment.status.ilike("%success%")).count()
        fallidos = db.query(models.Deployment).filter(models.Deployment.status.ilike("%fail%")).count()
        repos = db.query(models.Repo).order_by(models.Repo.name).all()
        lineas = []
        for repo in repos:
            agg = (
                db.query(
                    func.coalesce(func.sum(models.CommitStat.commits_count), 0),
                    func.coalesce(func.sum(models.CommitStat.lines_added), 0),
                    func.coalesce(func.sum(models.CommitStat.lines_deleted), 0),
                )
                .filter(models.CommitStat.repo_id == repo.id, models.CommitStat.commit_date >= desde)
                .first()
            )
            commits, add, delete = agg
            lineas.append(f"- {repo.name}: {commits} commits, +{add}/-{delete} lineas (ultimos 30 dias)")
        return (
            f"Despliegues (historico): {total} total, {exitosos} exitosos, {fallidos} fallidos.\n\n"
            f"Actividad por repositorio (ultimos 30 dias):\n" + ("\n".join(lineas) if lineas else "sin repositorios registrados")
        )

    raise HTTPException(status_code=400, detail=f"Contexto de pantalla desconocido: '{payload.contexto}'.")


@router.post("")
async def preguntar(payload: AsistentePayload, db: Session = Depends(get_db)):
    contexto_texto = _build_context_text(db, payload)
    prompt = f"""Eres el asistente integrado del dashboard de DevOps Sidecar (audita repositorios de GitHub, calcula un leaderboard, recibe despliegues de Coolify, hace respaldos). Respondes EN ESPAÑOL, breve y directo, basandote EXCLUSIVAMENTE en estos datos reales de la pantalla actual - si la pregunta no se puede responder con esta informacion, dilo explicitamente en vez de inventar algo.

Datos de esta pantalla:
{contexto_texto}

Pregunta del usuario: "{payload.pregunta}\""""
    try:
        respuesta = await ai_client.generate(prompt)
    except ai_client.AIClientError as e:
        raise HTTPException(status_code=502, detail=f"No se pudo consultar la IA: {e}")
    return {"respuesta": respuesta}
