"""Otros repositorios Git de un repo registrado (ver models.GitTarget):

1. Mirror de respaldo (purpose='mirror'): copia todas las ramas y
   etiquetas del repositorio de origen a OTRO repositorio (GitHub, GitLab,
   Azure DevOps, Gitea, o un repo bare en un disco montado).
   - protegido: nunca pierde nada. Una rama borrada en el origen se
     conserva en el respaldo. Si en el origen se reescribe historial
     (force-push), la version anterior queda en una rama
     sidecar-conservado/<rama>-<fecha> y la rama sigue actualizandose.
   - exacto: `git push --mirror`, el destino queda identico al origen
     (tambien borra y fuerza). Nunca se permite contra un repositorio que
     este registrado en el sidecar.

2. Colaborador -> principal (purpose='upstream'): el repo registrado es
   el de la cuenta colaboradora; los commits que el principal no tiene se
   suben a una rama `sidecar-sync/<rama>` y se abre un Pull Request (en
   GitHub por su API; en GitLab con push options). En modo 'directo' solo
   se sube a la rama base si es avance rapido. Nunca se fuerza.

Cada destino trabaja en su propio repo bare (repos_base_path/
.sidecar-git-targets/<id>.git), separado del clon que audita el sidecar.
Las credenciales viajan por cabecera (git_service.header_env), nunca en
la URL ni en disco.
"""
import logging
import re
import threading
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from sqlalchemy.orm import Session

from .. import models
from ..config import settings
from ..database import SessionLocal
from . import crypto_service, git_service

logger = logging.getLogger("git_targets")
_locks: dict[int, threading.Lock] = {}
_locks_guard = threading.Lock()
SYNC_BRANCH_PREFIX = "sidecar-sync/"
PRESERVED_PREFIX = "sidecar-conservado/"


def _lock_for(target_id: int) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(target_id, threading.Lock())


def is_running(target_id: int) -> bool:
    return _lock_for(target_id).locked()


