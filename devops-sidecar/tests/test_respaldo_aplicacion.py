"""Pruebas del respaldo completo de la aplicacion principal desde un trabajo
del sidecar: pedirlo (pase app-backup), guardarlo en su cadena con SHA-256,
descartarlo si llega danado, el trabajo nocturno por defecto, y restaurarlo
(verificar y "Restaurar en la aplicacion"). La aplicacion principal se
SIMULA con un servidor local; base y carpetas TEMPORALES, nunca las reales.

Correr dentro del contenedor:
  docker compose exec devops-sidecar python tests/test_respaldo_aplicacion.py
"""
import hashlib
import io
import json
import os
import shutil
import sys
import tarfile
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(tempfile.mkdtemp(prefix="rt_resp_"))
os.environ.update({
    "DATABASE_PATH": str(ROOT / "db" / "sidecar.db"),
    "BACKUPS_PATH": str(ROOT / "backups"),
    "REPOS_BASE_PATH": str(ROOT / "repos"),
    "REPORTS_PATH": str(ROOT / "reports"),
    "SSO_SHARED_SECRET": "secreto-de-prueba",
    "DASHBOARD_USER": "panel",
    "DASHBOARD_PASSWORD": "clave-compartida",
    "DASHBOARD_BASIC_AUTH": "on",
})
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app import models  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import SessionLocal, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.services import backup_jobs, restore_service, sso_service  # noqa: E402

RESULTS: list[tuple[bool, str]] = []
MODE = {"generar": "ok"}  # ok | sha_malo | error | sin_secretos
SEEN: dict = {"generar": [], "restaurar": []}


def check(name, cond, extra=""):
    RESULTS.append((bool(cond), name + (f" — {extra}" if extra and not cond else "")))


def make_archive() -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, data in (("manifest.json", json.dumps({"aplicacion": "glpi-licencias-app", "creado": "2026-10-05T07:30:00Z", "servidor": "prueba",
                                                           "archivos": {"cantidad": 3}, "cantidades": {"mobile_devices": 817, "software_licenses": 12, "users": 4},
                                                           "secretos": {"incluidos": True}}).encode()),
                           ("basedatos.sql.gz", b"\x1f\x8b dump"), ("RESTAURAR.txt", b"pasos")):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


