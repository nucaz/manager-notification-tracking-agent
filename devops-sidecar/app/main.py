import logging

from fastapi import FastAPI

from .database import SessionLocal, init_db
from .routers import asistente, backup_jobs, backups, dashboard, deployments, git_targets, repos, restores, settings as settings_router, sso, stats, webhooks
from .scheduler import start_scheduler
from .services import backup_jobs as backup_jobs_service, git_service, settings_store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(title="DevOps Sidecar", version="1.0.0")


@app.on_event("startup")
def on_startup():
    init_db()
    db = SessionLocal()
    try:
        settings_store.load_overrides_into_settings(db)
        backup_jobs_service.ensure_app_job(db)
        result = git_service.secure_stored_tokens(db)
        if result["encrypted"] or result["scrubbed"]:
            logging.getLogger("startup").info(
                "Tokens de GitHub: %d cifrado(s) en BD, %d URL(s) de origin limpiadas.",
                result["encrypted"], result["scrubbed"],
            )
    finally:
        db.close()
    start_scheduler()


app.include_router(webhooks.router)
app.include_router(sso.router)
app.include_router(asistente.router)
app.include_router(backups.router)
app.include_router(backup_jobs.router)
app.include_router(git_targets.router)
app.include_router(restores.router)
app.include_router(repos.router)
app.include_router(deployments.router)
app.include_router(settings_router.router)
app.include_router(stats.router)
app.include_router(dashboard.router)


@app.get("/healthz")
def healthz():
    """Sin autenticacion a proposito - para que un healthcheck de Docker
    (o de Coolify, si algun dia se despliega este mismo modulo con el)
    pueda verificar que el proceso responde sin necesitar credenciales."""
    return {"ok": True}
