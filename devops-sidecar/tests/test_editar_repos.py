"""Editar un repositorio ya registrado (URL, token, intervalo) y su efecto en
los respaldos:
  - la URL se comprueba antes de guardar (si no se puede leer, no cambia nada);
  - el nombre no cambia, asi que los respaldos siguen en la misma carpeta;
  - mismo historial (repo movido o renombrado): el clon se re-apunta y la
    cadena sigue con incrementales;
  - otro historial: el clon anterior se aparta (no se borra), se clona de cero
    y el proximo respaldo sale completo.

Usa una base y carpetas TEMPORALES (nunca la base real). Los "remotos" son
repos bare locales.

Correr dentro del contenedor:
  docker compose exec devops-sidecar python tests/test_editar_repos.py
"""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(tempfile.mkdtemp(prefix="rt_editar_repos_"))
os.environ.update({
    "DATABASE_PATH": str(ROOT / "db" / "sidecar.db"),
    "BACKUPS_PATH": str(ROOT / "backups"),
    "REPOS_BASE_PATH": str(ROOT / "repos"),
    "REPORTS_PATH": str(ROOT / "reports"),
    "SSO_SHARED_SECRET": "",
})
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app import models, scheduler  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.services import backup_jobs, crypto_service  # noqa: E402

RESULTS: list[tuple[bool, str]] = []


def check(name, cond):
    RESULTS.append((bool(cond), name))


def sh(*args, cwd=None):
    r = subprocess.run(list(args), cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(args)}: {r.stderr}")
    return r.stdout.strip()


def bare_with_commit(name: str, text: str) -> Path:
    """Repo bare con un commit en main, y la copia de trabajo para agregar mas."""
    origin = ROOT / f"{name}.git"
    sh("git", "init", "-q", "--bare", str(origin))
    sh("git", "symbolic-ref", "HEAD", "refs/heads/main", cwd=origin)
    work = ROOT / f"work_{name}"
    sh("git", "clone", "-q", str(origin), str(work))
    sh("git", "checkout", "-q", "-b", "main", cwd=work)
    commit(work, "README.md", text)
    return origin


def commit(work: Path, file: str, text: str):
    (work / file).write_text(text, encoding="utf-8")
    sh("git", "add", "-A", cwd=work)
    sh("git", "-c", "user.name=Prueba", "-c", "user.email=p@x", "commit", "-q", "-m", f"cambio {file}", cwd=work)
    sh("git", "push", "-q", "origin", "main", cwd=work)


def last_point(db, job_id):
    return db.query(models.BackupPoint).filter(models.BackupPoint.job_id == job_id).order_by(models.BackupPoint.id.desc()).first()


