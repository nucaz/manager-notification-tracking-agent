"""Pruebas de extremo a extremo de la fase 3 (mirror Git de respaldo y
colaborador -> principal) y la fase 4 (restauracion desde el servidor y
desde destinos externos, y el destino Microsoft 365 por aplicacion).

Usa una base, repos y carpetas TEMPORALES (nunca la base real). Los
repositorios "remotos" son repos bare locales, asi se prueba git de
verdad sin escribir en GitHub. La API de GitHub y Microsoft Graph se
reemplazan por respuestas simuladas (no se puede crear un PR ni un tenant
de prueba sin cuentas reales).

Correr dentro del contenedor:
  docker compose exec devops-sidecar python tests/test_git_y_restauracion.py
"""
import io
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(tempfile.mkdtemp(prefix="rt_git_restore_"))
os.environ.update({
    "DATABASE_PATH": str(ROOT / "db" / "sidecar.db"),
    "BACKUPS_PATH": str(ROOT / "backups"),
    "REPOS_BASE_PATH": str(ROOT / "repos"),
    "REPORTS_PATH": str(ROOT / "reports"),
})
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import models, scheduler  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.services import git_service, git_targets, rclone_service  # noqa: E402

RESULTS: list[tuple[bool, str]] = []


def check(name, cond):
    RESULTS.append((bool(cond), name))


def sh(*args, cwd=None, ok=True):
    r = subprocess.run(list(args), cwd=cwd, capture_output=True, text=True)
    if ok and r.returncode != 0:
        raise RuntimeError(f"{' '.join(args)}: {r.stderr}")
    return r.stdout.strip()


def git_commit(work: Path, name: str, text: str, push=True):
    (work / name).write_text(text, encoding="utf-8")
    sh("git", "add", "-A", cwd=work)
    sh("git", "-c", "user.name=Prueba", "-c", "user.email=p@x", "commit", "-q", "-m", f"cambio {name}", cwd=work)
    if push:
        sh("git", "push", "-q", "origin", "HEAD", cwd=work)
    return sh("git", "rev-parse", "HEAD", cwd=work)


def heads(bare: Path) -> dict:
    out = sh("git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags", cwd=bare)
    return {ln.split()[0]: ln.split()[1] for ln in out.splitlines()}


def bare(path: Path) -> Path:
    sh("git", "init", "-q", "--bare", "-b", "main", str(path))
    return path


def fake_resp(status, payload, method="GET", url="https://x"):
    return httpx.Response(status, json=payload, request=httpx.Request(method, url))


