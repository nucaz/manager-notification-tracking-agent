"""Motor de auditoria semantica diaria: por cada repo activo, extrae el
diff del ultimo dia, corre el escaneo de secretos (deterministico) y le
pide a la IA un reporte en Markdown (desarrolladores, impacto, alertas
DevSecOps). Un fallo en UN repo (git roto, IA caida, etc.) no debe
interrumpir la auditoria de los demas - por eso cada repo se procesa en
su propio try/except.
"""
import json
import logging
from datetime import date
from pathlib import Path

from sqlalchemy.orm import Session

from . import ai_client, git_service, secret_scanner
from .. import models
from ..config import settings

logger = logging.getLogger("audit_engine")


def build_prompt(repo_name: str, diff_text: str, truncated: bool) -> str:
    nota = "\n\n[NOTA: el diff se truncó por tamaño - este es un extracto parcial del día]" if truncated else ""
    return f"""Eres un auditor tecnico senior revisando los cambios de HOY en el repositorio "{repo_name}".

A continuacion el resultado de "git log -p" del ultimo dia (commits + diff exacto de codigo):

```diff
{diff_text}
```
{nota}

Responde EN ESPAÑOL, en formato Markdown, con EXACTAMENTE estas cuatro secciones (usa estos encabezados literales):

## Desarrolladores y resumen ejecutivo
Quien trabajo hoy (por nombre de autor de commit) y un resumen breve y concreto de que hizo cada uno.

## Análisis de impacto
En que logica de negocio se involucra este cambio y que componentes del sistema puede alterar o romper. Se especifico: cita archivos y funciones cuando el diff lo permita. Si el cambio es trivial (typos, formato), dilo asi de simple.

## Cambios por commit
Una lista itemizada, UN grupo de bullets por cada commit del dia (identifica cada commit por su mensaje o hash corto), con los cambios concretos e importantes de ESE commit en particular - no repitas el resumen general de arriba, se especifico por archivo/funcion cuando se pueda.

## Alertas DevSecOps
Vulnerabilidades criticas, malas practicas de seguridad, o datos sensibles que veas en el diff (mas alla de un escaneo automatico de secretos que ya se corrio aparte). Si no encuentras nada preocupante, dilo explicitamente en vez de inventar una alerta."""


async def run_audit_for_repo(db: Session, repo: models.Repo) -> models.AuditReport:
    diff_text = git_service.get_daily_diff(repo.local_path)

    if not diff_text.strip():
        markdown = f"# {repo.name} — {date.today().isoformat()}\n\nSin commits en las últimas 24 horas."
        alerts: list[dict] = []
        provider_used = None
    else:
        alerts = secret_scanner.scan_diff(diff_text)
        truncated = len(diff_text) > settings.max_diff_chars
        diff_for_prompt = diff_text[: settings.max_diff_chars]
        prompt = build_prompt(repo.name, diff_for_prompt, truncated)

        try:
            ai_report = await ai_client.generate(prompt)
            provider_used = settings.ai_provider
        except ai_client.AIClientError as e:
            ai_report = f"_No se pudo generar el análisis con IA: {e}_"
            provider_used = f"{settings.ai_provider} (error)"
            logger.error("Fallo la IA auditando %s: %s", repo.name, e)

        alert_block = ""
        if alerts:
            lineas = "\n".join(f"- **{a['type']}** en `{a['file'] or '?'}`: `{a['preview']}`" for a in alerts)
            alert_block = f"\n\n## Alertas automáticas (escaneo de patrones, sin IA)\n{lineas}\n"

        markdown = f"# {repo.name} — {date.today().isoformat()}\n\n{ai_report}{alert_block}"

    report = models.AuditReport(
        repo_id=repo.id,
        report_date=date.today(),
        report_markdown=markdown,
        secret_alerts_json=json.dumps(alerts),
        ai_provider_used=provider_used,
    )
    db.add(report)
    db.commit()
    db.refresh(report)

    reports_dir = Path(settings.reports_path) / repo.name
    reports_dir.mkdir(parents=True, exist_ok=True)
    (reports_dir / f"{date.today().isoformat()}.md").write_text(markdown, encoding="utf-8")

    return report


async def run_daily_audit_all(db: Session) -> list[models.AuditReport]:
    repos = db.query(models.Repo).filter(models.Repo.active.is_(True)).all()
    results = []
    for repo in repos:
        try:
            git_service.update_commit_stats(db, repo)
            results.append(await run_audit_for_repo(db, repo))
        except Exception as e:  # noqa: BLE001 - un repo roto no debe tumbar a los demas
            logger.error("Fallo la auditoria diaria de %s: %s", repo.name, e)
    return results
