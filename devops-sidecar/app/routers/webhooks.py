"""Webhook entrante de Coolify (Notifications -> Webhook -> tu URL).

IMPORTANTE (ver README): no se pudo verificar el esquema EXACTO del
payload de Coolify contra la documentacion oficial en el momento de
escribir esto - se confirmo que el canal "Webhook" existe y manda un
POST JSON generico, pero no el nombre exacto de cada campo. Por eso:
1. Se guarda el payload COMPLETO en raw_payload, pase lo que pase.
2. Se intenta interpretar varios nombres de campo plausibles/comunes.
3. En cuanto configures el webhook real en Coolify, revisa un payload
   real (columna raw_payload) y ajusta el mapeo de abajo si hace falta.
"""
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .. import models
from ..config import settings
from ..database import get_db

router = APIRouter(prefix="/webhooks", tags=["webhooks"])
logger = logging.getLogger("webhooks")


def _first(payload: dict, *keys, default=None):
    for key in keys:
        if key in payload and payload[key] not in (None, ""):
            return payload[key]
    return default


@router.post("/coolify")
async def coolify_webhook(request: Request, db: Session = Depends(get_db)):
    token = request.headers.get("X-Webhook-Token") or request.query_params.get("token")
    if settings.webhook_secret and token != settings.webhook_secret:
        raise HTTPException(status_code=401, detail="Token de webhook invalido o ausente.")

    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Body invalido: se esperaba JSON.")

    if not isinstance(payload, dict):
        payload = {"_raw": payload}

    deployment = models.Deployment(
        project=str(_first(payload, "application_name", "project", "name", "resource_name", default="desconocido")),
        commit_sha=str(_first(payload, "commit", "commit_sha", "sha", "commit_hash", default="")),
        author=str(_first(payload, "author", "pushed_by", "triggered_by", "commit_author", default="")),
        environment=str(_first(payload, "environment", "target", "environment_name", default="")),
        status=str(_first(payload, "status", "deployment_status", "event", default="desconocido")),
        raw_payload=json.dumps(payload)[:20000],
    )
    db.add(deployment)
    db.commit()
    db.refresh(deployment)

    logger.info("Webhook de Coolify recibido: deployment #%s (%s)", deployment.id, deployment.status)
    return {"ok": True, "id": deployment.id}
