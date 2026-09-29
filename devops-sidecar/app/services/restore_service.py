"""Restauracion de los respaldos de los trabajos programados, desde el
servidor o desde un destino externo (tambien cifrado).

Trabaja con la carpeta de la cadena y su manifest.json, no con las filas
de la base: asi sirve igual cuando se perdio el servidor y solo queda el
destino externo (se explora el destino y se elige la cadena).

Pasos: descargar la cadena (si viene de un destino) -> verificar el
SHA-256 de cada archivo contra el manifest -> crear un repo bare y
aplicar el completo y los incrementales EN ORDEN hasta el punto elegido
(git bundle verify + fetch) -> git fsck -> dejar las ramas como ramas
normales. Luego, segun el modo:
- verificar: solo informa (prueba de restauracion) y borra todo.
- descargar: deja un .tar.gz con el repositorio git completo y un .zip
  con los archivos de la rama principal, para bajarlos desde el navegador.
- subir: envia ramas y etiquetas a un repositorio Git (idealmente vacio),
  sin forzar nunca.
Los archivos generados se borran solos a los RESTORE_KEEP_DAYS dias.
"""
import gzip
import json
import logging
import re
import shutil
import sqlite3
import tarfile
import threading
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy.orm import Session

from .. import models
from ..config import settings
from ..database import SessionLocal
from . import backup_jobs, git_service, git_targets, rclone_service

logger = logging.getLogger("restore")
RESTORE_KEEP_DAYS = 3
_lock = threading.Lock()  # una restauracion a la vez (disco y CPU)
_SEG = re.compile(r"^[A-Za-z0-9._-]+$")
_POINT_FILE = re.compile(r"^(\d{2})_(completo|incremental|cambios|archivos)_")


class RestoreError(Exception):
    pass


def is_busy() -> bool:
    return _lock.locked()


def restores_root() -> Path:
    return Path(settings.backups_path) / "restores"


def restore_dir(restore_id: int) -> Path:
    return restores_root() / str(restore_id)


def valid_chain_path(path: str) -> bool:
    segs = (path or "").strip("/").split("/")
    return len(segs) == 3 and all(_SEG.match(s) and s not in (".", "..") for s in segs)


# ------------------------------ explorar destino -----------------------------
def explore_destination(db: Session, dest: models.BackupDestination) -> list[dict]:
    """Cadenas que hay en un destino (carpetas trabajo/repo/cadena), con
    sus puntos deducidos de los nombres de archivo. Con destino cifrado
    rclone devuelve los nombres ya descifrados."""
    with rclone_service.RcloneSession(dest) as s:
        r = s.run(["lsjson", "-R", "--files-only", "--max-depth", "4", s.path()], timeout=900)
    rclone_service.persist_new_token(db, dest, s)
    if r.returncode != 0:
        raise RestoreError("No se pudo listar el destino: " + rclone_service._err(r))
    chains: dict[str, dict] = {}
    for item in json.loads(r.stdout or "[]"):
        parts = item.get("Path", "").split("/")
        if len(parts) != 4:
            continue
        key, name, size = "/".join(parts[:3]), parts[3], int(item.get("Size") or 0)
        c = chains.setdefault(key, {"path": key, "job": parts[0], "repo": parts[1], "chain_label": parts[2],
                                    "has_manifest": False, "is_db": parts[1] == backup_jobs.DB_KEY, "points": {}})
        if name == "manifest.json":
            c["has_manifest"] = True
            continue
        m = _POINT_FILE.match(name)
        seq = int(m.group(1)) if m else (0 if name.endswith(".db.gz") else None)
        if seq is None:
            continue
        p = c["points"].setdefault(seq, {"seq": seq, "kind": "full" if seq == 0 else "incremental", "files": [], "size": 0})
        p["files"].append({"name": name, "size": size})
        p["size"] += size
    out = []
    for c in chains.values():
        c["points"] = sorted(c["points"].values(), key=lambda p: p["seq"])
        if c["points"]:
            out.append(c)
    return sorted(out, key=lambda c: (c["job"], c["repo"], c["chain_label"]), reverse=False)


# ---------------------------------- limpieza ---------------------------------
def cleanup_old(db: Session) -> None:
    limit = datetime.utcnow() - timedelta(days=RESTORE_KEEP_DAYS)
    for rr in db.query(models.RestoreRun).filter(models.RestoreRun.created_at < limit,
                                                 models.RestoreRun.status != "en_curso").all():
        if rr.outputs_json and rr.outputs_json != "[]":
            shutil.rmtree(restore_dir(rr.id), ignore_errors=True)
            rr.outputs_json = "[]"
    db.commit()


