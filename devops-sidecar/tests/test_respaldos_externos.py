"""Pruebas de extremo a extremo de los respaldos externos y los trabajos
programados. Usa una base, repos y carpetas TEMPORALES (nunca la base
real) y servidores WebDAV/SFTP/S3 locales levantados con `rclone serve`,
asi se prueban protocolos reales sin cuentas externas. OneDrive y Google
Drive no se pueden probar sin una cuenta (usan el mismo camino de rclone).

Correr dentro del contenedor:
  docker compose exec devops-sidecar python tests/test_respaldos_externos.py
"""
import base64
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(tempfile.mkdtemp(prefix="rt_respaldos_"))
os.environ.update({
    "DATABASE_PATH": str(ROOT / "db" / "sidecar.db"),
    "BACKUPS_PATH": str(ROOT / "backups"),
    "REPOS_BASE_PATH": str(ROOT / "repos"),
    "REPORTS_PATH": str(ROOT / "reports"),
    # Estas pruebas entran con HTTP Basic: sin acceso unico, aunque el
    # contenedor donde corren lo tenga configurado (ver tests/test_sso.py).
    "SSO_SHARED_SECRET": "",
})
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app import models, scheduler  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.services import backup_jobs, crypto_service, git_service, rclone_service  # noqa: E402

RESULTS: list[tuple[bool, str]] = []


def check(name, cond):
    RESULTS.append((bool(cond), name))


def sh(*args, cwd=None):
    r = subprocess.run(list(args), cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(args)}: {r.stderr}")
    return r.stdout.strip()


def commit(work: Path, name: str, text: str):
    (work / name).write_text(text, encoding="utf-8")
    sh("git", "add", "-A", cwd=work)
    sh("git", "-c", "user.name=Prueba", "-c", "user.email=p@x", "commit", "-q", "-m", f"cambio {name}", cwd=work)
    sh("git", "push", "-q", "origin", "HEAD", cwd=work)


