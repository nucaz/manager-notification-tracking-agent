"""Clonar/sincronizar repos y extraer estadisticas de commits via git CLI
(nunca via una libreria que reimplemente git - mismo criterio que
glpi-licencias-app usa mariadb-dump/mariadb reales en vez de reescribir
el dump a mano)."""
import base64
import os
import re
import subprocess
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy.orm import Session

from .. import models
from . import crypto_service


class GitError(Exception):
    pass


def repo_token(repo: models.Repo) -> str:
    """Token de GitHub del repo ya descifrado (en BD se guarda cifrado)."""
    return crypto_service.decrypt(repo.github_token) if repo.github_token else ""


def auth_env(repo: models.Repo) -> dict | None:
    """Variables de entorno para que git se autentique contra GitHub sin
    poner el token en la URL: con la URL, `git clone` lo dejaba guardado
    en .git/config (texto plano en disco) y visible en la lista de
    procesos. GIT_CONFIG_COUNT/KEY/VALUE (git >= 2.31) inyecta la
    cabecera Authorization solo para este comando."""
    token = repo_token(repo)
    if not token or not repo.github_url.startswith("https://"):
        return None
    return header_env("x-access-token", token)


def header_env(user: str, token: str) -> dict:
    """Entorno de git con la cabecera Authorization: Basic user:token.
    Sirve para GitHub (x-access-token), GitLab (oauth2), Azure DevOps
    (cualquier usuario + PAT) y Gitea (usuario + token)."""
    basic = base64.b64encode(f"{user or 'x-access-token'}:{token}".encode()).decode()
    env = dict(os.environ)
    env.update({
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "http.extraHeader",
        "GIT_CONFIG_VALUE_0": f"Authorization: Basic {basic}",
    })
    return env


def plain_env() -> dict:
    """Entorno sin credenciales, que falla en vez de pedir usuario/clave."""
    return dict(os.environ, GIT_TERMINAL_PROMPT="0")


def strip_credentials(url: str) -> str:
    """https://token@github.com/x/y -> https://github.com/x/y"""
    parts = urlsplit(url)
    if parts.scheme in ("http", "https") and "@" in parts.netloc:
        return urlunsplit((parts.scheme, parts.netloc.split("@", 1)[1], parts.path, parts.query, parts.fragment))
    return url


def scrub_origin_url(local_path: str) -> bool:
    """Quita el token de la URL de 'origin' si un clon viejo lo tiene
    guardado en .git/config. Devuelve True si tuvo que limpiarla."""
    if not (Path(local_path) / ".git").exists():
        return False
    current = (_run(["git", "remote", "get-url", "origin"], cwd=local_path, timeout=15).stdout or "").strip()
    clean = strip_credentials(current)
    if current and clean != current:
        _run(["git", "remote", "set-url", "origin", clean], cwd=local_path, timeout=15)
        return True
    return False


def secure_stored_tokens(db: Session) -> dict:
    """Migracion al arrancar: cifra los tokens de GitHub que sigan en
    texto plano en la tabla repos y quita el token de la URL de 'origin'
    de los clones que ya lo tenian guardado. Idempotente."""
    from ..config import settings

    encrypted = scrubbed = 0
    clone_paths = set()
    for repo in db.query(models.Repo).all():
        clone_paths.add(repo.local_path)
        if repo.github_token and not crypto_service.is_encrypted(repo.github_token):
            new_value = crypto_service.encrypt(repo.github_token)
            if new_value != repo.github_token:  # sin CREDENTIALS_ENC_KEY encrypt() no cambia nada
                repo.github_token = new_value
                encrypted += 1
    # Tambien clones huerfanos (de repos eliminados de la app, cuya carpeta
    # quedo en disco) - siguen teniendo el token en su .git/config.
    base = Path(settings.repos_base_path)
    if base.exists():
        for root, dirs, _files in os.walk(base):
            if ".git" in dirs:
                clone_paths.add(root)
                dirs[:] = []  # no bajar dentro de un clon
            elif Path(root).relative_to(base).parts and len(Path(root).relative_to(base).parts) >= 4:
                dirs[:] = []
    for path in sorted(clone_paths):
        try:
            if scrub_origin_url(path):
                scrubbed += 1
        except Exception:  # noqa: BLE001 - un clon roto no debe impedir que arranque la app
            pass
    if encrypted:
        db.commit()
    return {"encrypted": encrypted, "scrubbed": scrubbed}


def _run(args, cwd=None, timeout=300, env=None):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env)


def _default_branch(local_path: str, env: dict | None = None) -> str:
    # Primero sin red: refs/remotes/origin/HEAD lo deja `git clone`.
    result = _run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd=local_path, timeout=15)
    ref = (result.stdout or "").strip()
    if result.returncode == 0 and ref.startswith("origin/"):
        return ref.split("/", 1)[1]
    result = _run(["git", "remote", "show", "origin"], cwd=local_path, timeout=60, env=env)
    match = re.search(r"HEAD branch:\s*(\S+)", result.stdout or "")
    return match.group(1) if match else "main"


