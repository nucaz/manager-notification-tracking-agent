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
import subprocess
import tarfile
import threading
import time
import traceback
from datetime import datetime, timedelta
from pathlib import Path

import httpx
from sqlalchemy.orm import Session

from .. import models
from ..config import settings
from ..database import SessionLocal
from . import backup_jobs, external_restore, external_sources, git_service, git_targets, rclone_service, sso_service

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
                                    "has_manifest": False, "is_db": parts[1] == backup_jobs.DB_KEY,
                                    "is_app": parts[1] == backup_jobs.APP_KEY, "is_ext": is_external(parts[1]), "points": {}})
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
        c["ext_kind"] = external_restore.kind_of_files([f["name"] for p in c["points"] for f in p["files"]]) if c["is_ext"] else None
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


def _restore_app(rr: models.RestoreRun, src: Path, work: Path, log) -> list[dict]:
    """Respaldo completo de la aplicacion principal: verificar (SHA-256 y
    contenido), descargar el .tar.gz o aplicarlo en la aplicacion."""
    files = sorted(src.glob("aplicacion_*.tar.gz"))
    if not files:
        raise RestoreError("La cadena no tiene ningun respaldo de la aplicacion.")
    archive = files[-1]
    mf = src / "manifest.json"
    if mf.exists():
        entries = {f["name"]: f for p in json.loads(mf.read_text(encoding="utf-8")).get("points", []) for f in p["files"]}
        if archive.name in entries and backup_jobs._sha256(archive) != entries[archive.name]["sha256"]:
            raise RestoreError(f"{archive.name} esta DANADO: su SHA-256 no coincide con el del manifest.")
        log("Integridad del archivo: SHA-256 correcto.")
    try:
        with tarfile.open(archive, "r:gz") as tar:
            names = tar.getnames()
            inner = json.loads(tar.extractfile("manifest.json").read().decode("utf-8"))
    except (tarfile.TarError, KeyError, ValueError, AttributeError) as e:
        raise RestoreError(f"No se pudo leer el respaldo: {e}") from e
    if "basedatos.sql.gz" not in names:
        raise RestoreError("El respaldo no trae la base de datos.")
    cant = inner.get("cantidades") or {}
    log(f"Respaldo del {str(inner.get('creado', '?'))[:16]} (servidor {inner.get('servidor', '?')}): "
        f"{(inner.get('archivos') or {}).get('cantidad', 0)} archivo(s), {cant.get('mobile_devices', '?')} celulares, "
        f"{cant.get('software_licenses', '?')} licencias, {cant.get('users', '?')} usuarios; "
        f".env cifrados: {'si' if (inner.get('secretos') or {}).get('incluidos') else 'NO'}.")
    if rr.mode == "descargar":
        out = work / archive.name
        shutil.copy2(archive, out)
        log(f"Listo para descargar: {archive.name}. Ver RESTAURAR.txt dentro del archivo.")
        return [{"name": out.name, "size": out.stat().st_size}]
    if rr.mode == "aplicar":
        log("Enviando a la aplicacion principal para restaurar (base y archivos)...")
        try:
            with open(archive, "rb") as f:
                r = httpx.post(backup_jobs._main_app("/restaurar"), content=f,
                               headers={"Authorization": f"Bearer {sso_service.app_backup_pass()}", "X-Confirmacion": "RESTAURAR TODO",
                                        "Content-Type": "application/gzip", "Content-Length": str(archive.stat().st_size)},
                               timeout=httpx.Timeout(3600, connect=15))
        except httpx.RequestError as e:
            raise RestoreError(f"La aplicacion principal no responde ({type(e).__name__}).") from e
        try:
            data = r.json()
        except ValueError:
            data = {}
        if r.status_code != 200 or not data.get("ok"):
            raise RestoreError(f"La aplicacion no restauro: {data.get('error') or 'HTTP ' + str(r.status_code)}")
        log(f"Aplicacion restaurada: base y {data.get('archivos')} archivo(s); migraciones aplicadas despues: {data.get('migraciones')}; "
            f"copia de la base anterior: {data.get('copia_previa')}.")
        for w in data.get("avisos") or []:
            log("AVISO: " + w)
        return []
    log("Prueba de restauracion correcta (no se aplico nada).")
    return []


def is_external(key: str) -> bool:
    return key.startswith("_externo_")


