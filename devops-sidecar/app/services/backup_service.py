"""Respaldos: diferencial diario (el mismo texto de 'git log -p' que ya
genera audit_engine, persistido como archivo) y mirror semanal completo
comprimido (.tar.gz), con retencion configurable.

Sobre el mirror (`git clone --mirror`): es un repo BARE - solo la base de
datos interna de git (objects/, refs/, HEAD, etc.), sin un working tree
con los archivos "sueltos" (README.md, carpetas de codigo visibles). Eso
es intencional y es la forma estandar de respaldar un repo sin perder
nada: contiene el 100% del historial, todas las ramas y todos los tags,
comprimido - se restaura a una copia de trabajo completa con
`git clone <mirror> destino`. Por eso el .tar.gz normalmente pesa MENOS
que el working tree real (los objetos van comprimidos con deltas), no
es una senal de que falte algo.
"""
import logging
import shutil
import subprocess
import tarfile
from datetime import date, datetime, timedelta
from pathlib import Path

from sqlalchemy.orm import Session

from . import git_service
from .. import models
from ..config import settings

logger = logging.getLogger("backup_service")


def diff_stats(diff_text: str) -> dict:
    """Cuenta commits y archivos distintos tocados en un texto de
    'git log -p', para poder confirmarle al usuario que se respaldo."""
    import re

    commits = len(re.findall(r"^commit [0-9a-f]{7,40}", diff_text, re.MULTILINE))
    files = set(re.findall(r"^diff --git a/(.+?) b/.+$", diff_text, re.MULTILINE))
    return {"commits": commits, "files": len(files)}


def working_tree_stats(local_path: str) -> dict:
    """Cuenta archivos y bytes del working tree real (sin .git), para
    poder mostrar junto al tamano del mirror comprimido y que quede claro
    que la diferencia de peso es por compresion, no por datos faltantes."""
    base = Path(local_path)
    total_files = 0
    total_bytes = 0
    for p in base.rglob("*"):
        if ".git" in p.parts:
            continue
        if p.is_file():
            total_files += 1
            try:
                total_bytes += p.stat().st_size
            except OSError:
                pass
    return {"files": total_files, "bytes": total_bytes}


def save_daily_diff(db: Session, repo: models.Repo, diff_text: str) -> models.BackupRun:
    day_dir = Path(settings.backups_path) / "daily" / repo.name
    day_dir.mkdir(parents=True, exist_ok=True)
    file_path = day_dir / f"{date.today().isoformat()}.diff"
    file_path.write_text(diff_text, encoding="utf-8")

    run = models.BackupRun(
        repo_id=repo.id,
        backup_type="daily_diff",
        file_path=str(file_path),
        size_bytes=file_path.stat().st_size,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def run_daily_backup_all(db: Session) -> None:
    repos = db.query(models.Repo).filter(models.Repo.active.is_(True)).all()
    for repo in repos:
        try:
            diff_text = git_service.get_daily_diff(repo.local_path)
            if diff_text.strip():
                save_daily_diff(db, repo, diff_text)
        except Exception as e:  # noqa: BLE001
            logger.error("Fallo el respaldo diario de %s: %s", repo.name, e)


def run_full_content_backup(repo: models.Repo) -> Path:
    """Respaldo completo con los archivos REALES del working tree (no el
    formato interno de git) - para quien quiera abrir el .tar.gz y ver
    las carpetas/archivos tal cual estan hoy, sin necesitar git para
    restaurarlo. Complementa al mirror (que es mas chico pero solo lo
    puede leer git)."""
    source = Path(repo.local_path)
    full_dir = Path(settings.backups_path) / "full"
    full_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    tar_path = full_dir / f"{repo.name}_{stamp}.tar.gz"
    with tarfile.open(tar_path, "w:gz") as tar:
        for item in sorted(source.iterdir()):
            if item.name == ".git":
                continue
            tar.add(item, arcname=item.name)
    return tar_path


def restore_full_content(backup_file_path: str, repo: models.Repo) -> None:
    """Restaura un respaldo de contenido completo SOBRE el clon local
    actual - borra los archivos actuales (menos .git) y extrae el tar.gz
    encima. Es destructivo a proposito (es un restore), por eso el
    llamador debe pedir confirmacion antes de invocar esto."""
    target = Path(repo.local_path)
    target.mkdir(parents=True, exist_ok=True)
    for item in list(target.iterdir()):
        if item.name == ".git":
            continue
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink()
    with tarfile.open(backup_file_path, "r:gz") as tar:
        tar.extractall(target, filter="data")


def restore_from_mirror(backup_file_path: str, repo: models.Repo) -> None:
    """Restaura un respaldo tipo mirror: reemplaza el clon local por
    completo, clonando desde el mirror comprimido - trae de vuelta TODO
    el historial (no solo el ultimo snapshot), util si el clon local se
    corrompio o se borro por error."""
    target = Path(repo.local_path)
    tmp_extract = Path(settings.backups_path) / "_restore_tmp" / repo.name
    if tmp_extract.exists():
        shutil.rmtree(tmp_extract)
    tmp_extract.mkdir(parents=True, exist_ok=True)
    with tarfile.open(backup_file_path, "r:gz") as tar:
        tar.extractall(tmp_extract, filter="data")

    bare_dirs = list(tmp_extract.glob("*.git"))
    if not bare_dirs:
        raise RuntimeError("El archivo de respaldo no contiene un repositorio git valido.")
    bare_repo = bare_dirs[0]

    if target.exists():
        shutil.rmtree(target)
    result = subprocess.run(
        ["git", "clone", str(bare_repo), str(target)],
        capture_output=True, text=True, timeout=900,
    )
    shutil.rmtree(tmp_extract)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or "restauracion fallo")[:500])


