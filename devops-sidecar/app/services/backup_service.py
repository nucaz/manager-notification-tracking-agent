"""Respaldos: diferencial diario (el mismo texto de 'git log -p' que ya
genera audit_engine, persistido como archivo) y mirror semanal completo
comprimido (.tar.gz), con retencion configurable."""
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


def save_daily_diff(db: Session, repo: models.Repo, diff_text: str) -> Path:
    day_dir = Path(settings.backups_path) / "daily" / repo.name
    day_dir.mkdir(parents=True, exist_ok=True)
    file_path = day_dir / f"{date.today().isoformat()}.diff"
    file_path.write_text(diff_text, encoding="utf-8")

    db.add(
        models.BackupRun(
            repo_id=repo.id,
            backup_type="daily_diff",
            file_path=str(file_path),
            size_bytes=file_path.stat().st_size,
        )
    )
    db.commit()
    return file_path


def run_daily_backup_all(db: Session) -> None:
    repos = db.query(models.Repo).filter(models.Repo.active.is_(True)).all()
    for repo in repos:
        try:
            diff_text = git_service.get_daily_diff(repo.local_path)
            if diff_text.strip():
                save_daily_diff(db, repo, diff_text)
        except Exception as e:  # noqa: BLE001
            logger.error("Fallo el respaldo diario de %s: %s", repo.name, e)


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
    stamp = datetime.now().strftime("%Y%m%d")
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
