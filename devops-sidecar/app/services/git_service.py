"""Clonar/sincronizar repos y extraer estadisticas de commits via git CLI
(nunca via una libreria que reimplemente git - mismo criterio que
glpi-licencias-app usa mariadb-dump/mariadb reales en vez de reescribir
el dump a mano)."""
import re
import subprocess
from datetime import date
from pathlib import Path

from sqlalchemy.orm import Session

from .. import models


class GitError(Exception):
    pass


def build_clone_url(repo: models.Repo) -> str:
    """Inserta el token en la URL solo en memoria, para este comando -
    nunca se loggea ni se guarda la URL con el token embebido."""
    if repo.github_token and repo.github_url.startswith("https://"):
        return repo.github_url.replace("https://", f"https://{repo.github_token}@", 1)
    return repo.github_url


def _run(args, cwd=None, timeout=300):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def _default_branch(local_path: str) -> str:
    result = _run(["git", "remote", "show", "origin"], cwd=local_path, timeout=60)
    match = re.search(r"HEAD branch:\s*(\S+)", result.stdout or "")
    return match.group(1) if match else "main"


def sync_repo(repo: models.Repo) -> tuple[bool, str]:
    """Clona el repo si no existe localmente, o lo actualiza (fetch +
    reset --hard a la rama por defecto) si ya existe. Es un espejo de
    solo lectura para auditar/respaldar - reset --hard es seguro aca
    porque nadie edita a mano este clon local."""
    local_path = Path(repo.local_path)
    try:
        if not (local_path / ".git").exists():
            local_path.parent.mkdir(parents=True, exist_ok=True)
            url = build_clone_url(repo)
            result = _run(["git", "clone", url, str(local_path)], timeout=900)
            if result.returncode != 0:
                return False, (result.stderr or "clone fallo")[:500]
            return True, "clonado"

        result = _run(["git", "fetch", "--all", "--prune"], cwd=str(local_path), timeout=600)
        if result.returncode != 0:
            return False, (result.stderr or "fetch fallo")[:500]

        branch = _default_branch(str(local_path))
        result = _run(["git", "reset", "--hard", f"origin/{branch}"], cwd=str(local_path), timeout=120)
        if result.returncode != 0:
            return False, (result.stderr or "reset fallo")[:500]
        return True, f"actualizado ({branch})"
    except subprocess.TimeoutExpired:
        return False, "timeout"
    except Exception as e:  # noqa: BLE001 - se quiere capturar cualquier fallo de git sin tumbar el scheduler
        return False, str(e)[:500]


def get_daily_diff(local_path: str, since: str = "1.day.ago") -> str:
    """git log -p del ultimo dia - el insumo crudo tanto para la IA como
    para el respaldo diferencial diario."""
    result = _run(["git", "log", f"--since={since}", "-p", "--no-color"], cwd=local_path, timeout=180)
    return result.stdout or ""


def update_commit_stats(db: Session, repo: models.Repo, since: str = "1.day.ago") -> None:
    """Parsea 'git log --numstat' del ultimo dia y acumula
    commits/lineas por autor en commit_stats (upsert por dia)."""
    result = _run(
        ["git", "log", f"--since={since}", "--no-merges", "--pretty=format:__COMMIT__%an", "--numstat"],
        cwd=repo.local_path,
        timeout=180,
    )
    stats: dict[str, dict[str, int]] = {}
    current_author = None
    for line in (result.stdout or "").splitlines():
        if line.startswith("__COMMIT__"):
            current_author = line[len("__COMMIT__"):].strip() or "desconocido"
            stats.setdefault(current_author, {"commits": 0, "added": 0, "deleted": 0})
            stats[current_author]["commits"] += 1
        elif line.strip() and current_author:
            parts = line.split("\t")
            if len(parts) >= 2:
                added = int(parts[0]) if parts[0].isdigit() else 0
                deleted = int(parts[1]) if parts[1].isdigit() else 0
                stats[current_author]["added"] += added
                stats[current_author]["deleted"] += deleted

    today = date.today()
    for author, s in stats.items():
        row = (
            db.query(models.CommitStat)
            .filter_by(repo_id=repo.id, author=author, commit_date=today)
            .first()
        )
        if row:
            row.commits_count += s["commits"]
            row.lines_added += s["added"]
            row.lines_deleted += s["deleted"]
        else:
            db.add(
                models.CommitStat(
                    repo_id=repo.id,
                    author=author,
                    commit_date=today,
                    commits_count=s["commits"],
                    lines_added=s["added"],
                    lines_deleted=s["deleted"],
                )
            )
    db.commit()
