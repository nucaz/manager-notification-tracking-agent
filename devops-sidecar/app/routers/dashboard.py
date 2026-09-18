from datetime import date, timedelta
from pathlib import Path

import bleach
import markdown as md
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models, scoring
from ..auth import require_dashboard_auth
from ..config import settings
from ..database import get_db
from ..services import git_service

DIAS_SEMANA = {
    "mon": "lunes", "tue": "martes", "wed": "miércoles", "thu": "jueves",
    "fri": "viernes", "sat": "sábado", "sun": "domingo",
}

router = APIRouter(dependencies=[Depends(require_dashboard_auth)])
templates = Jinja2Templates(directory="app/templates")

# El reporte lo escribe la IA a partir de un diff de codigo de terceros -
# no es HTML de confianza. Se sanea despues de convertir Markdown->HTML
# (permitiendo solo tags de presentacion) para que una inyeccion de
# prompt en un commit/comentario no pueda terminar ejecutando <script>
# en el navegador de quien lea el reporte.
ALLOWED_TAGS = [
    "p", "br", "h1", "h2", "h3", "h4", "ul", "ol", "li", "strong", "em",
    "code", "pre", "blockquote", "a", "table", "thead", "tbody", "tr", "th", "td", "hr",
]
ALLOWED_ATTRS = {"a": ["href", "title", "rel"]}


def render_report_html(markdown_text: str) -> str:
    raw_html = md.markdown(markdown_text, extensions=["fenced_code", "tables"])
    return bleach.clean(raw_html, tags=ALLOWED_TAGS, attributes=ALLOWED_ATTRS, strip=True)


@router.get("/", response_class=HTMLResponse)
def home(request: Request, period: str = "week", db: Session = Depends(get_db)):
    if period not in scoring.PERIODS:
        period = "week"
    rows = scoring.leaderboard(db, period=period)
    repos_count = db.query(models.Repo).count()
    deployments_count = db.query(models.Deployment).count()
    recent_deployments = (
        db.query(models.Deployment).order_by(models.Deployment.received_at.desc()).limit(5).all()
    )
    return templates.TemplateResponse(
        "dashboard.html",
        {
            "request": request,
            "period": period,
            "periods": scoring.PERIODS,
            "rows": rows,
            "repos_count": repos_count,
            "deployments_count": deployments_count,
            "recent_deployments": recent_deployments,
        },
    )


@router.get("/repos", response_class=HTMLResponse)
def repos_page(request: Request, db: Session = Depends(get_db)):
    repos = db.query(models.Repo).order_by(models.Repo.name).all()
    return templates.TemplateResponse("repos.html", {"request": request, "repos": repos})


