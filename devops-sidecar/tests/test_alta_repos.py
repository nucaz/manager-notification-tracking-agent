"""Alta de repositorios: el nombre se usa como carpeta del clon y la URL como
argumento de git, asi que los dos se validan. Un nombre que en realidad es una
URL (error comun al llenar el formulario) se convierte en el nombre del
repositorio; uno vacio se toma de la URL.

Usa una base y carpetas TEMPORALES (nunca la base real). El "remoto" es un
repo bare local.

Correr dentro del contenedor:
  docker compose exec devops-sidecar python tests/test_alta_repos.py
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(tempfile.mkdtemp(prefix="rt_alta_repos_"))
os.environ.update({
    "DATABASE_PATH": str(ROOT / "db" / "sidecar.db"),
    "BACKUPS_PATH": str(ROOT / "backups"),
    "REPOS_BASE_PATH": str(ROOT / "repos"),
    "REPORTS_PATH": str(ROOT / "reports"),
    "SSO_SHARED_SECRET": "",
})
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app import scheduler  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402
from app.schemas import repo_name_from  # noqa: E402

RESULTS: list[tuple[bool, str]] = []


def check(name, cond):
    RESULTS.append((bool(cond), name))


def sh(*args, cwd=None):
    r = subprocess.run(list(args), cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(args)}: {r.stderr}")
    return r.stdout.strip()


def main():
    check("Nombre a partir de una URL de GitHub", repo_name_from("https://github.com/depilzone-git/app-clinic-web.git") == "app-clinic-web"
          and repo_name_from("https://github.com/org/repo/") == "repo" and repo_name_from("git@github.com:org/otro.git") == "otro")
    check("Un nombre normal queda igual", repo_name_from("  APLICACION DE PRODUCTIVIDAD  ") == "APLICACION DE PRODUCTIVIDAD")

    origin = ROOT / "app-clinic-web.git"
    sh("git", "init", "-q", "--bare", str(origin))
    sh("git", "symbolic-ref", "HEAD", "refs/heads/main", cwd=origin)  # rama por defecto = main
    work = ROOT / "work"
    sh("git", "clone", "-q", str(origin), str(work))
    sh("git", "checkout", "-q", "-b", "main", cwd=work)
    (work / "README.md").write_text("hola\n", encoding="utf-8")
    sh("git", "add", "-A", cwd=work)
    sh("git", "-c", "user.name=Prueba", "-c", "user.email=p@x", "commit", "-q", "-m", "inicial", cwd=work)
    sh("git", "push", "-q", "origin", "main", cwd=work)
    base = Path(settings.repos_base_path)

    with TestClient(app) as c:
        c.auth = (settings.dashboard_user, settings.dashboard_password)
        add = lambda **kw: c.post("/api/repos", json={"sync_interval_minutes": 60, **kw})  # noqa: E731

        # El caso real: la URL pegada tambien en el campo Nombre.
        r = add(name="https://github.com/depilzone-git/app-clinic-web.git", github_url=str(origin), github_token="  tok-de-prueba  ")
        check("Una URL en el campo Nombre se convierte en el nombre del repositorio", r.status_code == 201 and r.json()["name"] == "app-clinic-web"
              and Path(r.json()["local_path"]) == base / "app-clinic-web")
        scheduler.sync_repo_job(r.json()["id"])
        status = next(x for x in c.get("/api/repos").json() if x["name"] == "app-clinic-web")["last_sync_status"]
        check("Se clona en su carpeta, dentro de la carpeta de repositorios", (base / "app-clinic-web" / "README.md").exists() and "OK" in (status or ""))
        check("No quedan carpetas con forma de URL", not (base / "https:").exists())

        r = add(name="", github_url=str(ROOT / "otro-proyecto.git"))
        check("Sin nombre: se toma de la URL", r.status_code == 201 and r.json()["name"] == "otro-proyecto")
        r = add(name="app-clinic-web", github_url=str(origin))
        check("Nombre repetido: 409 con mensaje claro", r.status_code == 409 and "Ya existe" in r.json()["detail"])

        r = add(name="../../etc", github_url=str(origin))
        check("Un nombre que es una ruta queda en su último tramo, nunca sale de la carpeta", r.status_code == 201 and r.json()["name"] == "etc"
              and Path(r.json()["local_path"]) == base / "etc")
        r = add(name="..", github_url=str(origin))
        check("Nombre '..': rechazado", r.status_code == 422 and "identificador" in str(r.json()["detail"]))
        r = add(name="mi;repo$(id)", github_url=str(origin))
        check("Nombre con caracteres de comando: rechazado", r.status_code == 422)

        r = add(name="x1", github_url="--upload-pack=touch /tmp/pwn")
        check("URL que empieza con guion (opción de git): rechazada", r.status_code == 422 and "URL" in str(r.json()["detail"]))
        r = add(name="x2", github_url="https://github.com/org/repo.git --mirror")
        check("URL con espacios: rechazada", r.status_code == 422)
        r = add(name="x3", github_url="https://github.com/org/privado.git", github_token="   ")
        check("Token en blanco se guarda como sin token", r.status_code == 201)

        page = c.get("/repos").text
        check("Formulario: la URL va primero, el nombre es opcional y hay aviso de estado", page.index('name="github_url"') < page.index('name="name"')
              and 'id="repoEstado"' in page and "detalleDe" in page and 'name="name" id="repo_name" class="form-control" placeholder' in page)
        check("El token no aparece en la página ni en la API", "tok-de-prueba" not in page and "tok-de-prueba" not in c.get("/api/repos").text)


if __name__ == "__main__":
    try:
        main()
    finally:
        ok = sum(1 for passed, _ in RESULTS if passed)
        for passed, name in RESULTS:
            print(("PASA " if passed else "FALLA"), name)
        print(f"\n{ok}/{len(RESULTS)} pruebas correctas")
        import shutil
        shutil.rmtree(ROOT, ignore_errors=True)
        sys.exit(0 if ok == len(RESULTS) and RESULTS else 1)