class Progress:
    """Avance de una restauracion para la pantalla: pasos con estado y un
    porcentaje total ponderado. Se guarda en la base (con el log hasta el
    momento) a lo sumo cada segundo, asi la pantalla lo ve en vivo."""

    def __init__(self, db: Session, rr: models.RestoreRun, lines: list[str], plan: list[tuple[str, int]]):
        self.db, self.rr, self.lines = db, rr, lines
        self.steps = [{"name": n, "weight": w, "status": "pendiente", "detail": ""} for n, w in plan]
        self.cur, self.frac, self._saved = -1, 0.0, 0.0
        self.interval = 1.0  # segundos minimos entre guardados (no escribir en cada MB)
        self.save(force=True)

    def start(self, name: str) -> None:
        idx = next((i for i, st in enumerate(self.steps) if st["name"] == name), None)
        if idx is None:
            self.steps.append({"name": name, "weight": 5, "status": "pendiente", "detail": ""})
            idx = len(self.steps) - 1
        for st in self.steps[:idx]:
            st["status"] = {"en_curso": "ok", "pendiente": "omitido"}.get(st["status"], st["status"])
        self.steps[idx]["status"] = "en_curso"
        self.cur, self.frac = idx, 0.0
        self.save(force=True)

    def update(self, frac: float, detail: str = "") -> None:
        self.frac = max(0.0, min(1.0, frac))
        if detail and self.cur >= 0:
            self.steps[self.cur]["detail"] = detail[:200]
        self.save()

    def sub(self, name: str):
        """Funcion progress(fraccion, detalle) para un paso: lo inicia la
        primera vez que se llama."""
        def fn(frac, detail=""):
            if self.cur < 0 or self.steps[self.cur]["name"] != name:
                self.start(name)
            self.update(frac, detail)
        return fn

    def percent(self) -> int:
        total = sum(st["weight"] for st in self.steps) or 1
        done = sum(st["weight"] for st in self.steps if st["status"] in ("ok", "omitido"))
        if 0 <= self.cur < len(self.steps) and self.steps[self.cur]["status"] == "en_curso":
            done += self.steps[self.cur]["weight"] * self.frac
        return int(done * 100 / total)

    def finish(self, ok: bool, error: str = "") -> None:
        for st in self.steps:
            if st["status"] == "en_curso":
                st["status"] = "ok" if ok else "error"
                if not ok:
                    st["detail"] = error[:300]
            elif st["status"] == "pendiente" and ok:
                st["status"] = "omitido"
        self.save(force=True, final_pct=100 if ok else None)

    def save(self, force: bool = False, final_pct: int | None = None) -> None:
        now = time.monotonic()
        if not force and now - self._saved < self.interval:
            return
        self._saved = now
        self.rr.progress = final_pct if final_pct is not None else min(self.percent(), 99)
        cur = self.steps[self.cur] if 0 <= self.cur < len(self.steps) else None
        self.rr.step = (cur["name"] + (f" - {cur['detail']}" if cur["detail"] else ""))[:120] if cur else None
        self.rr.steps_json = json.dumps([{k: v for k, v in st.items() if k != "weight"} for st in self.steps])
        self.rr.log = "\n".join(self.lines)
        self.db.commit()


def _manifest_files(src: Path) -> tuple[dict, list[dict]]:
    mf = src / "manifest.json"
    if not mf.exists():
        raise RestoreError("La carpeta no tiene manifest.json: vea RESTAURAR.txt para restaurar a mano.")
    manifest = json.loads(mf.read_text(encoding="utf-8"))
    files = [f for p in manifest.get("points", []) for f in p["files"]]
    if not files:
        raise RestoreError("El manifest no lista archivos.")
    return manifest, files


def external_kind(src: Path) -> str | None:
    try:
        manifest, files = _manifest_files(src)
    except RestoreError:
        return None
    return manifest.get("kind") or external_restore.kind_of_files([f["name"] for f in files])