def run_weekly_mirror(repo: models.Repo) -> Path:
    tmp_mirror = Path(settings.backups_path) / "_tmp" / f"{repo.name}.git"
    if tmp_mirror.exists():
        shutil.rmtree(tmp_mirror)
    tmp_mirror.parent.mkdir(parents=True, exist_ok=True)

    result = subprocess.run(
        ["git", "clone", "--mirror", repo.local_path, str(tmp_mirror)],
        capture_output=True, text=True, timeout=900,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or "git clone --mirror fallo")[:500])

    weekly_dir = Path(settings.backups_path) / "weekly"
    weekly_dir.mkdir(parents=True, exist_ok=True)
    # Con hora y no solo fecha (igual que run_full_content_backup) - si no,
    # dos mirrors el mismo dia (ej. uno manual + el automatico semanal)
    # generan el mismo nombre de archivo y el segundo pisa al primero en
    # disco, aunque en la base de datos queden dos filas BackupRun
    # separadas apuntando al mismo archivo ya sobrescrito.
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    tar_path = weekly_dir / f"{repo.name}_{stamp}.tar.gz"
    with tarfile.open(tar_path, "w:gz") as tar:
        tar.add(tmp_mirror, arcname=f"{repo.name}.git")
    shutil.rmtree(tmp_mirror)
    return tar_path


def apply_retention(days: int | None = None) -> int:
    """Borra .tar.gz semanales mas viejos que `days`. Devuelve cuantos se borraron."""
    days = days if days is not None else settings.backup_retention_days
    weekly_dir = Path(settings.backups_path) / "weekly"
    if not weekly_dir.exists():
        return 0
    cutoff = datetime.now() - timedelta(days=days)
    removed = 0
    for f in weekly_dir.glob("*.tar.gz"):
        if datetime.fromtimestamp(f.stat().st_mtime) < cutoff:
            f.unlink()
            removed += 1
    return removed


def run_weekly_backup_all(db: Session) -> None:
    repos = db.query(models.Repo).filter(models.Repo.active.is_(True)).all()
    for repo in repos:
        try:
            tar_path = run_weekly_mirror(repo)
            db.add(
                models.BackupRun(
                    repo_id=repo.id,
                    backup_type="weekly_mirror",
                    file_path=str(tar_path),
                    size_bytes=tar_path.stat().st_size,
                )
            )
            db.commit()
        except Exception as e:  # noqa: BLE001
            logger.error("Fallo el respaldo semanal de %s: %s", repo.name, e)
    apply_retention()
