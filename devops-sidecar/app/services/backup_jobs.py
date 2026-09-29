"""Trabajos de respaldo programados, estilo Veeam: cadenas de un completo
seguido de N incrementales por (trabajo, repositorio), envio a destinos
externos y retencion por cadenas.

Formato de los respaldos de un repo (restaurables con git, sin esta app):
- Completo:     git bundle con TODAS las referencias (--all).
- Incremental:  git bundle solo con los commits nuevos desde el punto
                anterior (--all --not <puntas anteriores>). Necesita el
                completo y los incrementales previos de su cadena.
- Opcional:     archivos del working tree sin .git (solo en completos) y
                un .diff legible con los cambios desde el punto anterior.
Cada carpeta de cadena lleva RESTAURAR.txt y manifest.json con los pasos
y el SHA-256 de cada archivo.

La retencion trabaja por cadenas enteras (local y remota por separado):
nunca borra un completo del que dependa un incremental que se conserva.
"""
import gzip
import hashlib
import json
import logging
import re
import shutil
import sqlite3
import tarfile
import threading
from datetime import datetime
from pathlib import Path

from sqlalchemy.orm import Session

from .. import models
from ..config import settings
from ..database import SessionLocal
from . import git_service, rclone_service

logger = logging.getLogger("backup_jobs")
_locks: dict[int, threading.Lock] = {}
_locks_guard = threading.Lock()
DB_KEY = "_sidecar_db"


def _lock_for(job_id: int) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(job_id, threading.Lock())


def is_running(job_id: int) -> bool:
    return _lock_for(job_id).locked()