def _restore_external(rr: models.RestoreRun, src: Path, work: Path, log, prog: Progress,
                      target: dict | None) -> tuple[list[dict], list[str]]:
    """Sistema externo (base en Azure, WordPress): verificar (SHA-256 y que
    cada archivo se lea entero), descargar, o cargarlo en una base NUEVA.
    Nunca se aplica sobre el sistema de origen."""
    manifest, files = _manifest_files(src)
    kind = manifest.get("kind") or external_restore.kind_of_files([f["name"] for f in files])
    log(f"Respaldo de '{manifest.get('source', rr.repo_name)}' ({kind or '?'}).")
    prog.start("Verificar integridad")
    total = sum(f.get("size", 0) for f in files) or 1
    seen = 0
    for f in files:
        path = src / f["name"]
        if not path.exists():
            raise RestoreError(f"Falta {f['name']}.")
        prog.update(seen / total, f"SHA-256 y lectura de {f['name']}")
        if backup_jobs._sha256(path) != f["sha256"]:
            raise RestoreError(f"{f['name']} esta DANADO: su SHA-256 no coincide con el del manifest.")
        try:
            log("  " + external_sources.verify_file(path))
        except (external_sources.SourceError, OSError, EOFError, tarfile.TarError) as e:
            raise RestoreError(f"{f['name']} no se puede leer: {e}") from e
        seen += f.get("size", 0)
    log("Integridad: SHA-256 correcto y contenido legible.")
    if rr.mode == "descargar":
        prog.start("Preparar archivos")
        outputs = []
        for name in [f["name"] for f in files] + ["RESTAURAR.txt"]:
            if (src / name).exists():
                shutil.copy2(src / name, work / name)
                outputs.append({"name": name, "size": (work / name).stat().st_size})
        log("Listo para descargar. RESTAURAR.txt trae los comandos para levantarlo en otra base u otro hosting.")
        return outputs, []
    if rr.mode != "nueva_base":
        log("Prueba de restauracion correcta (no se aplico nada).")
        return [], []
    if not target:
        raise RestoreError("Faltan los datos de la base destino (se piden al iniciar; no se guardan).")
    t = target
    where = f"base '{t['database']}' en {t.get('db_host') or t['host']}" + (f", carpeta '{t['wp_path']}'" if kind == "wordpress" else "")
    log(f"Destino: {where}.")
    try:
        if kind == "mysql":
            warnings = external_restore.restore_mysql(next(src.glob("*.sql.gz")), t, log, prog.sub("Cargar en la base nueva"))
        elif kind == "postgres":
            warnings = external_restore.restore_postgres(next(src.glob("*.dump")), t, log, prog.sub("Cargar en la base nueva"))
        elif kind == "mssql":
            warnings = external_restore.restore_mssql(next(src.glob("*.bacpac")), t, log, prog.sub("Cargar en la base nueva"))
        elif kind == "wordpress":
            warnings = external_restore.restore_wordpress(src, work, t, log, prog.sub("Cargar en la base nueva"),
                                                          prog.sub("Subir archivos del sitio"))
        else:
            raise RestoreError("No se reconoce el tipo de respaldo.")
    except external_sources.SourceError as e:
        raise RestoreError(str(e)) from e
    log("Restauracion en la base nueva terminada." + (f" Avisos: {len(warnings)}." if warnings else ""))
    return [], warnings


def _download(db: Session, dest: models.BackupDestination, chain_path: str, src: Path, log, prog: Progress) -> None:
    prog.start("Descargar del destino")
    with rclone_service.RcloneSession(dest) as s:
        size = s.run(["size", "--json", s.path(chain_path)], timeout=900)
        try:
            total = json.loads(size.stdout or "{}").get("bytes") or 1
        except ValueError:
            total = 1
        proc = subprocess.Popen([rclone_service.RCLONE, "copy", s.path(chain_path), str(src), "--use-json-log", "-v",
                                 "--stats", "2s", "--stats-log-level", "NOTICE", "--retries", "3"],
                                stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True, env=s.env)
        errors = []
        for line in proc.stderr:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("stats"):
                got = ev["stats"].get("bytes", 0)
                prog.update(got / total, f"{got / 1048576:.1f} de {total / 1048576:.1f} MB")
            if ev.get("level") in ("error", "critical"):
                errors.append(ev.get("msg", "")[:200])
        proc.wait(timeout=rclone_service.LONG_TIMEOUT)
    rclone_service.persist_new_token(db, dest, s)
    if proc.returncode != 0 or not src.exists():
        raise RestoreError("No se pudo descargar la cadena del destino: " + (" | ".join(errors[-3:]) or f"codigo {proc.returncode}"))
    got = sum(f.stat().st_size for f in src.iterdir() if f.is_file())
    log(f"Descargado de '{dest.name}'{' (descifrado)' if dest.encrypt else ''}: {got / 1048576:.2f} MB.")


_MODE_STEP = {"verificar": "Probar restauracion", "descargar": "Preparar archivos", "subir": "Subir a Git",
              "aplicar": "Restaurar en la aplicacion"}


def _plan(rr: models.RestoreRun, kind: str | None) -> list[tuple[str, int]]:
    plan = [("Descargar del destino", 30)] if rr.destination_id else []
    if is_external(rr.repo_name):
        plan.append(("Verificar integridad", 10))
        if rr.mode == "nueva_base":
            plan.append(("Cargar en la base nueva", 50))
            if kind == "wordpress":
                plan.append(("Subir archivos del sitio", 40))
        elif rr.mode == "descargar":
            plan.append(("Preparar archivos", 5))
    else:
        plan.append((_MODE_STEP.get(rr.mode, rr.mode), 60))
    return plan