# ------------------------------- utilidades --------------------------------
def default_user(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    if "gitlab" in host:
        return "oauth2"
    if host.endswith("dev.azure.com") or host.endswith("visualstudio.com"):
        return "pat"
    return "x-access-token"


def normalize_url(url: str) -> str:
    """Forma comparable de una URL o ruta: sin credenciales, sin .git ni
    barra final, host y ruta en minusculas (GitHub/GitLab no distinguen)."""
    u = git_service.strip_credentials((url or "").strip())
    if u.startswith(("http://", "https://")):
        parts = urlsplit(u)
        path = parts.path.rstrip("/")
        if path.endswith(".git"):
            path = path[:-4]
        port = f":{parts.port}" if parts.port else ""
        return f"https://{(parts.hostname or '').lower()}{port}{path.lower()}"
    return str(Path(u).resolve()).rstrip("/").removesuffix(".git").lower()


def validate_url(url: str) -> str | None:
    url = (url or "").strip()
    if url.startswith("https://"):
        if "@" in urlsplit(url).netloc:
            return "No ponga usuario ni token dentro de la URL: use los campos Usuario y Token (se guardan cifrados)."
        return None
    if url.startswith("/"):
        return None
    return "La URL debe empezar con https:// (o ser la ruta absoluta de un repositorio bare montado en el contenedor)."


def valid_branch(name: str) -> bool:
    if not name:
        return True
    r = git_service._run(["git", "check-ref-format", "--branch", name], timeout=15)
    return r.returncode == 0 and not name.startswith("-")


def target_token(target: models.GitTarget) -> str:
    return crypto_service.decrypt(target.token_enc) if target.token_enc else ""


def env_for(target: models.GitTarget) -> dict:
    token = target_token(target)
    if token and target.url.startswith("https://"):
        return git_service.header_env(target.auth_user or default_user(target.url), token)
    return git_service.plain_env()


def source_env(repo: models.Repo) -> dict:
    return git_service.auth_env(repo) or git_service.plain_env()


def workspace(target: models.GitTarget) -> Path:
    return Path(settings.repos_base_path) / ".sidecar-git-targets" / f"{target.id}.git"


def _git(args, cwd=None, env=None, timeout=900):
    return git_service._run(["git", *args], cwd=str(cwd) if cwd else None, timeout=timeout, env=env)


def _err(r) -> str:
    lines = [ln for ln in (r.stderr or r.stdout or "").splitlines() if ln.strip()]
    text = " | ".join(lines[-4:])[:700] or f"codigo {r.returncode}"
    return text


def _auth_hint(text: str) -> str:
    low = text.lower()
    if any(k in low for k in ("403", "401", "authentication failed", "could not read username", "access denied",
                              "permission to", "not found", "repository not found")):
        return (" Revise el token: debe tener permiso de escritura en ese repositorio. Para un repositorio personal"
                " de OTRA cuenta donde usted es colaborador use un token clasico con alcance 'repo': los tokens"
                " de grano fino (github_pat_...) no pueden acceder a repositorios personales ajenos.")
    return ""


def _ensure_ws(target: models.GitTarget) -> Path:
    ws = workspace(target)
    if not (ws / "HEAD").exists():
        ws.parent.mkdir(parents=True, exist_ok=True)
        r = _git(["init", "--bare", "-q", str(ws)], timeout=60)
        if r.returncode != 0:
            raise RuntimeError("No se pudo preparar el area de trabajo: " + _err(r))
    return ws


def _heads(ws: Path, prefix: str) -> dict[str, str]:
    r = _git(["for-each-ref", "--format=%(refname) %(objectname)", prefix], cwd=ws, timeout=60)
    out = {}
    for line in (r.stdout or "").splitlines():
        ref, sha = line.split(" ", 1)
        out[ref[len(prefix):]] = sha
    return out


def ls_remote(url: str, env: dict, args: tuple = ("--heads",)) -> tuple[bool, dict[str, str], str]:
    r = _git(["ls-remote", *args, url], env=env, timeout=120)
    if r.returncode != 0:
        return False, {}, _err(r)
    refs = {}
    for line in (r.stdout or "").splitlines():
        parts = line.split("\t")
        if len(parts) == 2:
            refs[parts[1]] = parts[0]
    return True, refs, ""


def remote_default_branch(url: str, env: dict) -> str | None:
    r = _git(["ls-remote", "--symref", url, "HEAD"], env=env, timeout=60)
    m = re.search(r"^ref: refs/heads/(\S+)\s+HEAD", r.stdout or "", re.M)
    return m.group(1) if m else None


def _parse_porcelain(stdout: str) -> dict:
    """Salida de `git push --porcelain`: flag \\t origen:destino \\t resumen."""
    res = {"nuevas": [], "actualizadas": [], "al_dia": 0, "borradas": [], "forzadas": [], "rechazadas": [], "rechazadas_refs": []}
    for line in (stdout or "").splitlines():
        parts = line.split("\t")
        if len(parts) < 2 or len(parts[0]) != 1:
            continue
        flag, refs = parts[0], parts[1]
        summary = parts[2] if len(parts) > 2 else ""
        dst = refs.split(":", 1)[-1].replace("refs/heads/", "").replace("refs/tags/", "etiqueta ")
        bucket = {"*": "nuevas", " ": "actualizadas", "-": "borradas", "+": "forzadas"}.get(flag)
        if bucket:
            res[bucket].append(dst)
        elif flag == "=":
            res["al_dia"] += 1
        elif flag == "!":
            res["rechazadas"].append(f"{dst} ({summary})")
            res["rechazadas_refs"].append(refs.split(":", 1)[-1])
    return res


# ------------------------------- GitHub API --------------------------------
def github_repo(url: str) -> tuple[str, str] | None:
    parts = urlsplit(url or "")
    if (parts.hostname or "").lower() != "github.com":
        return None
    path = parts.path.strip("/").removesuffix(".git")
    segs = path.split("/")
    return (segs[0], segs[1]) if len(segs) == 2 and all(segs) else None


def github_api(method: str, path: str, token: str, json_body=None, params=None) -> httpx.Response:
    """Punto unico de llamadas a la API de GitHub (las pruebas lo reemplazan)."""
    return httpx.request(method, "https://api.github.com" + path, json=json_body, params=params, timeout=30,
                         headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                                  "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "devops-sidecar"})


def _github_msg(resp: httpx.Response) -> str:
    try:
        data = resp.json()
        extra = "; ".join(e.get("message", "") for e in data.get("errors", []) if isinstance(e, dict))
        return (data.get("message", "") + (f" ({extra})" if extra else ""))[:300]
    except ValueError:
        return resp.text[:300]


def create_pull_request(target: models.GitTarget, head: str, base: str, ahead: int, src_branch: str) -> tuple[str | None, str]:
    gh = github_repo(target.url)
    token = target_token(target)
    if not gh or not token:
        return None, "No se pudo abrir el Pull Request automaticamente (no es github.com o falta el token)."
    owner, name = gh
    body = (f"Cambios de la cuenta colaboradora, sincronizados por DevOps Sidecar desde `{target.repo.name}`.\n\n"
            f"- Rama de origen: `{src_branch}`\n- Commits nuevos: {ahead}\n\n"
            "Revise y apruebe desde la cuenta principal. El sidecar nunca sube directo a la rama protegida ni fuerza cambios.")
    try:
        r = github_api("POST", f"/repos/{owner}/{name}/pulls", token,
                       {"title": f"Sincronizar {src_branch} desde {target.repo.name}", "head": head, "base": base, "body": body})
        if r.status_code == 201:
            return r.json().get("html_url"), "Pull Request creado."
        if r.status_code == 422 and "already exists" in r.text.lower():
            g = github_api("GET", f"/repos/{owner}/{name}/pulls", token, params={"head": f"{owner}:{head}", "state": "open"})
            if g.status_code == 200 and g.json():
                return g.json()[0].get("html_url"), "El Pull Request ya estaba abierto y quedo actualizado con los commits nuevos."
        return None, f"La rama se subio, pero GitHub no creo el Pull Request ({r.status_code}: {_github_msg(r)})."
    except httpx.HTTPError as e:
        return None, f"La rama se subio, pero no se pudo contactar la API de GitHub: {e}"


def check_github_access(target: models.GitTarget) -> tuple[bool | None, str]:
    """Consulta la API para confirmar acceso y permiso de escritura.
    Devuelve (None, '') si no aplica (no es github.com o no hay token)."""
    gh = github_repo(target.url)
    token = target_token(target)
    if not gh or not token:
        return None, ""
    owner, name = gh
    try:
        r = github_api("GET", f"/repos/{owner}/{name}", token)
    except httpx.HTTPError as e:
        return None, f"(No se pudo consultar la API de GitHub: {e})"
    if r.status_code == 404:
        hint = ""
        if token.startswith("github_pat_"):
            hint = (" Es un token de grano fino: esos solo acceden a repositorios de SU cuenta o de organizaciones;"
                    " para un repositorio personal de otra cuenta use un token clasico con alcance 'repo'.")
        return False, "GitHub no muestra ese repositorio con este token (no existe o no tiene acceso)." + hint
    if r.status_code == 401:
        return False, "GitHub rechazo el token (vencido o revocado)."
    if r.status_code != 200:
        return None, f"(API de GitHub respondio {r.status_code}: {_github_msg(r)})"
    perms = r.json().get("permissions") or {}
    if not perms.get("push"):
        return False, "El token puede leer el repositorio pero NO escribir en el: pida a la cuenta principal permiso de escritura (Write) o use un token con alcance 'repo'."
    return True, "Token con permiso de escritura en GitHub."


# ------------------------------- validacion --------------------------------
def conflicts(db: Session, repo: models.Repo, purpose: str, url: str) -> str | None:
    """Reglas que evitan destruir un repositorio real."""
    norm = normalize_url(url)
    if norm == normalize_url(repo.github_url):
        return "El destino no puede ser el mismo repositorio de origen."
    if purpose == "mirror":
        for other in db.query(models.Repo).all():
            if normalize_url(other.github_url) == norm:
                return (f"Ese repositorio esta registrado en el sidecar ('{other.name}'). Un mirror de respaldo debe ir a un"
                        " repositorio APARTE: nunca se usa --mirror sobre un repositorio de trabajo.")
        for t in db.query(models.GitTarget).filter(models.GitTarget.purpose == "upstream").all():
            if normalize_url(t.url) == norm:
                return "Ese repositorio es el principal de una sincronizacion colaborador -> principal; no puede ser un mirror."
    return None


# --------------------------------- pruebas ---------------------------------
def test_target(db: Session, target: models.GitTarget) -> tuple[bool, str]:
    env = env_for(target)
    ok, refs, err = ls_remote(target.url, env, ("--heads", "--tags"))
    if not ok:
        return False, "No se pudo conectar: " + err + _auth_hint(err)
    notes = []
    api_ok, api_msg = check_github_access(target)
    if api_ok is False:
        return False, api_msg
    if api_msg:
        notes.append(api_msg)
    heads = {r[len("refs/heads/"):] for r in refs if r.startswith("refs/heads/")}
    if target.purpose == "mirror":
        if not heads:
            notes.append("El destino esta vacio: listo para el primer mirror.")
        elif target.mirror_mode == "exacto":
            ok_src, src_refs, _ = ls_remote(git_service.strip_credentials(target.repo.github_url), source_env(target.repo))
            if ok_src:
                src_heads = {r[len("refs/heads/"):] for r in src_refs if r.startswith("refs/heads/")}
                gone = sorted(heads - src_heads)
                if gone:
                    notes.append("ATENCION: el mirror exacto BORRARA en el destino estas ramas que no existen en el origen: "
                                 + ", ".join(gone[:15]) + (" ..." if len(gone) > 15 else ""))
    else:
        base = target.base_branch or remote_default_branch(target.url, env) or "main"
        if base in heads:
            notes.append(f"Rama base '{base}' encontrada en el principal.")
        else:
            notes.append(f"AVISO: la rama base '{base}' no existe en el principal.")
    return True, "Conexion correcta (" + f"{len(heads)} rama(s) en el destino). " + " ".join(notes)


# -------------------------------- ejecucion --------------------------------
def _fetch_source(repo: models.Repo, ws: Path, refspecs: list[str]) -> None:
    url = git_service.strip_credentials(repo.github_url)
    r = _git(["fetch", "--prune", "--no-tags", "-q", url, *refspecs], cwd=ws, env=source_env(repo), timeout=1800)
    if r.returncode != 0:
        raise RuntimeError("No se pudo leer el repositorio de origen: " + _err(r))


def _run_mirror(target: models.GitTarget, log) -> tuple[str, str]:
    ws = _ensure_ws(target)
    _fetch_source(target.repo, ws, ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"])
    heads = _heads(ws, "refs/heads/")
    tags = _heads(ws, "refs/tags/")
    log(f"Origen leido: {len(heads)} rama(s), {len(tags)} etiqueta(s).")
    if not heads:
        # Si el origen quedo vacio (repo borrado/vaciado), no se vacia el respaldo.
        raise RuntimeError("El origen no tiene ramas: no se envia nada para no vaciar el respaldo.")
    env = env_for(target)
    if target.mirror_mode == "exacto":
        args = ["push", "--mirror", "--porcelain", target.url]
    else:
        args = ["push", "--porcelain", target.url, "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"]
    r = _git(args, cwd=ws, env=env, timeout=3600)
    res = _parse_porcelain(r.stdout)
    summary = (f"{len(res['nuevas'])} nueva(s), {len(res['actualizadas'])} actualizada(s), {res['al_dia']} sin cambios"
               + (f", {len(res['borradas'])} borrada(s)" if res["borradas"] else "")
               + (f", {len(res['forzadas'])} reescrita(s)" if res["forzadas"] else ""))
    log("Envio: " + summary)
    if r.returncode != 0 and not res["rechazadas"]:
        err = _err(r)
        raise RuntimeError("Fallo el envio al destino: " + err + _auth_hint(err))
    notes = []
    rewritten = [ref for ref in res["rechazadas_refs"] if ref.startswith("refs/heads/")]
    if rewritten:
        notes.append(_preserve_and_update(target, ws, env, rewritten, log))
    other = [x for x, ref in zip(res["rechazadas"], res["rechazadas_refs"]) if not ref.startswith("refs/heads/")]
    if other:
        log("Etiquetas que cambiaron en el origen; el respaldo conserva la original: " + "; ".join(other[:20]))
        notes.append(f"{len(other)} etiqueta(s) movida(s) en el origen: el respaldo conserva la original")
    info = ""
    if target.mirror_mode != "exacto":
        ok, refs, _ = ls_remote(target.url, env)
        if ok:
            kept = sorted(b for b in ({r[len("refs/heads/"):] for r in refs} - set(heads)) if not b.startswith(PRESERVED_PREFIX))
            if kept:
                # Informativo: es justamente para lo que sirve el modo protegido.
                log("Ramas que ya no existen en el origen y se conservan en el respaldo: " + ", ".join(kept[:20]))
                info = f" Se conservan {len(kept)} rama(s) que ya no existen en el origen."
    if notes:
        return "aviso", "Mirror enviado (" + summary + "). " + "; ".join(notes) + "." + info
    return "ok", "Mirror enviado (" + summary + ")." + info


def _preserve_and_update(target: models.GitTarget, ws: Path, env: dict, rewritten: list[str], log) -> str:
    """Modo protegido y el origen reescribio historial (force-push) de
    estas ramas: la version que tenia el respaldo se guarda en una rama
    sidecar-conservado/<rama>-<fecha> del destino y recien entonces la rama
    se actualiza, con --force-with-lease sobre exactamente la punta que se
    conservo. Asi el respaldo sigue recibiendo commits nuevos y no se
    pierde nada."""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    names = [ref[len("refs/heads/"):] for ref in rewritten]
    r = _git(["fetch", "--no-tags", "-q", target.url, *[f"+refs/heads/{b}:refs/conservado/{b}" for b in names]],
             cwd=ws, env=env, timeout=1800)
    if r.returncode != 0:
        log("No se pudo leer la version anterior del respaldo; esas ramas quedan sin actualizar: " + _err(r))
        return f"{len(names)} rama(s) reescritas en el origen quedaron sin actualizar (el respaldo conserva la version anterior)"
    done = []
    for b in names:
        old = (_git(["rev-parse", f"refs/conservado/{b}"], cwd=ws, timeout=30).stdout or "").strip()
        keep = f"{PRESERVED_PREFIX}{b}-{stamp}"
        p1 = _git(["push", "--porcelain", target.url, f"refs/conservado/{b}:refs/heads/{keep}"], cwd=ws, env=env, timeout=1800)
        if p1.returncode != 0:
            log(f"No se pudo guardar la version anterior de '{b}'; no se actualiza: " + _err(p1))
            continue
        p2 = _git(["push", "--porcelain", f"--force-with-lease=refs/heads/{b}:{old}", target.url, f"refs/heads/{b}:refs/heads/{b}"],
                  cwd=ws, env=env, timeout=1800)
        if p2.returncode != 0:
            log(f"'{b}' cambio en el respaldo mientras tanto; no se actualiza: " + _err(p2))
            continue
        log(f"'{b}' fue reescrita en el origen: la version anterior del respaldo quedo en '{keep}' y '{b}' se actualizo.")
        done.append(keep)
    for ref in _heads(ws, "refs/conservado/"):
        _git(["update-ref", "-d", f"refs/conservado/{ref}"], cwd=ws, timeout=30)
    if len(done) == len(names):
        return f"{len(names)} rama(s) reescritas en el origen (force-push): la version anterior se conserva en " + ", ".join(done)
    return (f"{len(names)} rama(s) reescritas en el origen: {len(done)} actualizadas conservando la version anterior"
            + (f" ({', '.join(done)})" if done else "") + "; el resto quedo sin actualizar (ver historial)")


def _run_upstream(target: models.GitTarget, log) -> tuple[str, str, str | None]:
    repo = target.repo
    ws = _ensure_ws(target)
    _fetch_source(repo, ws, ["+refs/heads/*:refs/source/*"])
    src_branch = target.source_branch or remote_default_branch(git_service.strip_credentials(repo.github_url), source_env(repo)) or "main"
    src_heads = _heads(ws, "refs/source/")
    if src_branch not in src_heads:
        raise RuntimeError(f"La rama '{src_branch}' no existe en el repositorio colaborador.")
    env = env_for(target)
    base = target.base_branch or remote_default_branch(target.url, env) or "main"
    log(f"Colaborador: {repo.name} rama '{src_branch}'  ->  principal: rama '{base}'.")
    r = _git(["fetch", "--no-tags", "-q", target.url, f"+refs/heads/{base}:refs/upstream/{base}"], cwd=ws, env=env, timeout=1800)
    if r.returncode != 0:
        err = _err(r)
        if "couldn't find remote ref" in err.lower():
            raise RuntimeError(f"La rama base '{base}' no existe en el repositorio principal.")
        raise RuntimeError("No se pudo leer el repositorio principal: " + err + _auth_hint(err))
    src_ref, base_ref = f"refs/source/{src_branch}", f"refs/upstream/{base}"
    if _git(["merge-base", base_ref, src_ref], cwd=ws, timeout=120).returncode != 0:
        raise RuntimeError("El repositorio colaborador y el principal no comparten historial: no se puede sincronizar.")
    counts = (_git(["rev-list", "--left-right", "--count", f"{base_ref}...{src_ref}"], cwd=ws, timeout=300).stdout or "0 0").split()
    behind, ahead = int(counts[0]), int(counts[1])
    log(f"El colaborador va {ahead} commit(s) adelante y {behind} atras del principal.")
    if ahead == 0:
        return "ok", f"Nada que sincronizar: el principal ya tiene todos los commits de '{src_branch}'.", None

    if target.push_mode == "directo":
        if behind:
            return ("aviso", f"No se subio: el principal tiene {behind} commit(s) que el colaborador no tiene y subir"
                    " directo seria sobrescribirlos. Actualice primero el repositorio colaborador o use el modo Pull Request.", None)
        r = _git(["push", "--porcelain", target.url, f"{src_ref}:refs/heads/{base}"], cwd=ws, env=env, timeout=1800)
        if r.returncode != 0:
            err = _err(r)
            hint = " Si la rama esta protegida, use el modo Pull Request." if "protected" in err.lower() or "gh006" in err.lower() else ""
            raise RuntimeError("El principal rechazo el envio directo: " + err + hint + _auth_hint(err))
        return "ok", f"{ahead} commit(s) subidos directo a '{base}' (avance rapido, sin forzar).", None

    head = SYNC_BRANCH_PREFIX + src_branch
    args = ["push", "--porcelain"]
    if "gitlab" in (urlsplit(target.url).hostname or "").lower():
        args += ["-o", "merge_request.create", "-o", f"merge_request.target={base}",
                 "-o", f"merge_request.title=Sincronizar {src_branch} desde {repo.name}"]
    r = _git([*args, target.url, f"{src_ref}:refs/heads/{head}"], cwd=ws, env=env, timeout=1800)
    if r.returncode != 0:
        res = _parse_porcelain(r.stdout)
        err = _err(r)
        if res["rechazadas"]:
            raise RuntimeError(f"La rama '{head}' del principal tiene commits que el colaborador no tiene (alguien la"
                               " modifico o el colaborador reescribio historial). No se fuerza: revise o borre esa rama en el principal.")
        raise RuntimeError("El principal rechazo el envio: " + err + _auth_hint(err))
    log(f"Rama '{head}' actualizada en el principal ({ahead} commit(s)).")
    if github_repo(target.url):
        pr_url, msg = create_pull_request(target, head, base, ahead, src_branch)
        log(msg + (f" {pr_url}" if pr_url else ""))
        return ("ok" if pr_url else "aviso"), f"{ahead} commit(s) en la rama '{head}'. {msg}", pr_url
    if "gitlab" in (urlsplit(target.url).hostname or "").lower():
        return "ok", f"{ahead} commit(s) en la rama '{head}'; GitLab crea o actualiza el Merge Request hacia '{base}'.", None
    return "aviso", f"{ahead} commit(s) en la rama '{head}'. Abra el Pull Request / Merge Request hacia '{base}' desde la web del servidor Git.", None


def run_target(target_id: int, trigger: str = "manual") -> int | None:
    lock = _lock_for(target_id)
    if not lock.acquire(blocking=False):
        return None
    db = SessionLocal()
    lines: list[str] = []

    def log(msg: str) -> None:
        lines.append(f"[{datetime.now():%H:%M:%S}] {msg}")
        logger.info("git target %s: %s", target_id, msg)

    try:
        target = db.get(models.GitTarget, target_id)
        if not target:
            return None
        run = models.GitTargetRun(target_id=target.id, trigger=trigger)
        db.add(run)
        db.commit()
        pr_url = None
        try:
            if target.purpose == "mirror":
                log(f"Mirror {'EXACTO' if target.mirror_mode == 'exacto' else 'protegido'} de '{target.repo.name}' -> {git_service.strip_credentials(target.url)}")
                status, message = _run_mirror(target, log)
            else:
                status, message, pr_url = _run_upstream(target, log)
        except Exception as e:  # noqa: BLE001 - el resultado se registra, no debe tumbar el scheduler
            status, message = "error", str(e)[:900]
            log("ERROR: " + message)
        run.status = status
        run.finished_at = datetime.utcnow()
        run.log = "\n".join(lines)
        target.last_run_at = datetime.utcnow()
        target.last_status = status
        target.last_message = message
        if pr_url:
            target.last_pr_url = pr_url
        db.commit()
        # Historial acotado: ultimas 50 ejecuciones por destino.
        old = db.query(models.GitTargetRun).filter_by(target_id=target.id).order_by(models.GitTargetRun.id.desc()).offset(50).all()
        for o in old:
            db.delete(o)
        db.commit()
        return run.id
    finally:
        db.close()
        lock.release()


def run_after_sync(repo_id: int) -> None:
    """Lo llama el scheduler despues de cada sincronizacion correcta."""
    db = SessionLocal()
    try:
        ids = [t.id for t in db.query(models.GitTarget).filter_by(repo_id=repo_id, enabled=True, schedule="after_sync").all()]
    finally:
        db.close()
    for tid in ids:
        run_target(tid, "tras_sync")


def remove_workspace(target: models.GitTarget) -> None:
    import shutil
    shutil.rmtree(workspace(target), ignore_errors=True)
