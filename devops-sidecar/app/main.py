import logging

from fastapi import FastAPI

from .database import SessionLocal, init_db
from .routers import asistente, backups, dashboard, deployments, repos, settings as settings_router, stats, webhooks
from .scheduler import start_scheduler
from .services import settings_store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(title="DevOps Sidecar", version="1.0.0")


@app.on_event("startup")
def on_startup():
    init_db()
    db = SessionLocal()
    try:
        settings_store.load_overrides_into_settings(db)
    finally:
        db.close()
    start_scheduler()


app.include_router(webhooks.router)
app.include_router(asistente.router)
app.include_router(backups.router)
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