def sync_repo(repo: models.Repo) -> tuple[bool, str]:
    """Clona el repo si no existe localmente, o lo actualiza (fetch +
    reset --hard a la rama por defecto) si ya existe. Es un espejo de
    solo lectura para auditar/respaldar - reset --hard es seguro aca
    porque nadie edita a mano este clon local."""
    local_path = Path(repo.local_path)
    env = auth_env(repo)
    try:
        if not (local_path / ".git").exists():
            local_path.parent.mkdir(parents=True, exist_ok=True)
            result = _run(["git", "clone", strip_credentials(repo.github_url), str(local_path)], timeout=900, env=env)
            if result.returncode != 0:
                return False, (result.stderr or "clone fallo")[:500]
            return True, "clonado"

        scrub_origin_url(str(local_path))
        result = _run(["git", "fetch", "--all", "--prune"], cwd=str(local_path), timeout=600, env=env)
        if result.returncode != 0:
            return False, (result.stderr or "fetch fallo")[:500]

        branch = _default_branch(str(local_path), env)
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


_SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")


def _valid_sha(sha: str) -> bool:
    return bool(_SHA_RE.match(sha or ""))


def list_commits(local_path: str, limit: int = 50) -> list[dict]:
    """Historial de commits (para 'ver/descargar una version anterior') -
    solo lectura, no toca el working tree."""
    result = _run(
        ["git", "log", f"-{limit}", "--pretty=format:%H\x1f%h\x1f%an\x1f%ad\x1f%s", "--date=iso"],
        cwd=local_path, timeout=60,
    )
    commits = []
    for line in (result.stdout or "").splitlines():
        parts = line.split("\x1f")
        if len(parts) == 5:
            commits.append({"sha": parts[0], "short_sha": parts[1], "author": parts[2], "date": parts[3], "message": parts[4]})
    return commits


def show_commit(local_path: str, sha: str) -> str:
    """Diff completo de un commit especifico (git show), para verlo antes
    de decidir si se descarga/revierte."""
    if not _valid_sha(sha):
        raise GitError("SHA de commit invalido.")
    result = _run(["git", "show", "--no-color", sha], cwd=local_path, timeout=60)
    if result.returncode != 0:
        raise GitError((result.stderr or "no se pudo leer ese commit")[:500])
    return result.stdout or ""


def archive_commit(local_path: str, sha: str, dest_tar_path: str) -> None:
    """Empaqueta el codigo TAL COMO ESTABA en ese commit (git archive) -
    no toca el working tree ni el HEAD, solo lee de la base de datos de
    git. Es la forma segura de 'descargar una version anterior'."""
    if not _valid_sha(sha):
        raise GitError("SHA de commit invalido.")
    result = _run(["git", "archive", "--format=tar.gz", "-o", dest_tar_path, sha], cwd=local_path, timeout=120)
    if result.returncode != 0:
        raise GitError((result.stderr or "git archive fallo")[:500])


def rollback_local_to_commit(local_path: str, sha: str) -> None:
    """Deja el CLON LOCAL (no el remoto de GitHub) exactamente como
    estaba en ese commit (git reset --hard). Se usa para inspeccionar o
    probar un punto anterior antes de decidir si se revierte de verdad -
    el repo debe quedar fuera del auto-sync mientras tanto, si no el
    proximo ciclo (fetch + reset --hard origin/rama) lo deshace."""
    if not _valid_sha(sha):
        raise GitError("SHA de commit invalido.")
    result = _run(["git", "reset", "--hard", sha], cwd=local_path, timeout=60)
    if result.returncode != 0:
        raise GitError((result.stderr or "git reset fallo")[:500])


def revert_commit_local(local_path: str, sha: str) -> str:
    """Crea un commit NUEVO que deshace los cambios de `sha` (git revert),
    en el clon local. No reescribe historial (mas seguro que un reset +
    force-push) y no toca GitHub - eso es un paso aparte (push_branch).
    Se fija el autor del commit por linea de comandos (-c user.*) en vez
    de depender de un `git config --global` del contenedor, que no existe
    por defecto."""
    if not _valid_sha(sha):
        raise GitError("SHA de commit invalido.")
    result = _run(
        [
            "git",
            "-c", "user.name=DevOps Sidecar",
            "-c", "user.email=devops-sidecar@localhost",
            "revert", "--no-edit", sha,
        ],
        cwd=local_path, timeout=120,
    )
    if result.returncode != 0:
        # Dejar el revert a medias es peor que abortarlo solo: un conflicto
        # o cualquier otro fallo (ej. commit sin poder cerrarse) puede dejar
        # cambios en stage sin que haya un "revert en curso" formal, y
        # entonces `revert --abort` por si solo no alcanza - se limpia
        # siempre con reset --hard + clean para garantizar que el clon
        # quede utilizable para el proximo intento.
        _run(["git", "revert", "--abort"], cwd=local_path, timeout=30)
        _run(["git", "reset", "--hard", "HEAD"], cwd=local_path, timeout=30)
        _run(["git", "clean", "-fd"], cwd=local_path, timeout=30)
        raise GitError((result.stderr or result.stdout or "git revert fallo (posible conflicto)")[:800])
    head = _run(["git", "rev-parse", "HEAD"], cwd=local_path, timeout=15)
    return (head.stdout or "").strip()


def current_branch(local_path: str) -> str:
    result = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=local_path, timeout=15)
    return (result.stdout or "").strip() or "HEAD"


def push_branch(repo: models.Repo, branch: str) -> tuple[bool, str]:
    """Sube el clon local al remoto real de GitHub. Requiere que
    repo.github_token tenga permiso de escritura (repo:write) - si solo
    tiene lectura, esto falla con el error real de git/GitHub, no se
    intenta adivinar ni forzar nada."""
    result = _run(["git", "push", strip_credentials(repo.github_url), branch], cwd=repo.local_path, timeout=300, env=auth_env(repo))
    if result.returncode != 0:
        return False, (result.stderr or "push fallo")[:800]
    return True, (result.stderr or result.stdout or "push exitoso")[:500]


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