# ---------------------------------- ejecucion --------------------------------
def _git(args, cwd, env=None, timeout=3600):
    return git_service._run(["git", *args], cwd=str(cwd), timeout=timeout, env=env)


def _gerr(r) -> str:
    lines = [ln for ln in (r.stderr or r.stdout or "").splitlines() if ln.strip()]
    return " | ".join(lines[-3:])[:500] or f"codigo {r.returncode}"


def _refs(bare: Path, prefix: str) -> dict[str, str]:
    r = _git(["for-each-ref", "--format=%(refname) %(objectname)", prefix], bare, timeout=120)
    return {ln.split(" ")[0][len(prefix):]: ln.split(" ")[1] for ln in (r.stdout or "").splitlines() if " " in ln}


def _verify_files(src: Path, points: list[dict], log) -> None:
    for p in points:
        for f in p["files"]:
            path = src / f["name"]
            if not path.exists():
                if f["name"].endswith(".bundle"):
                    raise RestoreError(f"Falta {f['name']} en la cadena: no se puede restaurar hasta el punto #{p['seq']}.")
                log(f"  aviso: falta {f['name']} (no es necesario para restaurar el historial)")
                continue
            if f.get("sha256") and backup_jobs._sha256(path) != f["sha256"]:
                raise RestoreError(f"{f['name']} esta DANADO: su SHA-256 no coincide con el del manifest.")
    log("Integridad: todos los archivos coinciden con el SHA-256 del manifest.")


def _build_repo(src: Path, points: list[dict], bare: Path, log) -> dict:
    r = _git(["init", "--bare", "-q", str(bare)], src)
    if r.returncode != 0:
        raise RestoreError("git init fallo: " + _gerr(r))
    last_bundle = None
    for p in points:
        bundles = [f["name"] for f in p["files"] if f["name"].endswith(".bundle")]
        if not bundles:
            raise RestoreError(f"El punto #{p['seq']} no tiene bundle de git (el trabajo no respaldaba el historial): "
                               "solo se pueden recuperar sus archivos sueltos.")
        for b in bundles:
            path = str(src / b)
            v = _git(["bundle", "verify", "-q", path], bare)
            if v.returncode != 0:
                raise RestoreError(f"{b}: git bundle verify fallo ({_gerr(v)}). Si es un incremental, falta un punto anterior.")
            f = _git(["fetch", "-q", path, "+refs/*:refs/*"], bare)
            if f.returncode != 0:
                raise RestoreError(f"No se pudo aplicar {b}: {_gerr(f)}")
            last_bundle = path
        log(f"  aplicado #{p['seq']:02d} ({'completo' if p['seq'] == 0 else 'incremental'})")
    fsck = _git(["fsck", "--no-progress", "--no-dangling"], bare)
    if fsck.returncode != 0:
        raise RestoreError("git fsck encontro problemas: " + _gerr(fsck))
    log("git fsck: repositorio consistente.")

    # El respaldo sale de un clon: sus ramas estan en refs/remotes/origin/*.
    # Se pasan a ramas normales para que un `git clone` las vea todas.
    for name, sha in _refs(bare, "refs/remotes/origin/").items():
        if name != "HEAD":
            _git(["update-ref", f"refs/heads/{name}", sha], bare, timeout=60)
    for name in _refs(bare, "refs/remotes/"):
        _git(["update-ref", "-d", f"refs/remotes/{name}"], bare, timeout=60)
    heads = _refs(bare, "refs/heads/")
    tags = _refs(bare, "refs/tags/")
    if not heads:
        raise RestoreError("El respaldo no contiene ramas.")
    head_sha = None
    listed = _git(["bundle", "list-heads", last_bundle], bare, timeout=120).stdout or ""
    for line in listed.splitlines():
        sha, _, ref = line.partition(" ")
        if ref.strip() == "HEAD":
            head_sha = sha
    candidates = [b for b, s in heads.items() if s == head_sha] or list(heads)
    branch = next((b for b in ("main", "master") if b in candidates), sorted(candidates)[0])
    _git(["symbolic-ref", "HEAD", f"refs/heads/{branch}"], bare, timeout=30)
    last = (_git(["log", "-1", "--date=short", "--format=%h %s (%an, %ad)", "HEAD"], bare, timeout=60).stdout or "").strip()
    count = (_git(["rev-list", "--count", "HEAD"], bare, timeout=600).stdout or "0").strip()
    log(f"Restaurado: {len(heads)} rama(s), {len(tags)} etiqueta(s). Rama principal '{branch}' con {count} commit(s); ultimo: {last}")
    return {"branch": branch, "heads": len(heads), "tags": len(tags)}