def _error_map(prog: Progress, rr: models.RestoreRun, err: str, tb: str | None) -> list[str]:
    """Bloque al final del log que explica DONDE y POR QUE fallo."""
    idx = prog.cur
    step = prog.steps[idx]["name"] if 0 <= idx < len(prog.steps) else "inicio"
    done = [st["name"] for st in prog.steps if st["status"] == "ok"]
    out = ["", "=== MAPA DEL ERROR ===",
           f"Restauracion #{rr.id}: {rr.mode} de {rr.repo_name} (cadena {rr.chain_path}, punto #{rr.seq}) desde {rr.source_label}",
           f"Fallo en el paso {idx + 1} de {len(prog.steps)}: {step}",
           "Pasos completados: " + (", ".join(done) if done else "ninguno"),
           f"Causa: {err}"]
    if "Sugerencia" not in err:
        low = err.lower()
        if "danado" in low or "sha-256" in low:
            out.append("Sugerencia: la copia esta corrupta; restaure desde otro destino o un punto anterior.")
        elif "ya existe" in low or "ya tiene" in low:
            out.append("Sugerencia: use un nombre de base o carpeta nuevo; nunca se escribe sobre datos existentes.")
        elif "descargar" in low or "destino" in low:
            out.append("Sugerencia: use 'Probar' en Destinos externos para revisar la conexion con el destino.")
    out.append("Nada se modifico en el sistema de origen." if is_external(rr.repo_name) else
               "Revise el paso indicado en el log.")
    if tb:
        out += ["Detalle tecnico:", tb]
    return out


def run_restore(restore_id: int, push: dict | None = None, target: dict | None = None) -> None:
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
    prog = None
    work = restore_dir(restore_id)
    outputs: list[dict] = []
    warnings: list[str] = []
    try:
        rr = db.get(models.RestoreRun, restore_id)
        if not rr:
            return
        prog = Progress(db, rr, lines, _plan(rr, (target or {}).get("_kind")))
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)
        log(f"Restauracion ({rr.mode}) de {rr.repo_name}, punto #{rr.seq}, desde {rr.source_label}.")
        if rr.destination_id:
            dest = db.get(models.BackupDestination, rr.destination_id)
            if not dest:
                raise RestoreError("El destino ya no existe.")
            src = work / "descarga"
            _download(db, dest, rr.chain_path, src, log, prog)
        else:
            src = backup_jobs.jobs_root() / rr.chain_path
            if not src.exists():
                raise RestoreError("Esa cadena ya no esta en el servidor (la borro la retencion local): restaure desde un destino externo.")
        if is_external(rr.repo_name):
            outputs, warnings = _restore_external(rr, src, work, log, prog, target)
        else:
            prog.start(_MODE_STEP.get(rr.mode, rr.mode))
            if rr.repo_name == backup_jobs.DB_KEY:
                outputs = _restore_db(rr, src, work, log)
            elif rr.repo_name == backup_jobs.APP_KEY:
                outputs = _restore_app(rr, src, work, log)
            else:
                outputs = _restore_repo(rr, src, work, log, push)
        for w in warnings:
            log("AVISO: " + w)
        rr.status = "ok_con_avisos" if warnings else "ok"
        log(f"Fin: {rr.status}.")
        prog.finish(True)
    except (RestoreError, rclone_service.RcloneError) as e:
        log("ERROR: " + str(e))
        if rr:
            rr.status = "error"
            if prog:
                lines.extend(_error_map(prog, rr, str(e), None))
                prog.finish(False, str(e))
    except Exception as e:  # noqa: BLE001 - queda registrado en la restauracion
        logger.exception("Fallo la restauracion %s", restore_id)
        log(f"ERROR inesperado: {e}")
        if rr:
            rr.status = "error"
            if prog:
                tb = "".join(traceback.format_exception(e)[-4:])[-1500:]
                lines.extend(_error_map(prog, rr, f"{type(e).__name__}: {e}", tb))
                prog.finish(False, str(e))
    finally:
        shutil.rmtree(work / "descarga", ignore_errors=True)
        shutil.rmtree(work / "sitio_restaurado", ignore_errors=True)
        if not outputs:
            shutil.rmtree(work, ignore_errors=True)
        if rr:
            rr.outputs_json = json.dumps(outputs)
            rr.log = "\n".join(lines)
            rr.finished_at = datetime.utcnow()
            db.commit()
        db.close()
        _lock.release()
