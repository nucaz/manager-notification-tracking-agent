import bleach
import markdown as md
from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from .. import models, scoring
from ..auth import require_dashboard_auth
from ..database import get_db

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
    return templates.TemplateResponse("backups.html", {"request": request, "runs": runs})