def _restore_repo(rr: models.RestoreRun, src: Path, work: Path, log, push: dict | None) -> list[dict]:
    mf = src / "manifest.json"
    if not mf.exists():
        raise RestoreError("La cadena no tiene manifest.json: no se puede verificar ni restaurar automaticamente (vea RESTAURAR.txt).")
    manifest = json.loads(mf.read_text(encoding="utf-8"))
    points = sorted([p for p in manifest.get("points", []) if p["seq"] <= rr.seq], key=lambda p: p["seq"])
    seqs = [p["seq"] for p in points]
    if not seqs or seqs[-1] != rr.seq:
        raise RestoreError(f"El punto #{rr.seq} no existe en esta cadena.")
    if seqs != list(range(len(seqs))):
        missing = sorted(set(range(rr.seq + 1)) - set(seqs))
        raise RestoreError(f"A la cadena le faltan los puntos {missing}: sin ellos no se puede llegar al #{rr.seq}.")
    log(f"Cadena {rr.chain_path}: completo + {len(points) - 1} incremental(es) hasta el punto #{rr.seq}.")
    _verify_files(src, points, log)
    bare = work / f"{rr.repo_name}.git"
    info = _build_repo(src, points, bare, log)
    outputs = []
    base = f"{rr.repo_name}_{rr.chain_path.split('/')[-1]}_p{rr.seq:02d}"
    if rr.mode == "descargar":
        tar_path = work / f"{base}.git.tar.gz"
        with tarfile.open(tar_path, "w:gz") as tar:
            tar.add(bare, arcname=f"{rr.repo_name}.git")
        zip_path = work / f"{base}_archivos.zip"
        z = _git(["archive", "--format=zip", "-o", str(zip_path), "HEAD"], bare)
        if z.returncode != 0:
            raise RestoreError("git archive fallo: " + _gerr(z))
        outputs = [{"name": p.name, "size": p.stat().st_size} for p in (tar_path, zip_path)]
        log(f"Listo para descargar: {tar_path.name} (repositorio git completo: git clone {rr.repo_name}.git) y "
            f"{zip_path.name} (archivos de la rama '{info['branch']}').")
    elif rr.mode == "subir":
        url = push["url"]
        env = git_service.header_env(push.get("user") or git_targets.default_user(url), push["token"]) \
            if push.get("token") and url.startswith("https://") else git_service.plain_env()
        # --atomic: si se rechaza una rama no se sube nada (ni etiquetas sueltas).
        r = _git(["push", "--atomic", "--porcelain", url, "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"], bare, env=env)
        res = git_targets._parse_porcelain(r.stdout)
        if r.returncode != 0:
            if res["rechazadas"]:
                raise RestoreError("El repositorio de destino ya tiene ramas con otro historial y no se fuerza: "
                                   + "; ".join(res["rechazadas"][:10]) + ". Use un repositorio vacio.")
            err = _gerr(r)
            raise RestoreError("No se pudo subir: " + err + git_targets._auth_hint(err))
        log(f"Subido a {git_service.strip_credentials(url)}: {len(res['nuevas'])} nueva(s), "
            f"{len(res['actualizadas'])} actualizada(s), {res['al_dia']} sin cambios. Nada se forzo.")
    else:
        log("Prueba de restauracion correcta: el punto se puede recuperar.")
    shutil.rmtree(bare, ignore_errors=True)
    return outputs