def slug(text: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", text or "").strip("-.")
    return s[:80] or "sin-nombre"


def job_repo_ids(job: models.BackupJob) -> list[int]:
    try:
        return [int(x) for x in json.loads(job.repo_ids_json or "[]")]
    except (ValueError, TypeError):
        return []


def job_destination_ids(job: models.BackupJob) -> list[int]:
    try:
        return [int(x) for x in json.loads(job.destination_ids_json or "[]")]
    except (ValueError, TypeError):
        return []


def jobs_root() -> Path:
    return Path(settings.backups_path) / "jobs"


def chain_dir(job: models.BackupJob, repo_key: str, chain_label: str) -> Path:
    return jobs_root() / str(job.id) / repo_key / chain_label


def remote_sub(job: models.BackupJob, repo_key: str, chain_label: str) -> str:
    return f"{slug(job.name)}/{repo_key}/{chain_label}"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _git(args, cwd, timeout=900):
    return git_service._run(["git", *args], cwd=cwd, timeout=timeout)


def _ref_tips(local_path: str) -> list[str]:
    r = _git(["for-each-ref", "--format=%(objectname)"], local_path, 120)
    tips = set((r.stdout or "").split())
    head = (_git(["rev-parse", "HEAD"], local_path, 30).stdout or "").strip()
    if head:
        tips.add(head)
    return sorted(tips)


def _all_present(local_path: str, shas: list[str]) -> bool:
    for sha in shas:
        if _git(["cat-file", "-e", sha], local_path, 30).returncode != 0:
            return False
    return True


def _chain_points(db: Session, job_id: int, repo_key: str) -> list[models.BackupPoint]:
    """Puntos del trabajo para un repo (o la base del sidecar), del mas
    nuevo al mas viejo."""
    q = db.query(models.BackupPoint).filter(models.BackupPoint.job_id == job_id)
    if repo_key == DB_KEY:
        q = q.filter(models.BackupPoint.repo_name == DB_KEY)
    else:
        q = q.filter(models.BackupPoint.repo_name == repo_key)
    return q.order_by(models.BackupPoint.id.desc()).all()


def _write_chain_docs(folder: Path, repo_name: str, points: list[dict]) -> None:
    """manifest.json + RESTAURAR.txt de la cadena (se reescriben en cada
    punto nuevo, asi la carpeta remota siempre explica como restaurarse)."""
    (folder / "manifest.json").write_text(json.dumps({"repo": repo_name, "points": points}, indent=2), encoding="utf-8")
    bundles = [f["name"] for p in points for f in p["files"] if f["name"].endswith(".bundle")]
    lines = [
        f"Respaldo de '{repo_name}' generado por DevOps Sidecar.",
        "",
        "Restaurar con git (no hace falta el sidecar):",
        "  git init --bare restaurado.git",
    ]
    for b in bundles:
        lines.append(f'  git -C restaurado.git fetch "$(pwd)/{b}" "+refs/*:refs/*"')
    lines += [
        "  git clone restaurado.git trabajo",
        "",
        "Aplique los bundles EN ORDEN (00 = completo, luego 01, 02...).",
        "Si la carpeta viene de un destino cifrado, descargue primero con",
        "rclone y el remoto 'crypt' configurado con la misma contrasena.",
        "Integridad: sha256sum -c <(... ) usando los hashes de manifest.json.",
    ]
    (folder / "RESTAURAR.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _content_tar(local_path: str, dest: Path) -> None:
    src = Path(local_path)
    with tarfile.open(dest, "w:gz") as tar:
        for item in sorted(src.iterdir()):
            if item.name == ".git":
                continue
            tar.add(item, arcname=item.name)


def create_repo_point(db: Session, job: models.BackupJob, run: models.BackupJobRun,
                      repo: models.Repo, log) -> models.BackupPoint | None:
    """Crea el siguiente punto (completo o incremental) de un repo.
    Devuelve None si no hubo cambios desde el punto anterior."""
    local = repo.local_path
    repo_key = slug(repo.name)
    history = _chain_points(db, job.id, repo_key)
    last = history[0] if history else None
    prev_refs = json.loads(last.refs_json) if last and last.refs_json else []

    full = True
    reason = "primer respaldo"
    if last and job.include_bundle:
        chain = [p for p in history if p.chain_id == last.chain_id]
        if len(chain) - 1 >= job.incrementals_per_full:
            reason = f"la cadena ya tiene {len(chain) - 1} incrementales"
        elif not prev_refs or not _all_present(local, prev_refs):
            reason = "el historial del repo cambio (force-push o re-clonado)"
        else:
            full = False

    now = datetime.now()
    stamp = now.strftime("%Y%m%d_%H%M%S")
    if full:
        chain_label = stamp
        seq = 0
    else:
        chain = [p for p in history if p.chain_id == last.chain_id]
        chain_label = last.chain_label
        seq = max(p.seq for p in chain) + 1
    folder = chain_dir(job, repo_key, chain_label)
    folder.mkdir(parents=True, exist_ok=True)

    files: list[Path] = []
    tips = _ref_tips(local)
    if job.include_bundle:
        name = f"{seq:02d}_{'completo' if full else 'incremental'}_{stamp}.bundle"
        args = ["bundle", "create", str(folder / name), "--all"]
        if not full:
            args += ["--not", *prev_refs]
        r = _git(args, local, 3600)
        if r.returncode != 0:
            if not full and "empty bundle" in (r.stderr or "").lower():
                log(f"  {repo.name}: sin commits nuevos desde el punto anterior; no se crea incremental.")
                if not any(folder.iterdir()):
                    folder.rmdir()
                return None
            raise RuntimeError("git bundle fallo: " + (r.stderr or "")[:400])
        files.append(folder / name)
    if job.include_diff:
        args = ["log", "-p", "--no-color", "--all"]
        args += ["--not", *prev_refs] if prev_refs and _all_present(local, prev_refs) else ["--since=1.day.ago"]
        diff = _git(args, local, 600).stdout or ""
        if diff.strip():
            p = folder / f"{seq:02d}_cambios_{stamp}.diff"
            p.write_text(diff, encoding="utf-8")
            files.append(p)
    if full and job.include_content:
        p = folder / f"{seq:02d}_archivos_{stamp}.tar.gz"
        _content_tar(local, p)
        files.append(p)
    if not files:
        log(f"  {repo.name}: nada que respaldar con el contenido elegido.")
        if not any(folder.iterdir()):
            folder.rmdir()
        return None

    entries = [{"name": f.name, "size": f.stat().st_size, "sha256": _sha256(f)} for f in files]
    point = models.BackupPoint(
        job_id=job.id, run_id=run.id, repo_id=repo.id, repo_name=repo_key,
        kind="full" if full else "incremental", seq=seq, chain_label=chain_label,
        files_json=json.dumps(entries), refs_json=json.dumps(tips),
        total_bytes=sum(e["size"] for e in entries),
        chain_id=None if full else last.chain_id,
    )
    db.add(point)
    db.flush()
    if full:
        point.chain_id = point.id
    db.commit()

    chain_points = [p for p in _chain_points(db, job.id, repo_key) if p.chain_id == point.chain_id]
    docs = [{"seq": p.seq, "kind": p.kind, "created_at": p.created_at.isoformat(), "files": json.loads(p.files_json)}
            for p in sorted(chain_points, key=lambda x: x.seq)]
    _write_chain_docs(folder, repo.name, docs)
    kind_text = "COMPLETO" if full else f"INCREMENTAL #{seq}"
    log(f"  {repo.name}: {kind_text} ({point.total_bytes / 1024:.1f} KB){' - ' + reason if full else ''}")
    return point


def create_db_point(db: Session, job: models.BackupJob, run: models.BackupJobRun, log) -> models.BackupPoint:
    """Copia consistente de sidecar.db (API de backup de sqlite), gzip."""
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    folder = chain_dir(job, DB_KEY, stamp)
    folder.mkdir(parents=True, exist_ok=True)
    raw = folder / "sidecar.db"
    src = sqlite3.connect(settings.database_path)
    dst = sqlite3.connect(str(raw))
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    gz = folder / f"sidecar_{stamp}.db.gz"
    with open(raw, "rb") as fin, gzip.open(gz, "wb") as fout:
        shutil.copyfileobj(fin, fout)
    raw.unlink()
    (folder / "RESTAURAR.txt").write_text(
        "Base de configuracion del DevOps Sidecar (SQLite comprimido).\n"
        "Restaurar: descomprimir (gunzip) y subirla en Configuracion -> Restaurar base,\n"
        "o reemplazar /data/db/sidecar.db con el contenedor detenido.\n"
        "Los tokens y claves dentro estan cifrados: hace falta el mismo CREDENTIALS_ENC_KEY del .env.\n",
        encoding="utf-8")
    entry = {"name": gz.name, "size": gz.stat().st_size, "sha256": _sha256(gz)}
    (folder / "manifest.json").write_text(json.dumps({"repo": DB_KEY, "points": [
        {"seq": 0, "kind": "full", "created_at": datetime.utcnow().isoformat(), "files": [entry]}]}, indent=2), encoding="utf-8")
    point = models.BackupPoint(job_id=job.id, run_id=run.id, repo_id=None, repo_name=DB_KEY, kind="full", seq=0,
                               chain_label=stamp, files_json=json.dumps([entry]), total_bytes=entry["size"])
    db.add(point)
    db.flush()
    point.chain_id = point.id
    db.commit()
    log(f"  base del sidecar: copia de {entry['size'] / 1024:.1f} KB")
    return point


def sync_to_destinations(db: Session, job, destinations, log) -> int:
    """Envia a cada destino todo punto local que aun no este confirmado
    alli: los nuevos, los que fallaron antes (ej. OneDrive caido) y, si se
    agrega un destino, las cadenas conservadas. Solo cadenas dentro de la
    retencion remota (no se sube algo que se borraria enseguida).
    Devuelve la cantidad de envios fallidos."""
    failures = 0
    points = db.query(models.BackupPoint).filter(models.BackupPoint.job_id == job.id,
                                                 models.BackupPoint.local_deleted.is_(False)).all()
    ranked: dict[str, list[int]] = {}
    for p in sorted(points, key=lambda x: x.id, reverse=True):
        order = ranked.setdefault(p.repo_name, [])
        if p.chain_id not in order:
            order.append(p.chain_id)
    for dest in destinations:
        pending: dict[tuple[str, str], list[models.BackupPoint]] = {}
        for p in points:
            if ranked[p.repo_name].index(p.chain_id) >= max(1, job.keep_chains_remote):
                continue
            if any(t.destination_id == dest.id and t.status == "ok" for t in p.transfers):
                continue
            pending.setdefault((p.repo_name, p.chain_label), []).append(p)
        for (key, label), pts in sorted(pending.items()):
            folder = chain_dir(job, key, label)
            if not folder.exists():
                continue
            sub = remote_sub(job, key, label)
            ok, msg = rclone_service.upload_dir(db, dest, folder, sub)
            for p in pts:
                db.add(models.BackupTransfer(point_id=p.id, destination_id=dest.id, status="ok" if ok else "error",
                                             remote_path=sub, bytes=p.total_bytes if ok else 0, verified=ok, message=msg))
            db.commit()
            log(f"    -> {dest.name}: {key}/{label} ({len(pts)} punto(s)) {'OK' if ok else 'ERROR'} {msg}")
            failures += 0 if ok else 1
    return failures


def apply_retention(db: Session, job: models.BackupJob, log) -> None:
    """Conserva las ultimas N cadenas por repo (local y en cada destino por
    separado). Borra cadenas completas; nunca la cadena en curso."""
    keys = {p.repo_name for p in db.query(models.BackupPoint).filter(models.BackupPoint.job_id == job.id).all()}
    for key in keys:
        points = _chain_points(db, job.id, key)
        chain_ids = []
        for p in points:
            if p.chain_id not in chain_ids:
                chain_ids.append(p.chain_id)
        for idx, cid in enumerate(chain_ids):
            chain = [p for p in points if p.chain_id == cid]
            label = chain[0].chain_label
            if idx >= max(1, job.keep_chains_local) and not all(p.local_deleted for p in chain):
                shutil.rmtree(chain_dir(job, key, label), ignore_errors=True)
                for p in chain:
                    p.local_deleted = True
                log(f"  retencion local: borrada cadena {key}/{label}")
            if idx >= max(1, job.keep_chains_remote):
                done_dest = set()
                for p in chain:
                    for t in p.transfers:
                        if t.status != "ok" or t.destination_id in done_dest or t.destination is None:
                            continue
                        ok, msg = rclone_service.purge(db, t.destination, remote_sub(job, key, label))
                        done_dest.add(t.destination_id)
                        log(f"  retencion en {t.destination.name}: cadena {key}/{label} {'borrada' if ok else 'ERROR ' + msg}")
                        if ok:
                            for q in chain:
                                for tt in q.transfers:
                                    if tt.destination_id == t.destination_id and tt.status == "ok":
                                        tt.status = "borrado"
            db.commit()
            # Ya no queda en ningun lado: se quitan las filas.
            if all(p.local_deleted for p in chain) and not any(t.status == "ok" for p in chain for t in p.transfers):
                for p in chain:
                    db.delete(p)
                db.commit()


def run_job(job_id: int, trigger: str = "programado") -> int | None:
    """Ejecuta un trabajo. Devuelve el id de la ejecucion, o None si ya
    habia una en curso del mismo trabajo."""
    lock = _lock_for(job_id)
    if not lock.acquire(blocking=False):
        logger.warning("El trabajo %s ya esta en ejecucion; se omite esta llamada.", job_id)
        return None
    db = SessionLocal()
    lines: list[str] = []

    def log(msg: str) -> None:
        lines.append(f"[{datetime.now():%H:%M:%S}] {msg}")
        logger.info("job %s: %s", job_id, msg)

    try:
        job = db.get(models.BackupJob, job_id)
        if not job:
            return None
        run = models.BackupJobRun(job_id=job.id, trigger=trigger)
        db.add(run)
        db.commit()
        log(f"Inicio del trabajo '{job.name}' ({trigger}).")

        repo_ids = job_repo_ids(job)
        q = db.query(models.Repo).filter(models.Repo.active.is_(True))
        if repo_ids:
            q = db.query(models.Repo).filter(models.Repo.id.in_(repo_ids))
        repos = q.order_by(models.Repo.name).all()
        dest_ids = job_destination_ids(job)
        destinations = [d for d in db.query(models.BackupDestination).filter(models.BackupDestination.id.in_(dest_ids)).all()
                        if d.enabled] if dest_ids else []
        if dest_ids and not destinations:
            log("AVISO: los destinos elegidos estan desactivados; solo se respalda en el servidor.")

        errors = warnings = 0
        new_points = []
        for repo in repos:
            if not (Path(repo.local_path) / ".git").exists():
                log(f"  {repo.name}: todavia no esta clonado; se omite.")
                warnings += 1
                continue
            try:
                point = create_repo_point(db, job, run, repo, log)
                if point:
                    new_points.append(point)
            except Exception as e:  # noqa: BLE001 - un repo con problemas no debe frenar a los demas
                db.rollback()
                errors += 1
                log(f"  {repo.name}: ERROR {e}")
        if job.include_sidecar_db:
            try:
                new_points.append(create_db_point(db, job, run, log))
            except Exception as e:  # noqa: BLE001
                db.rollback()
                errors += 1
                log(f"  base del sidecar: ERROR {e}")

        if destinations:
            log(f"Sincronizando con {len(destinations)} destino(s)...")
            errors += sync_to_destinations(db, job, destinations, log)

        apply_retention(db, job, log)

        run.status = "error" if errors else ("ok_con_avisos" if warnings else "ok")
        log(f"Fin: {run.status} ({len(new_points)} punto(s) nuevo(s), {errors} error(es)).")
        run.finished_at = datetime.utcnow()
        run.log = "\n".join(lines)
        job.last_run_at = datetime.utcnow()
        job.last_status = run.status
        db.commit()
        return run.id
    except Exception as e:  # noqa: BLE001
        logger.exception("Fallo el trabajo %s", job_id)
        try:
            db.rollback()
            job = db.get(models.BackupJob, job_id)
            lines.append(f"ERROR GENERAL: {e}")
            if job:
                job.last_status = "error"
                job.last_run_at = datetime.utcnow()
                last_run = db.query(models.BackupJobRun).filter_by(job_id=job_id).order_by(models.BackupJobRun.id.desc()).first()
                if last_run and last_run.status == "en_curso":
                    last_run.status = "error"
                    last_run.finished_at = datetime.utcnow()
                    last_run.log = "\n".join(lines)
                db.commit()
        except Exception:  # noqa: BLE001
            pass
        return None
    finally:
        db.close()
        lock.release()
