"""Webhook entrante de Coolify (Notifications -> Webhook -> tu URL).

El mapeo de campos de abajo esta verificado contra el codigo FUENTE real
de Coolify (repo coollabsio/coolify en GitHub, via `gh api`), no contra
una prueba en vivo ni una suposicion:
- app/Notifications/Channels/WebhookChannel.php hace
  `Http::post($webhookUrl, $payload)` - un POST JSON plano, SIN ningun
  header de autenticacion ni firma (no hay HMAC tipo GitHub/Stripe).
- app/Models/WebhookNotificationSettings.php solo tiene un campo
  `webhook_url` - Coolify no tiene forma de mandar headers personalizados
  para este canal. Por eso el token de este endpoint SOLO puede validarse
  por query string (?token=...), nunca por header - configuralo asi en
  Coolify: la URL completa con el token incluido.
- app/Notifications/Application/DeploymentSuccess.php y
  DeploymentFailed.php (metodo toWebhook()) mandan exactamente:
  success (bool), message, event ("deployment_success"/"deployment_failed"),
  application_name, application_uuid, deployment_uuid, deployment_url,
  project, environment, y opcionalmente fqdn / pull_request_id / preview_fqdn.
  Coolify NUNCA manda el commit ni el autor del push en este payload -
  no es un descuido del mapeo, Coolify simplemente no lo incluye.

Aun asi se sigue guardando el payload COMPLETO en raw_payload, por si
Coolify cambia este formato en una version futura o si este mismo
endpoint recibe eventos de otra fuente (otros notifiers si migran) que
sí manden esos campos.
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
    # Coolify no soporta headers personalizados en su canal "Webhook" -
    # el token SOLO puede llegar por query string. Se sigue aceptando el
    # header tambien, por si este endpoint lo llama otra herramienta que
    # si soporte headers.
    token = request.headers.get("X-Webhook-Token") or request.query_params.get("token")
    if settings.webhook_secret and token != settings.webhook_secret:
        raise HTTPException(status_code=401, detail="Token de webhook invalido o ausente.")

    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Body invalido: se esperaba JSON.")

    if not isinstance(payload, dict):
        payload = {"_raw": payload}

    event = _first(payload, "event", default="")
    if "success" in payload:
        status = "deployment_success" if payload.get("success") else "deployment_failed"
    else:
        status = str(event or _first(payload, "status", "deployment_status", default="desconocido"))

    deployment = models.Deployment(
        project=str(_first(payload, "project", "resource_name", default="desconocido")),
        application_name=str(_first(payload, "application_name", "name", default="")),
        commit_sha=str(_first(payload, "commit", "commit_sha", "sha", "commit_hash", default="")),
        author=str(_first(payload, "author", "pushed_by", "triggered_by", "commit_author", default="")),
        environment=str(_first(payload, "environment", "target", "environment_name", default="")),
        status=status,
        deployment_url=_first(payload, "deployment_url", default=None),
        raw_payload=json.dumps(payload)[:20000],
    )
    db.add(deployment)
    db.commit()
    db.refresh(deployment)

    logger.info("Webhook de Coolify recibido: deployment #%s (%s)", deployment.id, deployment.status)
    return {"ok": True, "id": deployment.id}