def main():
    viejo = bare_with_commit("proyecto", "hola\n")
    base = Path(settings.repos_base_path)

    with TestClient(app) as c:
        c.auth = (settings.dashboard_user, settings.dashboard_password)
        r = c.post("/api/repos", json={"name": "proyecto", "github_url": str(viejo), "github_token": "tok-viejo-de-prueba", "sync_interval_minutes": 60})
        repo_id = r.json()["id"]
        scheduler.sync_repo_job(repo_id)
        clon = base / "proyecto"
        check("Alta y clon iniciales", r.status_code == 201 and (clon / "README.md").exists())

        db = SessionLocal()
        job = models.BackupJob(name="Prueba editar", include_repos=True, include_sidecar_db=False, include_main_app=False, include_bundle=True,
                               repo_ids_json=f"[{repo_id}]", destination_ids_json="[]", incrementals_per_full=6, keep_chains_local=3, keep_chains_remote=3)
        db.add(job)
        db.commit()
        backup_jobs.run_job(job.id, "manual")
        db.expire_all()
        p1 = last_point(db, job.id)
        check("Primer respaldo: completo", p1 is not None and p1.kind == "full")

        # ---- URL que no se puede leer: no cambia nada ----
        r = c.patch(f"/api/repos/{repo_id}", json={"github_url": str(ROOT / "no-existe.git"), "sync_interval_minutes": 30})
        db.expire_all()
        row = db.get(models.Repo, repo_id)
        check("URL que no se puede leer: rechazada y sin guardar nada", r.status_code == 422 and "no se guardó nada" in r.json()["detail"]
              and row.github_url == str(viejo) and row.sync_interval_minutes == 60
              and sh("git", "remote", "get-url", "origin", cwd=clon) == str(viejo))
        r = c.patch(f"/api/repos/{repo_id}", json={"github_url": "--upload-pack=touch /tmp/x", "sync_interval_minutes": 60})
        check("URL que parece una opción de git: rechazada", r.status_code == 422)

        # ---- mismo repositorio en otra URL (movido o renombrado), con un commit nuevo ----
        movido = ROOT / "proyecto-movido.git"
        sh("git", "clone", "-q", "--bare", str(viejo), str(movido))
        commit(ROOT / "work_proyecto", "nuevo.txt", "mas\n")  # el commit nuevo va al viejo...
        sh("git", "push", "-q", str(movido), "main", cwd=ROOT / "work_proyecto")  # ...y tambien al movido
        r = c.patch(f"/api/repos/{repo_id}", json={"github_url": str(movido), "sync_interval_minutes": 30})
        data = r.json()
        db.expire_all()
        row = db.get(models.Repo, repo_id)
        check("Mismo repositorio en otra URL: se guarda, se re-apunta el clon y lo informa", r.status_code == 200 and data["estado"] == "mismo" and data["url_changed"]
              and "misma cadena" in data["message"] and row.github_url == str(movido) and row.sync_interval_minutes == 30
              and sh("git", "remote", "get-url", "origin", cwd=clon) == str(movido))
        check("El nombre y la carpeta no cambian", row.name == "proyecto" and Path(row.local_path) == clon)
        check("Sin escribir token, se conserva el guardado", crypto_service.decrypt(row.github_token) == "tok-viejo-de-prueba")
        scheduler.sync_repo_job(repo_id)
        check("La sincronización trae el commit nuevo desde la nueva URL", (clon / "nuevo.txt").exists())
        backup_jobs.run_job(job.id, "manual")
        db.expire_all()
        p2 = last_point(db, job.id)
        check("Mismo historial: el siguiente respaldo es incremental, en la misma cadena", p2.id != p1.id and p2.kind == "incremental" and p2.chain_id == p1.chain_id)

        # ---- otro repositorio (historial distinto) ----
        otro = bare_with_commit("otro", "otro proyecto\n")
        r = c.patch(f"/api/repos/{repo_id}", json={"github_url": str(otro), "sync_interval_minutes": 30, "github_token": "tok-nuevo-de-prueba"})
        data = r.json()
        apartados = [p for p in base.iterdir() if p.name.startswith("proyecto.anterior-")]
        check("Otro historial: el clon anterior se aparta (no se borra) y lo informa", r.status_code == 200 and data["estado"] == "otro" and "completo" in data["message"]
              and len(apartados) == 1 and (apartados[0] / "nuevo.txt").exists())
        db.expire_all()
        check("Token nuevo guardado cifrado", crypto_service.decrypt(db.get(models.Repo, repo_id).github_token) == "tok-nuevo-de-prueba"
              and db.get(models.Repo, repo_id).github_token != "tok-nuevo-de-prueba")
        scheduler.sync_repo_job(repo_id)
        check("La sincronización clona de cero desde la nueva URL", (clon / "README.md").read_text(encoding="utf-8") == "otro proyecto\n" and not (clon / "nuevo.txt").exists())
        backup_jobs.run_job(job.id, "manual")
        db.expire_all()
        p3 = last_point(db, job.id)
        check("Otro historial: el siguiente respaldo es completo y los anteriores se conservan", p3.kind == "full" and p3.chain_id != p1.chain_id
              and db.query(models.BackupPoint).filter(models.BackupPoint.job_id == job.id).count() == 3)

        # ---- quitar el token y cambiar solo el intervalo ----
        r = c.patch(f"/api/repos/{repo_id}", json={"github_url": str(otro), "sync_interval_minutes": 120, "clear_token": True})
        db.expire_all()
        row = db.get(models.Repo, repo_id)
        check("Cambiar solo el intervalo y quitar el token", r.status_code == 200 and r.json()["estado"] == "sin_cambio" and row.sync_interval_minutes == 120 and row.github_token is None)
        r = c.patch("/api/repos/999999", json={"github_url": str(otro), "sync_interval_minutes": 60})
        check("Repositorio que no existe: 404", r.status_code == 404)

        page = c.get("/repos").text
        check("Pantalla: botón Editar por repositorio y formulario de edición", 'class="btn btn-sm btn-outline-primary btn-edit"' in page and 'id="editForm"' in page
              and 'name="clear_token"' in page and "El nombre no cambia" in page)
        check("Ni el token viejo ni el nuevo aparecen en la página ni en la API", "tok-" not in page and "tok-" not in c.get("/api/repos").text)
        db.close()

    c2 = TestClient(app)
    check("Sin usuario: no se puede editar", c2.patch(f"/api/repos/{repo_id}", json={"github_url": str(otro), "sync_interval_minutes": 60}).status_code == 401)


if __name__ == "__main__":
    try:
        main()
    finally:
        ok = sum(1 for passed, _ in RESULTS if passed)
        for passed, name in RESULTS:
            print(("PASA " if passed else "FALLA"), name)
        print(f"\n{ok}/{len(RESULTS)} pruebas correctas")
        shutil.rmtree(ROOT, ignore_errors=True)
        sys.exit(0 if ok == len(RESULTS) and RESULTS else 1)