ARCHIVE = make_archive()


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        auth = self.headers.get("authorization", "")
        ok = auth.startswith("Bearer ") and sso_service.verify(auth[7:], "app-backup") is not None
        body = self.rfile.read(int(self.headers.get("content-length", 0) or 0))
        if not ok:
            return self._json(401, {"ok": False, "error": "Pase no válido"})
        if self.path == "/interno/respaldo/generar":
            SEEN["generar"].append(json.loads(body or b"{}"))
            if MODE["generar"] == "error":
                return self._json(500, {"ok": False, "error": "mariadb-dump falló"})
            self.send_response(200)
            self.send_header("content-type", "application/gzip")
            self.send_header("content-length", str(len(ARCHIVE)))
            sha = hashlib.sha256(ARCHIVE).hexdigest()
            self.send_header("x-respaldo-sha256", "0" * 64 if MODE["generar"] == "sha_malo" else sha)
            self.send_header("x-respaldo-secretos", "no" if MODE["generar"] == "sin_secretos" else "si")
            self.end_headers()
            self.wfile.write(ARCHIVE)
            return None
        if self.path == "/interno/respaldo/restaurar":
            if not body:  # "Probar" el trabajo: solo comprueba el pase
                return self._json(400, {"ok": False, "error": "Falta la confirmación"})
            SEEN["restaurar"].append({"confirm": self.headers.get("x-confirmacion"), "body": body})
            return self._json(200, {"ok": True, "archivos": 3, "migraciones": 0, "copia_previa": "antes.sql", "avisos": ["aviso de prueba"]})
        return self._json(404, {})


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    settings.main_app_internal_url = f"http://127.0.0.1:{server.server_address[1]}"
    init_db()
    db = SessionLocal()
    try:
        # --- Trabajo nocturno por defecto
        dest = models.BackupDestination(name="Carpeta de prueba", kind="local", config_enc="{}", remote_path="x", enabled=True)
        off = models.BackupDestination(name="Apagado", kind="local", config_enc="{}", remote_path="y", enabled=False)
        db.add_all([dest, off])
        db.commit()
        job = backup_jobs.ensure_app_job(db)
        check("Se crea el respaldo nocturno de la aplicación (02:30, solo destinos activos, 7 noches local y 30 en destino, sin repos)",
              job and job.include_main_app and not job.include_repos and job.hour == 2 and job.minute == 30
              and json.loads(job.destination_ids_json) == [dest.id] and job.keep_chains_local == 7 and job.keep_chains_remote == 30)
        db.delete(job)
        db.commit()
        check("Si se borra, no se vuelve a crear", backup_jobs.ensure_app_job(db) is None
              and not db.query(models.BackupJob).filter(models.BackupJob.include_main_app.is_(True)).count())

        test_job = models.BackupJob(name="Prueba app", include_repos=False, include_sidecar_db=False, include_main_app=True,
                                    destination_ids_json="[]", keep_chains_local=2, keep_chains_remote=2)
        db.add(test_job)
        db.commit()

        # --- Ejecucion correcta
        run_id = backup_jobs.run_job(test_job.id, "manual")
        db.expire_all()
        run = db.get(models.BackupJobRun, run_id)
        points = db.query(models.BackupPoint).filter(models.BackupPoint.job_id == test_job.id).all()
        p = points[0] if points else None
        folder = backup_jobs.chain_dir(test_job, backup_jobs.APP_KEY, p.chain_label) if p else None
        files = sorted(x.name for x in folder.iterdir()) if folder else []
        check("El trabajo pide el respaldo con el .env del sidecar y lo guarda en su cadena", run.status == "ok" and p and p.repo_name == backup_jobs.APP_KEY
              and any(f.startswith("aplicacion_") and f.endswith(".tar.gz") for f in files) and "manifest.json" in files and "RESTAURAR.txt" in files
              and "SSO_SHARED_SECRET" in SEEN["generar"][-1]["sidecar_env"] and "PATH" not in SEEN["generar"][-1]["sidecar_env"], run.log)
        mf = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        check("El manifest de la cadena guarda el SHA-256 del respaldo", mf["points"][0]["files"][0]["sha256"] == hashlib.sha256(ARCHIVE).hexdigest())

        MODE["generar"] = "sin_secretos"
        run = db.get(models.BackupJobRun, backup_jobs.run_job(test_job.id, "manual"))
        check("Sin contraseña de recuperación en la aplicación: queda con aviso (no 'ok' limpio)", run.status == "ok_con_avisos" and "SIN los .env" in run.log)
        MODE["generar"] = "sha_malo"
        before = len(db.query(models.BackupPoint).filter(models.BackupPoint.job_id == test_job.id).all())
        run = db.get(models.BackupJobRun, backup_jobs.run_job(test_job.id, "manual"))
        after = len(db.query(models.BackupPoint).filter(models.BackupPoint.job_id == test_job.id).all())
        check("Si llega incompleto (SHA-256 distinto) se descarta y el trabajo queda en error", run.status == "error" and after == before and "incompleto" in run.log)
        MODE["generar"] = "error"
        run = db.get(models.BackupJobRun, backup_jobs.run_job(test_job.id, "manual"))
        check("Si la aplicación falla, el error queda en el registro del trabajo", run.status == "error" and "mariadb-dump" in run.log)
        MODE["generar"] = "ok"
        real = settings.main_app_internal_url
        settings.main_app_internal_url = "http://127.0.0.1:9"
        ok, msg = backup_jobs.check_main_app()
        check("Probar el trabajo: avisa si la aplicación principal no responde", not ok and "no responde" in msg)
        settings.main_app_internal_url = real
        check("Probar el trabajo: la aplicación responde y acepta el pase", backup_jobs.check_main_app()[0])

        # --- Restaurar desde el servidor (el punto mas reciente: la retencion de 2 ya borro el primero)
        first_id = p.id
        backup_jobs.run_job(test_job.id, "manual")  # tercera copia buena: con 2 por conservar, se va la primera
        db.expire_all()
        first = db.get(models.BackupPoint, first_id)
        check("La retención conserva solo las últimas 2 copias en el servidor (borra la carpeta de la más vieja)",
              (first is None or first.local_deleted) and not folder.exists())
        p = db.query(models.BackupPoint).filter(models.BackupPoint.job_id == test_job.id, models.BackupPoint.local_deleted.is_(False))             .order_by(models.BackupPoint.id.desc()).first()
        client = TestClient(app)
        auth = ("panel", "clave-compartida")
        r = client.post("/api/restores", json={"mode": "aplicar", "point_id": p.id, "source": "local"}, auth=auth)
        check("Restaurar en la aplicación exige escribir RESTAURAR TODO", r.status_code == 422 and "RESTAURAR TODO" in r.text, r.text)
        repo_point = models.BackupPoint(job_id=test_job.id, repo_name="otro-repo", kind="full", seq=0, chain_label="x", files_json="[]")
        db.add(repo_point)
        db.commit()
        r = client.post("/api/restores", json={"mode": "aplicar", "point_id": repo_point.id, "source": "local", "confirmacion": "RESTAURAR TODO"}, auth=auth)
        check("Solo un respaldo de la aplicación se puede aplicar en la aplicación", r.status_code == 422)
        r = client.post("/api/restores", json={"mode": "verificar", "point_id": p.id, "source": "local"}, auth=auth)
        rid = r.json().get("id")
        for _ in range(50):
            rr = client.get(f"/api/restores/{rid}", auth=auth).json()
            if rr["status"] != "en_curso":
                break
            time.sleep(0.1)
        check("Verificar: SHA-256 correcto y resumen del respaldo (celulares, licencias, usuarios, .env)", rr["status"] == "ok"
              and "SHA-256 correcto" in rr["log"] and "817 celulares" in rr["log"] and ".env cifrados: si" in rr["log"], rr["log"])
        r = client.post("/api/restores", json={"mode": "aplicar", "point_id": p.id, "source": "local", "confirmacion": "RESTAURAR TODO"}, auth=auth)
        rid = r.json().get("id")
        for _ in range(50):
            rr = client.get(f"/api/restores/{rid}", auth=auth).json()
            if rr["status"] != "en_curso":
                break
            time.sleep(0.1)
        sent = SEEN["restaurar"][-1] if SEEN["restaurar"] else {}
        check("Restaurar en la aplicación: envía el respaldo con la confirmación y registra el resultado", rr["status"] == "ok"
              and sent.get("confirm") == "RESTAURAR TODO" and sent.get("body") == ARCHIVE and "Aplicacion restaurada" in rr["log"]
              and "AVISO: aviso de prueba" in rr["log"], rr["log"])
        jobs = client.get("/api/backup-jobs", auth=auth).json()
        check("La API de trabajos informa si respalda la aplicación (la usa la pantalla de Respaldos de la aplicación)",
              any(j["name"] == "Prueba app" and j["include_main_app"] and not j["include_repos"] for j in jobs))
    finally:
        db.close()
        server.shutdown()
        shutil.rmtree(ROOT, ignore_errors=True)

    fails = [n for ok, n in RESULTS if not ok]
    for ok, name in RESULTS:
        print(("OK    " if ok else "FALLA ") + name)
    print(f"{len(RESULTS)} pruebas, {len(fails)} fallas")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