def main():
    auth = (settings.dashboard_user, settings.dashboard_password)
    has_key = bool(settings.credentials_enc_key)

    origin = bare(ROOT / "origin.git")
    work = ROOT / "work"
    sh("git", "clone", "-q", str(origin), str(work))
    sh("git", "checkout", "-q", "-b", "main", cwd=work)
    c1 = git_commit(work, "README.md", "hola\n")
    sh("git", "checkout", "-q", "-b", "feature", cwd=work)
    git_commit(work, "feature.txt", "rama\n")
    sh("git", "checkout", "-q", "main", cwd=work)
    sh("git", "tag", "v1", cwd=work)
    sh("git", "push", "-q", "origin", "v1", cwd=work)
    # El "principal" nace como copia del repo: comparten historial.
    principal = ROOT / "principal.git"
    sh("git", "clone", "-q", "--bare", str(origin), str(principal))

    with TestClient(app) as c:
        c.auth = auth
        r = c.post("/api/repos", json={"name": "demo", "github_url": str(origin), "sync_interval_minutes": 60})
        check("Registrar repo de prueba", r.status_code == 201)
        repo_id = r.json()["id"]
        empty_origin = bare(ROOT / "vacio.git")
        vacio_id = c.post("/api/repos", json={"name": "vacio", "github_url": str(empty_origin), "sync_interval_minutes": 60}).json()["id"]

        # =================== Fase 3a: mirror de respaldo ===================
        def new_target(rid, **kw):
            body = {"name": kw.pop("name", "t"), "purpose": "mirror", "schedule": "manual", **kw}
            return c.post(f"/api/repos/{rid}/git-targets", json=body)

        check("Mirror hacia el MISMO repo de origen: rechazado", new_target(repo_id, url=str(origin)).status_code == 422)
        check("Mirror hacia OTRO repo registrado: rechazado (nunca --mirror sobre un repo de trabajo)",
              new_target(repo_id, url=str(empty_origin)).status_code == 422)
        r = new_target(repo_id, url="https://ghp_x@github.com/a/b.git")
        check("URL con token adentro: rechazada", r.status_code == 422 and "token" in r.json()["detail"].lower())
        check("URL que no es https ni ruta: rechazada", new_target(repo_id, url="git@github.com:a/b.git").status_code == 422)
        check("Rama con nombre invalido: rechazada",
              new_target(repo_id, url=str(ROOT / "x.git"), purpose="upstream", base_branch="mal..rama").status_code == 422)

        mp = bare(ROOT / "mirror_protegido.git")
        r = new_target(repo_id, name="Mirror protegido", url=str(mp), token="ghp_SECRETO_DE_PRUEBA", mirror_mode="protegido")
        check("Crear mirror protegido", r.status_code == 201)
        tp = r.json()
        listing = c.get(f"/api/repos/{repo_id}/git-targets").text
        check("La API nunca devuelve el token (solo token_set)", "SECRETO" not in listing and tp["token_set"])
        db = SessionLocal()
        row = db.get(models.GitTarget, tp["id"])
        if has_key:
            check("Token del destino Git cifrado en BD", row.token_enc.startswith("enc:v1:") and "SECRETO" not in row.token_enc)
        db.close()
        t = c.post(f"/api/git-targets/{tp['id']}/test").json()
        check(f"Probar mirror vacio: {t['message'][:60]}", t["ok"] and "vacio" in t["message"])
        c.post(f"/api/git-targets/{tp['id']}/run")
        tp = c.get(f"/api/repos/{repo_id}/git-targets").json()[0]
        src_refs = heads(origin)
        check(f"Mirror protegido: {tp['last_message'][:70]}", tp["last_status"] == "ok")
        check("Mirror: ramas y etiquetas identicas al origen", heads(mp) == src_refs and "refs/tags/v1" in src_refs)

        me = bare(ROOT / "mirror_exacto.git")
        te = new_target(repo_id, name="Mirror exacto", url=str(me), mirror_mode="exacto").json()
        c.post(f"/api/git-targets/{te['id']}/run")
        check("Mirror exacto: primer envio identico", heads(me) == src_refs)

        # Origen: se borra una rama y se reescribe main (force-push).
        old_main = src_refs["refs/heads/main"]
        sh("git", "push", "-q", "origin", "--delete", "feature", cwd=work)
        sh("git", "-c", "user.name=Prueba", "-c", "user.email=p@x", "commit", "-q", "--amend", "-m", "reescrito", cwd=work)
        sh("git", "push", "-q", "-f", "origin", "main", cwd=work)
        new_main = sh("git", "rev-parse", "HEAD", cwd=work)

        t = c.post(f"/api/git-targets/{te['id']}/test").json()
        check("Probar mirror exacto avisa que BORRARA la rama 'feature'", "BORRARA" in t["message"] and "feature" in t["message"])
        c.post(f"/api/git-targets/{tp['id']}/run")
        tp = next(x for x in c.get(f"/api/repos/{repo_id}/git-targets").json() if x["id"] == tp["id"])
        mh = heads(mp)
        check(f"Protegido tras force-push y borrado: aviso ({tp['last_message'][:60]})", tp["last_status"] == "aviso")
        kept = [ref for ref, sha in mh.items() if ref.startswith("refs/heads/sidecar-conservado/main-") and sha == old_main]
        check("Protegido conserva la rama borrada ('feature')", "refs/heads/feature" in mh)
        check("Protegido guarda el main anterior en sidecar-conservado/main-<fecha>", len(kept) == 1)
        check("Protegido sigue actualizado: main = main reescrito del origen", mh["refs/heads/main"] == new_main)
        c.post(f"/api/git-targets/{tp['id']}/run")
        tp = next(x for x in c.get(f"/api/repos/{repo_id}/git-targets").json() if x["id"] == tp["id"])
        check(f"Siguiente ejecucion sin cambios: ok, la rama conservada solo se informa ({tp['last_message'][:50]})",
              tp["last_status"] == "ok" and "conservan 1 rama" in tp["last_message"])
        c.post(f"/api/git-targets/{te['id']}/run")
        eh = heads(me)
        check("Exacto refleja el origen (rama borrada, main reescrito)",
              "refs/heads/feature" not in eh and eh["refs/heads/main"] == new_main)

        # Origen vaciado: el mirror exacto no vacia el respaldo.
        ev = bare(ROOT / "mirror_de_vacio.git")
        sh("git", "push", "-q", str(ev), f"{new_main}:refs/heads/main", cwd=work)
        tv = new_target(vacio_id, name="Mirror de vacio", url=str(ev), mirror_mode="exacto").json()
        c.post(f"/api/git-targets/{tv['id']}/run")
        tv = c.get(f"/api/repos/{vacio_id}/git-targets").json()[0]
        check(f"Origen sin ramas: no se vacia el respaldo ({tv['last_message'][:50]})",
              tv["last_status"] == "error" and heads(ev).get("refs/heads/main") == new_main)

        # Automatico despues de cada sync.
        c.put(f"/api/git-targets/{tp['id']}", json={"name": "Mirror protegido", "purpose": "mirror", "url": str(mp),
                                                    "mirror_mode": "protegido", "schedule": "after_sync"})
        c2 = git_commit(work, "despues.txt", "sync\n")
        scheduler.sync_repo_job(repo_id)
        check("Tras sincronizar, el mirror automatico ya tiene el commit nuevo", heads(mp)["refs/heads/main"] == c2)
        runs = c.get(f"/api/git-targets/{tp['id']}/runs").json()
        check("Historial de ejecuciones con disparo 'tras_sync'", runs and runs[0]["trigger"] == "tras_sync")

        # =============== Fase 3b: colaborador -> principal ===============
        # El principal quedo en c1; el colaborador (origin) reescribio main,
        # asi que para esta prueba se alinea el principal con el main nuevo
        # menos el ultimo commit (el colaborador va 1 adelante).
        sh("git", "push", "-q", "-f", str(principal), f"{new_main}:refs/heads/main", cwd=work)
        check("Upstream hacia el mismo repo de origen: rechazado",
              new_target(repo_id, purpose="upstream", url=str(origin)).status_code == 422)
        tu = new_target(repo_id, name="Principal", purpose="upstream", url=str(principal), push_mode="pr").json()
        check("Mirror hacia un repo que es el principal de una sincronizacion: rechazado",
              new_target(repo_id, url=str(principal)).status_code == 422)
        t = c.post(f"/api/git-targets/{tu['id']}/test").json()
        check(f"Probar principal: {t['message'][:60]}", t["ok"] and "encontrada" in t["message"])
        c.post(f"/api/git-targets/{tu['id']}/run")
        tu = next(x for x in c.get(f"/api/repos/{repo_id}/git-targets").json() if x["id"] == tu["id"])
        ph = heads(principal)
        check(f"Modo PR: rama sidecar-sync/main subida ({tu['last_message'][:60]})",
              ph.get("refs/heads/sidecar-sync/main") == c2 and ph["refs/heads/main"] == new_main)
        check("Fuera de GitHub/GitLab avisa que el PR se abre a mano", tu["last_status"] == "aviso" and "Pull Request" in tu["last_message"])

        td = new_target(repo_id, name="Principal directo", purpose="upstream", url=str(principal), push_mode="directo").json()
        c.post(f"/api/git-targets/{td['id']}/run")
        check("Modo directo con avance rapido: main del principal = colaborador", heads(principal)["refs/heads/main"] == c2)
        # El principal recibe un commit propio y el colaborador otro: divergen.
        other = ROOT / "otro_clon"
        sh("git", "clone", "-q", str(principal), str(other))
        p_commit = git_commit(other, "del_principal.txt", "p\n")
        git_commit(work, "del_colaborador.txt", "c\n")
        c.post(f"/api/git-targets/{td['id']}/run")
        td = next(x for x in c.get(f"/api/repos/{repo_id}/git-targets").json() if x["id"] == td["id"])
        check(f"Modo directo con historial divergente: NO sube ({td['last_message'][:55]})",
              td["last_status"] == "aviso" and heads(principal)["refs/heads/main"] == p_commit)

        unrelated = bare(ROOT / "ajeno.git")
        tmpw = ROOT / "ajeno_w"
        sh("git", "clone", "-q", str(unrelated), str(tmpw))
        sh("git", "checkout", "-q", "-b", "main", cwd=tmpw)
        git_commit(tmpw, "x.txt", "x\n")
        ta = new_target(repo_id, name="Ajeno", purpose="upstream", url=str(unrelated)).json()
        c.post(f"/api/git-targets/{ta['id']}/run")
        ta = next(x for x in c.get(f"/api/repos/{repo_id}/git-targets").json() if x["id"] == ta["id"])
        check("Repos sin historial comun: error claro", ta["last_status"] == "error" and "historial" in ta["last_message"])

        # API de GitHub simulada: crear PR, PR ya abierto, permisos.
        calls = []

        def gh_api(method, path, token, json_body=None, params=None):
            calls.append((method, path, json_body, params))
            if method == "POST":
                if len([x for x in calls if x[0] == "POST"]) == 1:
                    return fake_resp(201, {"html_url": "https://github.com/principal/proy/pull/7"}, "POST")
                return fake_resp(422, {"message": "Validation Failed", "errors": [{"message": "A pull request already exists for principal:sidecar-sync/main."}]}, "POST")
            if path.endswith("/pulls"):
                return fake_resp(200, [{"html_url": "https://github.com/principal/proy/pull/7"}])
            return fake_resp(200, {"permissions": {"push": False, "pull": True}})

        original_api = git_targets.github_api
        git_targets.github_api = gh_api
        try:
            fake = models.GitTarget(url="https://github.com/principal/proy.git", token_enc=crypto_token("ghp_x"),
                                    repo=models.Repo(name="demo", github_url="https://github.com/colab/proy"))
            url1, msg1 = git_targets.create_pull_request(fake, "sidecar-sync/main", "main", 3, "main")
            post = calls[0]
            check("PR: POST /repos/principal/proy/pulls con head y base correctos",
                  post[1] == "/repos/principal/proy/pulls" and post[2]["head"] == "sidecar-sync/main" and post[2]["base"] == "main")
            check("PR creado: devuelve su URL", url1 == "https://github.com/principal/proy/pull/7")
            url2, msg2 = git_targets.create_pull_request(fake, "sidecar-sync/main", "main", 1, "main")
            check("PR ya abierto: se reutiliza y se informa", url2 == url1 and "ya estaba abierto" in msg2)
            ok, msg = git_targets.check_github_access(fake)
            check("Token solo de lectura: se detecta antes de ejecutar", ok is False and "escribir" in msg)
            git_targets.github_api = lambda *a, **k: fake_resp(404, {"message": "Not Found"})
            fake.token_enc = crypto_token("github_pat_x")
            ok, msg = git_targets.check_github_access(fake)
            check("Token de grano fino sin acceso: explica usar token clasico 'repo'", ok is False and "clasico" in msg)
        finally:
            git_targets.github_api = original_api
        check("Usuario por defecto: GitLab 'oauth2', GitHub 'x-access-token'",
              git_targets.default_user("https://gitlab.com/a/b") == "oauth2" and git_targets.default_user("https://github.com/a/b") == "x-access-token")

        # ====================== Fase 4: restauracion ======================
        scheduler.sync_repo_job(repo_id)
        ext_plain = ROOT / "ext_plain"
        ext_enc = ROOT / "ext_enc"
        d_plain = c.post("/api/backup-destinations", json={"name": "Disco", "kind": "local", "remote_path": str(ext_plain), "config": {}}).json()
        d_enc = c.post("/api/backup-destinations", json={"name": "Disco cifrado", "kind": "local", "remote_path": str(ext_enc), "encrypt": True,
                                                          "config": {"crypt_password": "clave-cifrado", "crypt_password2": "sal"}}).json()
        job = c.post("/api/backup-jobs", json={"name": "Restaurables", "repo_ids": [repo_id], "include_content": True, "frequency": "daily",
                                               "hour": 3, "minute": 0, "incrementals_per_full": 6, "keep_chains_local": 2,
                                               "keep_chains_remote": 3, "destination_ids": [d_plain["id"], d_enc["id"]]}).json()
        shas = []
        for i in range(3):
            if i:
                git_commit(work, f"restaurar{i}.txt", f"v{i}\n")
                scheduler.sync_repo_job(repo_id)
            c.post(f"/api/backup-jobs/{job['id']}/run")
            shas.append(sh("git", "rev-parse", "HEAD", cwd=work))
        points = [p for p in c.get(f"/api/backup-jobs/{job['id']}/points").json() if p["repo"] == "demo"]
        points.sort(key=lambda p: p["seq"])
        check("Cadena para restaurar: completo + 2 incrementales en ambos destinos",
              [p["seq"] for p in points] == [0, 1, 2] and all(sum(t["status"] == "ok" for t in p["transfers"]) == 2 for p in points))
        db_point = next(p for p in c.get(f"/api/backup-jobs/{job['id']}/points").json() if p["repo"] == "_sidecar_db")

        def restore(**body):
            r = c.post("/api/restores", json=body)
            if r.status_code != 202:
                return r.status_code, r.json()
            return r.status_code, c.get(f"/api/restores/{r.json()['id']}").json()

        src = c.get(f"/api/backup-points/{points[2]['id']}/sources").json()
        check("Fuentes del punto: servidor + 2 destinos", len(src["sources"]) == 3)
        code, rr = restore(mode="verificar", point_id=points[2]["id"], source="local")
        check(f"Probar restauracion desde el servidor: {rr['status']}", rr["status"] == "ok" and "consistente" in rr["log"])
        check("Prueba de restauracion no deja archivos", rr["outputs"] == [] and not (ROOT / "backups" / "restores" / str(rr["id"])).exists())

        code, rr = restore(mode="descargar", point_id=points[1]["id"], source=str(d_enc["id"]))
        check(f"Restaurar #1 desde destino CIFRADO y preparar descarga: {rr['status']}",
              rr["status"] == "ok" and "descifrado" in rr["log"] and len(rr["outputs"]) == 2)
        tar_name = next(o["name"] for o in rr["outputs"] if o["name"].endswith(".git.tar.gz"))
        dl = c.get(f"/api/restores/{rr['id']}/archivo/{tar_name}")
        check("Descargar el repositorio restaurado", dl.status_code == 200 and len(dl.content) > 100)
        out = ROOT / "descargado"
        with tarfile.open(fileobj=io.BytesIO(dl.content), mode="r:gz") as tar:
            tar.extractall(out, filter="data")
        clone = ROOT / "clon_restaurado"
        sh("git", "clone", "-q", str(out / "demo.git"), str(clone))
        check("El clon restaurado apunta al commit del punto #1", sh("git", "rev-parse", "HEAD", cwd=clone) == shas[1])
        check("El clon restaurado tiene el archivo del incremental #1", (clone / "restaurar1.txt").exists() and not (clone / "restaurar2.txt").exists())
        check("Nombre de archivo fuera de la lista: 404", c.get(f"/api/restores/{rr['id']}/archivo/..%2Fsidecar.db").status_code == 404)

        ex = c.get(f"/api/backup-destinations/{d_enc['id']}/explorar").json()
        chain = next(ch for ch in ex["chains"] if ch["repo"] == "demo")
        check("Explorar destino cifrado: nombres descifrados y 3 puntos", [p["seq"] for p in chain["points"]] == [0, 1, 2] and chain["has_manifest"])
        check("Explorar muestra tambien la copia de la base", any(ch["is_db"] for ch in ex["chains"]))
        code, rr = restore(mode="verificar", destination_id=d_enc["id"], chain_path=chain["path"], seq=2)
        check("Restaurar desde lo explorado (sin usar la base del sidecar)", rr["status"] == "ok" and "punto #2" in rr["log"])

        code, body = restore(mode="verificar", destination_id=d_enc["id"], chain_path="../x/y", seq=0)
        check("Ruta de cadena con '..': rechazada", code == 422)

        # Archivo danado en el servidor.
        local_chain = ROOT / "backups" / "jobs" / str(job["id"]) / "demo" / points[0]["chain_label"]
        bundle1 = next(local_chain.glob("01_incremental_*.bundle"))
        original = bundle1.read_bytes()
        bundle1.write_bytes(original + b"x")
        code, rr = restore(mode="verificar", point_id=points[2]["id"], source="local")
        check("Bundle alterado: se detecta por SHA-256 y no se restaura", rr["status"] == "error" and "DANADO" in rr["log"])
        bundle1.write_bytes(original)
        # Falta un incremental en el destino.
        remote_chain = ext_plain / chain["path"]
        missing = next(remote_chain.glob("01_incremental_*.bundle"))
        missing.rename(missing.with_suffix(".aparte"))
        code, rr = restore(mode="verificar", point_id=points[2]["id"], source=str(d_plain["id"]))
        check("Falta el incremental #1 en el destino: error claro", rr["status"] == "error" and "Falta 01_incremental" in rr["log"])
        missing.with_suffix(".aparte").rename(missing)
        code, rr = restore(mode="verificar", point_id=points[0]["id"], source=str(d_plain["id"]))
        check("El completo solo (#0) se restaura sin los incrementales", rr["status"] == "ok")

        # Subir a un repositorio Git.
        dest_repo = bare(ROOT / "restaurado.git")
        code, rr = restore(mode="subir", point_id=points[2]["id"], source="local", push_url=str(dest_repo))
        check(f"Subir lo restaurado a un repo vacio: {rr['status']}", rr["status"] == "ok" and heads(dest_repo)["refs/heads/main"] == shas[2])
        code, rr = restore(mode="subir", point_id=points[2]["id"], source="local", push_url=str(unrelated))
        check("Subir a un repo con otro historial: se detiene sin forzar y sin subir nada (atomico)",
              rr["status"] == "error" and "no se fuerza" in rr["log"] and heads(unrelated)["refs/heads/main"] != shas[2]
              and "refs/tags/v1" not in heads(unrelated))
        code, body = restore(mode="subir", point_id=db_point["id"], source="local", push_url=str(dest_repo))
        check("La base del sidecar no se puede 'subir a Git'", code == 422)

        code, rr = restore(mode="descargar", point_id=db_point["id"], source=str(d_enc["id"]))
        check(f"Base del sidecar desde destino cifrado: integridad y descarga ({rr['status']})",
              rr["status"] == "ok" and "integra" in rr["log"] and rr["outputs"][0]["name"].endswith(".db.gz"))

        for url in ("/backups/restaurar", f"/repos/{repo_id}", f"/backups/trabajos/{job['id']}"):
            check(f"Pagina {url} responde 200", c.get(url).status_code == 200)

        # ============ Microsoft 365 con aplicacion (simulado) ============
        r = c.post("/api/backup-destinations", json={"name": "M365 mal", "kind": "onedrive_app", "remote_path": "Respaldos",
                                                     "config": {"tenant": "empresa com/../", "client_id": "a", "client_secret": "b", "target": "x@y"}})
        check("M365 app: tenant invalido rechazado", r.status_code == 422)
        original_discover = rclone_service.discover_onedrive_app
        rclone_service.discover_onedrive_app = lambda cfg: {"drive_id": "b!DRIVE123", "drive_type": "business", "account": cfg["target"]}
        try:
            r = c.post("/api/backup-destinations", json={"name": "M365 empresa", "kind": "onedrive_app", "remote_path": "Respaldos/sidecar",
                                                         "config": {"tenant": "empresa.onmicrosoft.com", "client_id": "11111111-2222",
                                                                    "client_secret": "SECRETO-APP", "target_type": "user", "target": "respaldos@empresa.com"}})
        finally:
            rclone_service.discover_onedrive_app = original_discover
        m = r.json()
        check("M365 app: destino creado con la unidad detectada", r.status_code == 201 and m["config"].get("drive_id") == "b!DRIVE123"
              and m["account_label"] == "respaldos@empresa.com")
        check("M365 app: el secreto no se devuelve", "SECRETO-APP" not in r.text and "client_secret" in m["secrets_set"])
        db = SessionLocal()
        dest = db.get(models.BackupDestination, m["id"])
        conf, _ = rclone_service._conf_sections(dest, rclone_service.load_config(dest), ROOT)
        db.close()
        check("M365 app: rclone.conf usa client_credentials y tenant, sin token de usuario",
              "type = onedrive" in conf and "client_credentials = true" in conf and "tenant = empresa.onmicrosoft.com" in conf
              and "token =" not in conf and "drive_type = business" in conf)
        original_post = httpx.post
        httpx.post = lambda *a, **k: fake_resp(401, {"error": "invalid_client", "error_description":
                                                     "AADSTS7000215: Invalid client secret provided.\r\nTrace ID: x"}, "POST")
        try:
            try:
                rclone_service.graph_app_token({"tenant": "t", "client_id": "a", "client_secret": "b"})
                msg = ""
            except rclone_service.RcloneError as e:
                msg = str(e)
        finally:
            httpx.post = original_post
        check("M365 app: secreto invalido da el error de Microsoft (AADSTS...)", "AADSTS7000215" in msg and "Trace" not in msg)


def crypto_token(value: str) -> str:
    from app.services import crypto_service
    return crypto_service.encrypt(value)


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