def _restore_db(rr: models.RestoreRun, src: Path, work: Path, log) -> list[dict]:
    files = sorted(src.glob("*.db.gz"))
    if not files:
        raise RestoreError("La cadena no tiene ninguna copia de la base.")
    gz = files[-1]
    mf = src / "manifest.json"
    if mf.exists():
        entries = {f["name"]: f for p in json.loads(mf.read_text(encoding="utf-8")).get("points", []) for f in p["files"]}
        if gz.name in entries and backup_jobs._sha256(gz) != entries[gz.name]["sha256"]:
            raise RestoreError(f"{gz.name} esta DANADO: su SHA-256 no coincide con el del manifest.")
        log("Integridad: SHA-256 correcto.")
    raw = work / "sidecar.db"
    try:
        with gzip.open(gz, "rb") as fin, open(raw, "wb") as fout:
            shutil.copyfileobj(fin, fout)
    except OSError as e:
        raise RestoreError(f"No se pudo descomprimir {gz.name}: {e}") from e
    con = sqlite3.connect(str(raw))
    try:
        check = con.execute("PRAGMA integrity_check").fetchone()[0]
        counts = {}
        for table, label in (("repos", "repositorios"), ("backup_jobs", "trabajos"), ("backup_destinations", "destinos")):
            try:
                counts[label] = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]  # noqa: S608 - nombres fijos
            except sqlite3.Error:
                counts[label] = "-"
    finally:
        con.close()
    raw.unlink(missing_ok=True)
    if check != "ok":
        raise RestoreError("La base restaurada no pasa el control de integridad de SQLite: " + str(check)[:200])
    log("Base SQLite integra: " + ", ".join(f"{v} {k}" for k, v in counts.items()) + ".")
    if rr.mode == "descargar":
        out = work / gz.name
        shutil.copy2(gz, out)
        log(f"Listo para descargar: {gz.name}. Para usarla: descomprimir y subirla en Configuracion -> Restaurar "
            "(hace falta el mismo CREDENTIALS_ENC_KEY).")
        return [{"name": out.name, "size": out.stat().st_size}]
    log("Prueba de restauracion correcta.")
    return []


def run_restore(restore_id: int, push: dict | None = None) -> None:
    if not _lock.acquire(blocking=False):
        db = SessionLocal()
        try:
            rr = db.get(models.RestoreRun, restore_id)
            if rr:
                rr.status, rr.log, rr.finished_at = "error", "Habia otra restauracion en curso; vuelva a intentarlo.", datetime.utcnow()
                db.commit()
        finally:
            db.close()
        return
    db = SessionLocal()
    lines: list[str] = []

    def log(msg: str) -> None:
        lines.append(f"[{datetime.now():%H:%M:%S}] {msg}")
        logger.info("restore %s: %s", restore_id, msg)

    rr = None
    work = restore_dir(restore_id)
    outputs: list[dict] = []
    try:
        rr = db.get(models.RestoreRun, restore_id)
        if not rr:
            return
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)
        log(f"Restauracion ({rr.mode}) de {rr.repo_name}, punto #{rr.seq}, desde {rr.source_label}.")
        if rr.destination_id:
            dest = db.get(models.BackupDestination, rr.destination_id)
            if not dest:
                raise RestoreError("El destino ya no existe.")
            src = work / "descarga"
            with rclone_service.RcloneSession(dest) as s:
                r = s.run(["copy", s.path(rr.chain_path), str(src)], timeout=rclone_service.LONG_TIMEOUT)
            rclone_service.persist_new_token(db, dest, s)
            if r.returncode != 0 or not src.exists():
                raise RestoreError("No se pudo descargar la cadena del destino: " + rclone_service._err(r))
            total = sum(f.stat().st_size for f in src.iterdir() if f.is_file())
            log(f"Descargado de '{dest.name}'{' (descifrado)' if dest.encrypt else ''}: {total / 1024:.1f} KB.")
        else:
            src = backup_jobs.jobs_root() / rr.chain_path
            if not src.exists():
                raise RestoreError("Esa cadena ya no esta en el servidor (la borro la retencion local): restaure desde un destino externo.")
        if rr.repo_name == backup_jobs.DB_KEY:
            outputs = _restore_db(rr, src, work, log)
        else:
            outputs = _restore_repo(rr, src, work, log, push)
        rr.status = "ok"
    except (RestoreError, rclone_service.RcloneError) as e:
        log("ERROR: " + str(e))
        if rr:
            rr.status = "error"
    except Exception as e:  # noqa: BLE001 - queda registrado en la restauracion
        logger.exception("Fallo la restauracion %s", restore_id)
        log(f"ERROR inesperado: {e}")
        if rr:
            rr.status = "error"
    finally:
        shutil.rmtree(work / "descarga", ignore_errors=True)
        if not outputs:
            shutil.rmtree(work, ignore_errors=True)
        if rr:
            rr.outputs_json = json.dumps(outputs)
            rr.log = "\n".join(lines)
            rr.finished_at = datetime.utcnow()
            db.commit()
        db.close()
        _lock.release()
