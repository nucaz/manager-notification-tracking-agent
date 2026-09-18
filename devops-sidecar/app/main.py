import logging

from fastapi import FastAPI

from .database import init_db
from .routers import dashboard, deployments, repos, webhooks
from .scheduler import start_scheduler

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(title="DevOps Sidecar", version="1.0.0")


@app.on_event("startup")
def on_startup():
    init_db()
    start_scheduler()


app.include_router(webhooks.router)
app.include_router(repos.router)
app.include_router(deployments.router)
app.include_router(dashboard.router)


@app.get("/healthz")
def healthz():
    """Sin autenticacion a proposito - para que un healthcheck de Docker
    (o de Coolify, si algun dia se despliega este mismo modulo con el)
    pueda verificar que el proceso responde sin necesitar credenciales."""
    return {"ok": True}