@router.get("/repos/{repo_id}", response_class=HTMLResponse)
def repo_detail(request: Request, repo_id: int, db: Session = Depends(get_db)):
    repo = db.get(models.Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repositorio no encontrado.")
    today_stats = (
        db.query(models.CommitStat)
        .filter(models.CommitStat.repo_id == repo_id, models.CommitStat.commit_date == date.today())
        .order_by(models.CommitStat.commits_count.desc())
        .all()
    )
    latest_reports = (
        db.query(models.AuditReport)
        .filter(models.AuditReport.repo_id == repo_id)
        .order_by(models.AuditReport.created_at.desc())
        .limit(5)
        .all()
    )
    cloned = (Path(repo.local_path) / ".git").exists()
    return templates.TemplateResponse(
        "repo_detail.html",
        {
            "request": request,
            "repo": repo,
            "today_stats": today_stats,
            "latest_reports": latest_reports,
            "cloned": cloned,
            "audit_hour": settings.audit_hour,
            "audit_minute": settings.audit_minute,
            "weekly_hour": settings.weekly_backup_hour,
            "weekly_day_label": DIAS_SEMANA.get(settings.weekly_backup_day_of_week, settings.weekly_backup_day_of_week),
            "retention_days": settings.backup_retention_days,
        },
    )


@router.get("/repos/{repo_id}/explorar", response_class=HTMLResponse)
def repo_browse(request: Request, repo_id: int, path: str = "", db: Session = Depends(get_db)):
    repo = db.get(models.Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repositorio no encontrado.")

    base = Path(repo.local_path).resolve()
    if not base.exists():
        raise HTTPException(status_code=409, detail="Todavía no se sincronizó este repositorio. Dale \"Sincronizar\" primero.")

    # Nunca dejar salir del directorio del repo (ej. path="../../etc") -
    # se resuelve la ruta pedida y se verifica que siga dentro de `base`.
    target = (base / path).resolve()
    if target != base and base not in target.parents:
        raise HTTPException(status_code=400, detail="Ruta inválida.")
    if not target.exists():
        raise HTTPException(status_code=404, detail="Esa ruta ya no existe (¿se movió o borró en el último sync?).")

    if target.is_file():
        try:
            content = target.read_text(encoding="utf-8", errors="replace")
            truncated = len(content) > 200_000
            if truncated:
                content = content[:200_000]
        except Exception:
            content = None
            truncated = False
        parent = str(Path(path).parent) if path and Path(path).parent != Path(".") else ""
        return templates.TemplateResponse(
            "repo_browse.html",
            {
                "request": request, "repo": repo, "rel_path": path, "is_file": True,
                "file_content": content, "file_truncated": truncated, "entries": [], "parent": parent,
            },
        )

    entries = []
    for item in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        if item.name == ".git":
            continue
        rel = str(item.relative_to(base))
        entries.append({
            "name": item.name,
            "is_dir": item.is_dir(),
            "path": rel,
            "size": item.stat().st_size if item.is_file() else None,
        })
    parent = None
    if path:
        parent_path = Path(path).parent
        parent = "" if str(parent_path) == "." else str(parent_path)
    return templates.TemplateResponse(
        "repo_browse.html",
        {
            "request": request, "repo": repo, "rel_path": path, "is_file": False,
            "entries": entries, "parent": parent, "file_content": None, "file_truncated": False,
        },
    )


@router.get("/repos/{repo_id}/commits", response_class=HTMLResponse)
def repo_commits(request: Request, repo_id: int, db: Session = Depends(get_db)):
    repo = db.get(models.Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repositorio no encontrado.")
    if not (Path(repo.local_path) / ".git").exists():
        raise HTTPException(status_code=409, detail="Todavía no se sincronizó este repositorio.")
    commits = git_service.list_commits(repo.local_path, limit=50)
    return templates.TemplateResponse(
        "repo_commits.html", {"request": request, "repo": repo, "commits": commits}
    )


@router.get("/repos/{repo_id}/commits/{sha}", response_class=HTMLResponse)
def repo_commit_detail(request: Request, repo_id: int, sha: str, db: Session = Depends(get_db)):
    repo = db.get(models.Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repositorio no encontrado.")
    try:
        diff = git_service.show_commit(repo.local_path, sha)
    except git_service.GitError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return templates.TemplateResponse(
        "repo_commit_detail.html", {"request": request, "repo": repo, "sha": sha, "diff": diff}
    )


@router.get("/deployments", response_class=HTMLResponse)
def deployments_page(request: Request, db: Session = Depends(get_db)):
    deployments = db.query(models.Deployment).order_by(models.Deployment.received_at.desc()).limit(200).all()
    return templates.TemplateResponse("deployments.html", {"request": request, "deployments": deployments})


@router.get("/reportes", response_class=HTMLResponse)
def reports_page(request: Request, repo_id: int | None = None, db: Session = Depends(get_db)):
    query = db.query(models.AuditReport).order_by(models.AuditReport.created_at.desc())
    if repo_id:
        query = query.filter(models.AuditReport.repo_id == repo_id)
    reports = query.limit(100).all()
    repos = db.query(models.Repo).order_by(models.Repo.name).all()
    return templates.TemplateResponse(
        "reports.html", {"request": request, "reports": reports, "repos": repos, "repo_id": repo_id}
    )


@router.get("/reportes/{report_id}", response_class=HTMLResponse)
def report_detail(request: Request, report_id: int, db: Session = Depends(get_db)):
    report = db.get(models.AuditReport, report_id)
    html = render_report_html(report.report_markdown) if report else ""
    return templates.TemplateResponse(
        "report_detail.html", {"request": request, "report": report, "report_html": html}
    )


@router.get("/backups", response_class=HTMLResponse)
def backups_page(request: Request, db: Session = Depends(get_db)):
    runs = db.query(models.BackupRun).order_by(models.BackupRun.created_at.desc()).limit(200).all()
    return templates.TemplateResponse(
        "backups.html",
        {
            "request": request,
            "runs": runs,
            "audit_hour": settings.audit_hour,
            "audit_minute": settings.audit_minute,
            "weekly_hour": settings.weekly_backup_hour,
            "weekly_day_label": DIAS_SEMANA.get(settings.weekly_backup_day_of_week, settings.weekly_backup_day_of_week),
            "retention_days": settings.backup_retention_days,
        },
    )


@router.get("/analitica", response_class=HTMLResponse)
def analitica_page(request: Request, dias: int = 30, db: Session = Depends(get_db)):
    dias = max(7, min(dias, 180))
    desde = date.today() - timedelta(days=dias - 1)

    # --- Despliegues (Coolify) ---
    total_deployments = db.query(models.Deployment).count()
    exitosos = db.query(models.Deployment).filter(models.Deployment.status.ilike("%success%")).count()
    fallidos = db.query(models.Deployment).filter(models.Deployment.status.ilike("%fail%")).count()
    otros = total_deployments - exitosos - fallidos
    tasa_exito = round((exitosos / total_deployments) * 100, 1) if total_deployments else None

    por_entorno = (
        db.query(models.Deployment.environment, func.count(models.Deployment.id))
        .group_by(models.Deployment.environment)
        .order_by(func.count(models.Deployment.id).desc())
        .all()
    )
    por_proyecto = (
        db.query(models.Deployment.project, func.count(models.Deployment.id))
        .group_by(models.Deployment.project)
        .order_by(func.count(models.Deployment.id).desc())
        .limit(10)
        .all()
    )
    despliegues_por_dia = (
        db.query(func.date(models.Deployment.received_at), func.count(models.Deployment.id))
        .filter(models.Deployment.received_at >= desde)
        .group_by(func.date(models.Deployment.received_at))
        .order_by(func.date(models.Deployment.received_at))
        .all()
    )
    max_despliegues_dia = max([c for _, c in despliegues_por_dia], default=0)

    # --- Analitica de cambios por repositorio (commits/lineas) ---
    repos = db.query(models.Repo).order_by(models.Repo.name).all()
    por_repo = []
    for repo in repos:
        agg = (
            db.query(
                func.count(models.CommitStat.id),
                func.coalesce(func.sum(models.CommitStat.commits_count), 0),
                func.coalesce(func.sum(models.CommitStat.lines_added), 0),
                func.coalesce(func.sum(models.CommitStat.lines_deleted), 0),
            )
            .filter(models.CommitStat.repo_id == repo.id, models.CommitStat.commit_date >= desde)
            .first()
        )
        dias_con_actividad, commits_total, lineas_add, lineas_del = agg
        reportes_count = (
            db.query(models.AuditReport)
            .filter(models.AuditReport.repo_id == repo.id, models.AuditReport.report_date >= desde)
            .count()
        )
        por_repo.append({
            "repo": repo,
            "commits": commits_total or 0,
            "lines_added": lineas_add or 0,
            "lines_deleted": lineas_del or 0,
            "audit_reports": reportes_count,
        })
    max_commits_repo = max([r["commits"] for r in por_repo], default=0)

    commits_por_dia = (
        db.query(models.CommitStat.commit_date, func.sum(models.CommitStat.commits_count))
        .filter(models.CommitStat.commit_date >= desde)
        .group_by(models.CommitStat.commit_date)
        .order_by(models.CommitStat.commit_date)
        .all()
    )
    max_commits_dia = max([c for _, c in commits_por_dia], default=0)

    return templates.TemplateResponse(
        "analitica.html",
        {
            "request": request,
            "dias": dias,
            "total_deployments": total_deployments,
            "exitosos": exitosos,
            "fallidos": fallidos,
            "otros": otros,
            "tasa_exito": tasa_exito,
            "por_entorno": por_entorno,
            "por_proyecto": por_proyecto,
            "despliegues_por_dia": despliegues_por_dia,
            "max_despliegues_dia": max_despliegues_dia,
            "por_repo": por_repo,
            "max_commits_repo": max_commits_repo,
            "commits_por_dia": commits_por_dia,
            "max_commits_dia": max_commits_dia,
        },
    )