def serve(kind, folder, port, extra):
    folder.mkdir(parents=True, exist_ok=True)
    # El usuario del contenedor no tiene HOME: rclone serve necesita una
    # carpeta propia para su cache (y, en SFTP, para sus llaves de host).
    home = ROOT / f"home_{kind}"
    env = dict(os.environ, HOME=str(home), XDG_CACHE_HOME=str(home / "cache"))
    proc = subprocess.Popen(["rclone", "serve", kind, str(folder), "--addr", f"127.0.0.1:{port}", *extra],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    time.sleep(2)
    return proc


def sftp_known_hosts(port: int) -> str:
    keys = sorted((ROOT / "home_sftp" / "cache" / "rclone" / "serve-sftp").glob("*.pub"))
    return "\n".join(f"[127.0.0.1]:{port} {' '.join(k.read_text().split()[:2])}" for k in keys)


def fake_known_hosts(port: int) -> str:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ed25519
    pub = ed25519.Ed25519PrivateKey.generate().public_key().public_bytes(
        serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH).decode()
    return f"[127.0.0.1]:{port} {pub}"


def main():
    auth = (settings.dashboard_user, settings.dashboard_password)
    has_key = bool(settings.credentials_enc_key)

    # --- repo de origen (bare) + un clon de trabajo para generar commits
    origin = ROOT / "origin.git"
    work = ROOT / "work"
    sh("git", "init", "-q", "--bare", str(origin))
    sh("git", "clone", "-q", str(origin), str(work))
    commit(work, "README.md", "hola\n")

    # --- servidores locales reales
    servers = {
        "webdav": serve("webdav", ROOT / "srv_webdav", 18080, ["--user", "u", "--pass", "clave-webdav"]),
        "sftp": serve("sftp", ROOT / "srv_sftp", 12022, ["--user", "u", "--pass", "clave-sftp"]),
        "s3": serve("s3", ROOT / "srv_s3", 19000, ["--auth-key", "AKPRUEBA,SKPRUEBA"]),
    }
    (ROOT / "srv_s3" / "respaldos").mkdir(parents=True, exist_ok=True)

    try:
        with TestClient(app) as c:
            c.auth = auth
            # ===== Fase 1a: token de GitHub cifrado y fuera de la URL =====
            r = c.post("/api/repos", json={"name": "demo", "github_url": str(origin),
                                           "github_token": "ghp_TOKENDEPRUEBA1234567890", "sync_interval_minutes": 60})
            check("Crear repo por la API", r.status_code == 201)
            db = SessionLocal()
            repo = db.query(models.Repo).filter_by(name="demo").one()
            if has_key:
                check("Token de GitHub guardado cifrado (enc:v1:)", repo.github_token.startswith("enc:v1:") and "TOKENDEPRUEBA" not in repo.github_token)
            check("repo_token() devuelve el token descifrado", git_service.repo_token(repo) == "ghp_TOKENDEPRUEBA1234567890")
            env = git_service.auth_env(models.Repo(github_url="https://github.com/x/y", github_token=repo.github_token))
            expected = base64.b64encode(b"x-access-token:ghp_TOKENDEPRUEBA1234567890").decode()
            check("Autenticacion por cabecera (GIT_CONFIG_*), no por URL", env and env["GIT_CONFIG_VALUE_0"] == f"Authorization: Basic {expected}")
            ok, detail = git_service.sync_repo(repo)
            check(f"Sincroniza (clona) el repo de prueba: {detail}", ok)
            # Un clon viejo con el token en la URL se limpia
            legacy = ROOT / "repos" / "clon-viejo"
            sh("git", "clone", "-q", str(origin), str(legacy))
            sh("git", "remote", "set-url", "origin", "https://ghp_SECRETO@github.com/org/repo.git", cwd=legacy)
            db.add(models.Repo(name="viejo", github_url="https://github.com/org/repo.git", github_token="ghp_PLANO_VIEJO",
                               local_path=str(legacy)))
            db.commit()
            res = git_service.secure_stored_tokens(db)
            url_after = sh("git", "remote", "get-url", "origin", cwd=legacy)
            check("Migracion quita el token de la URL de origin", url_after == "https://github.com/org/repo.git")
            viejo = db.query(models.Repo).filter_by(name="viejo").one()
            if has_key:
                check(f"Migracion cifra tokens en texto plano ({res})", viejo.github_token.startswith("enc:v1:"))
            db.delete(viejo)
            db.commit()
            check("Clon con credenciales en ruta: strip_credentials", git_service.strip_credentials("https://t@github.com/a/b") == "https://github.com/a/b")

            # ===== Fase 1b: destinos =====
            kinds = c.get("/api/backup-destinations/kinds").json()
            check("Tipos de destino disponibles", {"onedrive", "gdrive", "s3", "sftp", "smb", "webdav", "local"} <= set(kinds["kinds"]))
            bad = c.post("/api/backup-destinations", json={"name": "x", "kind": "sftp", "remote_path": "/a", "config": {"host": "h", "user": "u"}})
            check("Validacion: SFTP sin contrasena ni llave rechazado", bad.status_code == 422)
            bad = c.post("/api/backup-destinations", json={"name": "x", "kind": "local", "remote_path": "/a", "encrypt": True, "config": {}})
            check("Validacion: cifrado sin contrasena rechazado", bad.status_code == 422)
            bad = c.post("/api/backup-destinations", json={"name": "x", "kind": "onedrive", "remote_path": "a", "config": {"token": "no-es-json"}})
            check("Validacion: autorizacion OneDrive que no es JSON rechazada", bad.status_code == 422)
            # SMB: la ruta pegada del Explorador de Windows se convierte sola.
            unc = r"\\172.16.1.223\VeeamRepo\RESPALDO REPOSITORIOS"
            r = c.post("/api/backup-destinations", json={"name": "NAS Veeam", "kind": "smb", "remote_path": unc,
                                                         "config": {"user": "user.veeam", "pass": "x"}})
            smb = r.json()
            check(f"SMB con ruta de Windows: se guarda como recurso/carpeta ({smb.get('remote_path')})",
                  r.status_code == 201 and smb["remote_path"] == "VeeamRepo/RESPALDO REPOSITORIOS" and smb["config"]["host"] == "172.16.1.223")
            db_ = SessionLocal()
            d_ = db_.get(models.BackupDestination, smb["id"])
            d_.remote_path = unc  # un destino guardado antes de este arreglo
            conf_, target_ = rclone_service._conf_sections(d_, rclone_service.load_config(d_), ROOT)
            db_.close()
            check("SMB guardado con ruta de Windows antes del arreglo: rclone recibe recurso/carpeta",
                  target_ == "dst:VeeamRepo/RESPALDO REPOSITORIOS" and "host = 172.16.1.223" in conf_)
            r = c.post("/api/backup-destinations", json={"name": "NAS otro", "kind": "smb", "remote_path": unc,
                                                         "config": {"host": "10.0.0.5", "user": "u", "pass": "x"}})
            check("SMB con servidor distinto en la ruta y en el campo: rechazado", r.status_code == 422)
            c.delete(f"/api/backup-destinations/{smb['id']}")

            defs = {
                "Disco local": {"kind": "local", "remote_path": str(ROOT / "externo_plano"), "config": {}},
                "Disco cifrado": {"kind": "local", "remote_path": str(ROOT / "externo_cifrado"), "encrypt": True,
                                  "config": {"crypt_password": "Contrasena-Cifrado-1", "crypt_password2": "Sal-2"}},
                "WebDAV": {"kind": "webdav", "remote_path": "respaldos/sidecar",
                           "config": {"url": "http://127.0.0.1:18080", "vendor": "other", "user": "u", "pass": "clave-webdav"}},
                # Cifrado sobre un destino sin hashes (como una carpeta SMB):
                # cryptcheck no puede verificar y se compara descargando.
                "WebDAV cifrado": {"kind": "webdav", "remote_path": "respaldos/cifrado", "encrypt": True,
                                   "config": {"url": "http://127.0.0.1:18080", "vendor": "other", "user": "u", "pass": "clave-webdav",
                                              "crypt_password": "Contrasena-Cifrado-3", "crypt_password2": "Sal-3"}},
                "SFTP": {"kind": "sftp", "remote_path": "respaldos/sidecar",
                         "config": {"host": "127.0.0.1", "port": "12022", "user": "u", "pass": "clave-sftp",
                                    "known_hosts": sftp_known_hosts(12022)}},
                "S3": {"kind": "s3", "remote_path": "respaldos/sidecar",
                       "config": {"provider": "Other", "access_key_id": "AKPRUEBA", "secret_access_key": "SKPRUEBA",
                                  "endpoint": "http://127.0.0.1:19000", "region": "us-east-1"}},
            }
            dest_ids = {}
            for name, d in defs.items():
                r = c.post("/api/backup-destinations", json={"name": name, **d})
                check(f"Crear destino {name}", r.status_code == 201)
                dest_ids[name] = r.json()["id"]
            listing = c.get("/api/backup-destinations").text
            check("La lista de destinos no expone ningun secreto",
                  all(s not in listing for s in ("clave-webdav", "clave-sftp", "SKPRUEBA", "Contrasena-Cifrado-1", "Sal-2")))
            raw = SessionLocal().get(models.BackupDestination, dest_ids["SFTP"]).config_enc
            if has_key:
                check("Configuracion del destino cifrada en BD", raw.startswith("enc:v1:") and "clave-sftp" not in raw)
            for name, did in dest_ids.items():
                r = c.post(f"/api/backup-destinations/{did}/test").json()
                check(f"Probar conexion {name}: {r['message'][:70]}", r["ok"])
            check("Hay huella SFTP real para validar", "ssh-" in defs["SFTP"]["config"]["known_hosts"])
            impostor = c.post("/api/backup-destinations", json={"name": "SFTP impostor", "kind": "sftp", "remote_path": "x",
                                                                "config": {"host": "127.0.0.1", "port": "12022", "user": "u", "pass": "clave-sftp",
                                                                           "known_hosts": fake_known_hosts(12022)}}).json()
            r = c.post(f"/api/backup-destinations/{impostor['id']}/test").json()
            check(f"SFTP con huella distinta: conexion rechazada ({r['message'][:60]})", not r["ok"])
            c.delete(f"/api/backup-destinations/{impostor['id']}")
            # Editar sin reescribir secretos los conserva
            r = c.put(f"/api/backup-destinations/{dest_ids['SFTP']}", json={"name": "SFTP", **defs["SFTP"], "config": {
                "host": "127.0.0.1", "port": "12022", "user": "u", "known_hosts": defs["SFTP"]["config"]["known_hosts"]}})
            check("Editar sin reescribir la contrasena la conserva", r.status_code == 200 and c.post(f"/api/backup-destinations/{dest_ids['SFTP']}/test").json()["ok"])
            wrong = c.post("/api/backup-destinations", json={"name": "SFTP malo", "kind": "sftp", "remote_path": "x",
                                                             "config": {"host": "127.0.0.1", "port": "12022", "user": "u", "pass": "incorrecta"}}).json()
            r = c.post(f"/api/backup-destinations/{wrong['id']}/test").json()
            check("Probar conexion con contrasena incorrecta: error claro", not r["ok"])
            c.delete(f"/api/backup-destinations/{wrong['id']}")

            # ===== Fase 2: trabajos =====
            bad = c.post("/api/backup-jobs", json={"name": "malo", "frequency": "cron", "cron_expr": "cada dia"})
            check("Expresion cron invalida rechazada con mensaje", bad.status_code == 422 and "cron" in bad.json()["detail"].lower())
            job_payload = {"name": "Diario externo", "repo_ids": [repo.id], "include_bundle": True, "include_diff": True,
                           "include_content": True, "include_sidecar_db": True, "frequency": "daily", "hour": 3, "minute": 30,
                           "incrementals_per_full": 2, "keep_chains_local": 2, "keep_chains_remote": 2,
                           "destination_ids": list(dest_ids.values())}
            r = c.post("/api/backup-jobs", json=job_payload)
            check("Crear trabajo", r.status_code == 201)
            job = r.json()
            check(f"Programado: {job['schedule_text']}, proxima {job['next_run']}", job["next_run"] and "03:30" in job["next_run"])
            r = c.delete(f"/api/backup-destinations/{dest_ids['WebDAV']}")
            check("No se puede borrar un destino que usa un trabajo", r.status_code == 409)

            def run():
                run_id = backup_jobs.run_job(job["id"], "manual")
                s = SessionLocal()
                rr = s.get(models.BackupJobRun, run_id)
                out = (rr.status, rr.log)
                s.close()
                return out

            def points():
                s = SessionLocal()
                pts = s.query(models.BackupPoint).filter_by(job_id=job["id"], repo_name="demo").order_by(models.BackupPoint.id).all()
                out = [(p.kind, p.seq, p.chain_label, p.local_deleted, [t.status for t in p.transfers]) for p in pts]
                s.close()
                return out

            status, log = run()
            pts = points()
            check(f"Ejecucion 1: COMPLETO ({status})", status == "ok" and pts[-1][0] == "full" and pts[-1][1] == 0)
            check("Completo enviado y verificado en los 6 destinos", pts[-1][4].count("ok") == 6)
            check("Cifrado sin hashes: verificado descargando y comparando", "comparando el contenido descargado" in log)
            chain1 = pts[-1][2]
            plain_dir = ROOT / "externo_plano" / "Diario-externo" / "demo" / chain1
            names = sorted(p.name for p in plain_dir.iterdir())
            check(f"Destino plano: bundle, archivos, diff, manifest y RESTAURAR ({len(names)} archivos)",
                  any(n.startswith("00_completo_") and n.endswith(".bundle") for n in names)
                  and any(n.endswith(".tar.gz") for n in names) and "RESTAURAR.txt" in names and "manifest.json" in names)
            enc_names = [p.name for p in (ROOT / "externo_cifrado").rglob("*") if p.is_file()]
            check("Destino cifrado: ningun nombre legible", enc_names and not any("completo" in n or "RESTAURAR" in n or "demo" in n for n in enc_names))
            check("Copia de sidecar.db en los destinos",
                  any(p.name.endswith(".db.gz") for p in (ROOT / "externo_plano" / "Diario-externo" / "_sidecar_db").rglob("*")))

            status, log = run()
            check("Ejecucion 2 sin commits nuevos: no crea incremental", len(points()) == 1 and "sin commits nuevos" in log)

            for i in (1, 2):
                commit(work, f"archivo{i}.txt", f"contenido {i}\n")
                git_service.sync_repo(repo)
                status, log = run()
                pts = points()
                check(f"Ejecucion con commit nuevo: INCREMENTAL #{i} en la misma cadena", pts[-1][0] == "incremental" and pts[-1][1] == i and pts[-1][2] == chain1)
            commit(work, "archivo3.txt", "contenido 3\n")
            git_service.sync_repo(repo)
            status, log = run()
            pts = points()
            check("Tras 2 incrementales: nuevo COMPLETO (cadena nueva)", pts[-1][0] == "full" and pts[-1][2] != chain1)

            # Restaurar la cadena 1 desde el destino CIFRADO, solo con rclone + contrasena
            s = SessionLocal()
            dest = s.get(models.BackupDestination, dest_ids["Disco cifrado"])
            restore = ROOT / "restaurado_cadena1"
            with rclone_service.RcloneSession(dest) as rs:
                rr = rs.run(["copy", rs.path(f"Diario-externo/demo/{chain1}"), str(restore)], timeout=300)
            s.close()
            check("Descargar y descifrar la cadena 1 con rclone", rr.returncode == 0 and (restore / "RESTAURAR.txt").exists())
            bare = ROOT / "restaurado.git"
            sh("git", "init", "-q", "--bare", str(bare))
            for b in sorted(restore.glob("*.bundle")):
                sh("git", "-C", str(bare), "fetch", "-q", str(b), "+refs/*:refs/*")
            clone = ROOT / "restaurado_trabajo"
            sh("git", "clone", "-q", str(bare), str(clone))
            check("Restaurado (completo + 2 incrementales) tiene archivo1 y archivo2",
                  (clone / "archivo1.txt").exists() and (clone / "archivo2.txt").read_text() == "contenido 2\n")
            head_backup = sh("git", "rev-parse", "HEAD", cwd=clone)
            head_at_chain_end = sh("git", "rev-parse", "HEAD~1", cwd=work)
            check("El HEAD restaurado es el commit del ultimo incremental", head_backup == head_at_chain_end)

            # Destino caido: se registra el error y se reenvia en la siguiente ejecucion
            servers["webdav"].terminate()
            servers["webdav"].wait()
            commit(work, "archivo4.txt", "contenido 4\n")
            git_service.sync_repo(repo)
            t = c.post(f"/api/backup-jobs/{job['id']}/test").json()
            bad = [x for x in t["checks"] if not x["ok"]]
            check(f"Probar conexion del trabajo detecta el WebDAV caido ({len(bad)} error)",
                  not t["ok"] and len(bad) == 2 and all(b["kind"] == "destino" for b in bad)
                  and any(x["kind"] == "repo" and x["ok"] for x in t["checks"]))
            status, log = run()
            pts = points()
            check(f"WebDAV caido: ejecucion con error ({status}) y el resto de destinos OK",
                  status == "error" and pts[-1][4].count("ok") == 4 and pts[-1][4].count("error") == 2)
            servers["webdav"] = serve("webdav", ROOT / "srv_webdav", 18080, ["--user", "u", "--pass", "clave-webdav"])
            status, log = run()
            pts = points()
            check("Probar conexion con todo en linea: OK", c.post(f"/api/backup-jobs/{job['id']}/test").json()["ok"])
            check(f"WebDAV de vuelta: se reenvia lo pendiente ({status})", status == "ok" and pts[-1][4].count("ok") == 6)

            # Retencion: 2 cadenas locales y 2 remotas -> al abrir la 3a se borra la 1a
            for i in (5, 6):
                commit(work, f"archivo{i}.txt", f"contenido {i}\n")
                git_service.sync_repo(repo)
                run()
            pts = points()
            labels = []
            for p in pts:
                if p[2] not in labels:
                    labels.append(p[2])
            check(f"Hay una tercera cadena ({len(labels)} cadenas registradas)", len(labels) >= 2 and pts[-1][0] == "full")
            check("Retencion local: cadena 1 borrada del servidor", not (ROOT / "backups" / "jobs" / str(job["id"]) / "demo" / chain1).exists())
            check("Retencion remota: cadena 1 borrada del destino", not plain_dir.exists())
            check("Retencion: la cadena 1 ya no figura en el historial", chain1 not in labels)
            remote_chains = sorted(p.name for p in (ROOT / "externo_plano" / "Diario-externo" / "demo").iterdir())
            check(f"En el destino quedan exactamente 2 cadenas ({len(remote_chains)})", len(remote_chains) == 2)

            # Programacion
            r = c.put(f"/api/backup-jobs/{job['id']}", json={**job_payload, "enabled": False})
            check("Pausar el trabajo lo quita del programador", r.status_code == 200 and scheduler.next_backup_run(job["id"]) is None)
            r = c.put(f"/api/backup-jobs/{job['id']}", json={**job_payload, "frequency": "cron", "cron_expr": "15 4 * * 1-5"})
            check(f"Programacion cron: {r.json()['schedule_text']} -> {r.json()['next_run']}", r.status_code == 200 and r.json()["next_run"].endswith("04:15"))

            # Pantallas
            for url in ("/backups", "/backups/destinos", "/backups/trabajos", f"/backups/trabajos/{job['id']}"):
                check(f"Pagina {url} responde 200", c.get(url).status_code == 200)
            check("Detalle: API de puntos y ejecuciones", c.get(f"/api/backup-jobs/{job['id']}/points").status_code == 200
                  and len(c.get(f"/api/backup-jobs/{job['id']}/runs").json()) >= 8)
    finally:
        for p in servers.values():
            p.terminate()
        shutil.rmtree(ROOT, ignore_errors=True)

    fails = [n for ok, n in RESULTS if not ok]
    for ok, name in RESULTS:
        print(("OK    " if ok else "FALLA ") + name)
    print(f"{len(RESULTS)} pruebas, {len(fails)} fallas")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
