"""Pruebas de extremo a extremo de los sistemas externos (bases en Azure y
sitios WordPress) contra servidores REALES desechables. Base, carpetas y
destinos son temporales; nunca toca la base real del sidecar.

Levantar los servidores en la red del sidecar (una vez):
  N=glpi-licencias-app_default
  docker run -d --name ext_mysql --network $N -e MYSQL_ROOT_PASSWORD=Raiz-Prueba-1 mysql:8.4
  docker run -d --name ext_maria --network $N -e MARIADB_ROOT_PASSWORD=Raiz-Prueba-1 mariadb:11.4
  MSYS_NO_PATHCONV=1 docker run -d --name ext_pg --network $N -e POSTGRES_PASSWORD=Raiz-Prueba-1 postgres:18 \
      -c ssl=on -c ssl_cert_file=/etc/ssl/certs/ssl-cert-snakeoil.pem -c ssl_key_file=/etc/ssl/private/ssl-cert-snakeoil.key
  docker run -d --name ext_mssql --network $N -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD=Raiz-Prueba-1x mcr.microsoft.com/mssql/server:2022-latest
  (SQL Server: crear antes la base Facturas, ver EXT_MSSQL en este archivo)
Correr:
  docker compose exec -e EXT_PRUEBAS=1 devops-sidecar python tests/test_sistemas_externos.py
  MSYS_NO_PATHCONV=1 docker run -d --name ext_ftp --network $N -e PUBLICHOST=ext_ftp -e FTP_USER_NAME=ftpu       -e FTP_USER_PASS=clave-ftp -e FTP_USER_HOME=/home/ftpu -e TLS_CN=hosting.prueba -e TLS_ORG=Prueba -e TLS_C=PE       -e ADDED_FLAGS=--tls=2 stilliard/pure-ftpd
El sitio WordPress se sirve por FTPS obligatorio con Pure-FTPd (el servidor
FTP de cPanel) y un certificado propio, como el de muchos hostings.
"""
import gzip
import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(tempfile.mkdtemp(prefix="rt_externos_"))
os.environ.update({
    "DATABASE_PATH": str(ROOT / "db" / "sidecar.db"),
    "BACKUPS_PATH": str(ROOT / "backups"),
    "REPOS_BASE_PATH": str(ROOT / "repos"),
    "REPORTS_PATH": str(ROOT / "reports"),
    "SSO_SHARED_SECRET": "",
})
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app import models  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.services import backup_jobs, external_sources  # noqa: E402

ROOTPW = "Raiz-Prueba-1"
RO_PW = "Solo-Lectura_9$x"
WP_PW = "Wp-Clave_9$z"
RESULTS: list[tuple[bool, str]] = []


def check(name, cond):
    RESULTS.append((bool(cond), name))


def run(args, env=None, stdin=None):
    r = subprocess.run(args, capture_output=True, text=True, env=env, input=stdin, timeout=600)
    if r.returncode != 0:
        raise RuntimeError(f"{args[0]}: {r.stderr[-500:]}")
    return r.stdout


def maria(host, sql, db=""):
    """Cliente como root para preparar y comprobar (no lo usa el respaldo)."""
    return run(["mariadb", "-h", host, "-uroot", f"-p{ROOTPW}", "--skip-ssl", "-N", "-B", "-e", sql, *([db] if db else [])])


def psql(sql, db="postgres"):
    env = dict(os.environ, PGPASSWORD=ROOTPW, PGSSLMODE="require")
    return run(["psql", "-X", "-A", "-t", "-h", "ext_pg", "-U", "postgres", "-d", db, "-c", sql], env=env)


def ftp_upload(local: Path, remote: str, copyto: bool = False):
    """Sube por FTPS al Pure-FTPd de prueba (el servidor FTP de cPanel)."""
    pw = run(["rclone", "obscure", "clave-ftp"], env=dict(os.environ, HOME=str(ROOT))).strip()
    run(["rclone", "copyto" if copyto else "sync", str(local), f":ftp:{remote}", "--ftp-host", "ext_ftp", "--ftp-user", "ftpu",
         "--ftp-pass", pw, "--ftp-explicit-tls", "--ftp-no-check-certificate"], env=dict(os.environ, HOME=str(ROOT)))


def make_wordpress(site: Path):
    (site / "wp-content" / "uploads" / "2026" / "10").mkdir(parents=True)
    (site / "wp-content" / "themes" / "landing").mkdir(parents=True)
    (site / "wp-content" / "cache").mkdir(parents=True)
    (site / "wp-admin").mkdir(parents=True)
    (site / "wp-config.php").write_text(
        "<?php\ndefine( 'DB_NAME', 'wp' );\ndefine( 'DB_USER', 'wpuser' );\n"
        f"define( 'DB_PASSWORD', '{WP_PW}' );\ndefine( 'DB_HOST', 'localhost' );\n$table_prefix = 'lp_';\n", encoding="utf-8")
    (site / "index.php").write_text("<?php require __DIR__ . '/wp-blog-header.php';\n")
    (site / "wp-admin" / "index.php").write_text("<?php // nucleo\n")
    (site / "wp-content" / "themes" / "landing" / "style.css").write_text("/* Theme Name: Landing */\nbody{color:#123}\n")
    (site / "wp-content" / "uploads" / "2026" / "10" / "foto.jpg").write_bytes(bytes(range(256)) * 400)
    (site / "wp-content" / "cache" / "pagina.html").write_bytes(b"x" * 50000)


def d_kind(defs, name):
    return defs[name]["kind"]


def main():
    if os.environ.get("EXT_PRUEBAS") != "1":
        print("Requiere los servidores de prueba (ver el comentario al inicio) y EXT_PRUEBAS=1.")
        return 0
    auth = (settings.dashboard_user, settings.dashboard_password)

    # ---------------- datos reales en cada servidor ----------------
    for _ in range(30):
        try:
            maria("ext_mysql", "SELECT 1")
            maria("ext_maria", "SELECT 1")
            psql("SELECT 1")
            break
        except RuntimeError:
            time.sleep(3)
    maria("ext_mysql", "DROP DATABASE IF EXISTS ventas; DROP DATABASE IF EXISTS ventas_restaurada; CREATE DATABASE ventas;"
          "DROP USER IF EXISTS 'respaldo'@'%'; CREATE USER 'respaldo'@'%' IDENTIFIED BY '" + RO_PW + "';"
          "GRANT SELECT, SHOW VIEW, TRIGGER, EVENT ON ventas.* TO 'respaldo'@'%'; GRANT SHOW_ROUTINE ON *.* TO 'respaldo'@'%';")
    maria("ext_mysql", "CREATE TABLE clientes (id INT PRIMARY KEY AUTO_INCREMENT, nombre VARCHAR(80), foto BLOB, total DECIMAL(10,2));"
          "INSERT INTO clientes (nombre, foto, total) VALUES ('Ñandú Pérez', UNHEX('00FF10'), 120.50), ('Zoë \\'comilla', NULL, 9.99);"
          "INSERT INTO clientes (nombre, total) SELECT CONCAT('cliente ', a.n * 10 + b.n), a.n + b.n FROM "
          "(SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) a, "
          "(SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) b;"
          "CREATE VIEW vip AS SELECT id, nombre FROM clientes WHERE total > 100;"
          "CREATE PROCEDURE contar() SELECT COUNT(*) FROM clientes;", "ventas")
    maria("ext_maria", "DROP DATABASE IF EXISTS wp; DROP DATABASE IF EXISTS wp_restaurada; CREATE DATABASE wp;"
          "DROP USER IF EXISTS 'wpuser'@'%'; CREATE USER 'wpuser'@'%' IDENTIFIED BY '" + WP_PW + "'; GRANT ALL ON wp.* TO 'wpuser'@'%';")
    maria("ext_maria", "CREATE TABLE lp_options (option_id INT PRIMARY KEY AUTO_INCREMENT, option_name VARCHAR(191), option_value LONGTEXT);"
          "INSERT INTO lp_options (option_name, option_value) VALUES ('siteurl', 'https://landing.prueba'), ('blogname', 'Landing Ñ');", "wp")
    psql("DROP DATABASE IF EXISTS inventario")
    psql("DROP DATABASE IF EXISTS inventario_restaurada")
    psql("DROP ROLE IF EXISTS respaldo")
    psql("CREATE DATABASE inventario")
    psql(f"CREATE ROLE respaldo LOGIN PASSWORD '{RO_PW}'; GRANT pg_read_all_data TO respaldo")
    psql("CREATE TABLE equipos (id serial PRIMARY KEY, nombre text, datos jsonb); "
         "INSERT INTO equipos (nombre, datos) SELECT 'equipo ' || g, jsonb_build_object('n', g) FROM generate_series(1, 250) g", "inventario")

    site = ROOT / "sitio_local"
    make_wordpress(site)
    ftp_upload(site, "public_html/landing")
    try:
        with TestClient(app) as c:
            c.auth = auth
            kinds = c.get("/api/external-sources/kinds").json()["kinds"]
            check("Tipos: MySQL, PostgreSQL, Azure SQL y WordPress", set(kinds) == {"mysql", "postgres", "mssql", "wordpress"})

            # ---------------- validaciones ----------------
            r = c.post("/api/external-sources", json={"name": "malo", "kind": "mysql", "config": {
                "host": "https://servidor.mysql.database.azure.com", "database": "x", "user": "u", "password": "p"}})
            check("Servidor con https:// rechazado", r.status_code == 422 and "Servidor no valido" in r.json()["detail"])
            r = c.post("/api/external-sources", json={"name": "malo", "kind": "wordpress", "config": {
                "host": "h", "user": "u", "password": "p", "wp_path": "../etc"}})
            check("Carpeta WordPress con '..' rechazada", r.status_code == 422)
            r = c.post("/api/external-sources", json={"name": "malo", "kind": "mysql", "config": {"host": "h"}})
            check("Faltan campos obligatorios: mensaje claro", r.status_code == 422 and "Falta: Base de datos" in r.json()["detail"])

            # ---------------- alta de los cuatro sistemas ----------------
            defs = {
                "BD ventas (MySQL 8.4)": {"kind": "mysql", "config": {"host": "ext_mysql", "database": "ventas", "user": "respaldo",
                                                                    "password": RO_PW, "tls": "cifrar"}},
                "BD inventario (PostgreSQL 18)": {"kind": "postgres", "config": {"host": "ext_pg", "database": "inventario", "user": "respaldo",
                                                                                "password": RO_PW, "sslmode": "require"}},
                "Landing (WordPress)": {"kind": "wordpress", "config": {"protocol": "ftps", "host": "ext_ftp", "user": "ftpu",
                                                                      "password": "clave-ftp", "wp_path": "public_html/landing", "verify_cert": "no",
                                                                      "db_host": "ext_maria", "db_tls": "cifrar"}},
            }
            if os.environ.get("EXT_MSSQL") == "1":
                defs["BD facturas (SQL Server)"] = {"kind": "mssql", "config": {"host": "ext_mssql", "database": "Facturas", "user": "respaldo",
                                                                               "password": "Solo-Lectura_9$x", "tls": "confiar"}}
            ids = {}
            for name, d in defs.items():
                r = c.post("/api/external-sources", json={"name": name, **d})
                check(f"Crear {name}", r.status_code == 201)
                ids[name] = r.json()["id"]
            listing = c.get("/api/external-sources").text
            check("La lista no expone ninguna contrasena", all(s not in listing for s in (RO_PW, "clave-ftp", WP_PW)))
            raw = SessionLocal().get(models.ExternalSource, ids["BD ventas (MySQL 8.4)"]).config_enc
            if settings.credentials_enc_key:
                check("Conexion guardada cifrada en la base del sidecar", raw.startswith("enc:v1:") and RO_PW not in raw)

            for name, sid in ids.items():
                t = c.post(f"/api/external-sources/{sid}/test").json()
                # El usuario de wp-config.php escribe (WordPress lo necesita): se avisa.
                expect_aviso = d_kind(defs, name) == "wordpress"
                check(f"Probar {name}: {t['message'][:110]}", t["ok"] and (("usuario de WordPress" in t["message"]) if expect_aviso else "AVISO" not in t["message"]))

            # ---------------- errores que el usuario va a ver ----------------
            mysql_id = ids["BD ventas (MySQL 8.4)"]
            r = c.put(f"/api/external-sources/{mysql_id}", json={"name": "BD ventas (MySQL 8.4)", **defs["BD ventas (MySQL 8.4)"],
                                                                "config": {**defs["BD ventas (MySQL 8.4)"]["config"], "tls": "verificar", "password": ""}})
            check("Editar sin reescribir la contrasena la conserva", r.status_code == 200)
            t = c.post(f"/api/external-sources/{mysql_id}/test").json()
            check(f"Certificado propio con 'verificar': falla y sugiere que hacer ({t['message'][:80]})",
                  not t["ok"] and "Cifrado sin verificar" in t["message"])
            c.put(f"/api/external-sources/{mysql_id}", json={"name": "BD ventas (MySQL 8.4)", **defs["BD ventas (MySQL 8.4)"]})
            r = c.post("/api/external-sources", json={"name": "clave mala", "kind": "mysql", "config": {
                "host": "ext_mysql", "database": "ventas", "user": "respaldo", "password": "incorrecta", "tls": "cifrar"}})
            t = c.post(f"/api/external-sources/{r.json()['id']}/test").json()
            check("Contrasena incorrecta: error claro", not t["ok"] and "usuario o contrasena" in t["message"])
            c.delete(f"/api/external-sources/{r.json()['id']}")
            r = c.post("/api/external-sources", json={"name": "admin", "kind": "mysql", "config": {
                "host": "ext_mysql", "database": "ventas", "user": "root", "password": ROOTPW, "tls": "cifrar"}})
            t = c.post(f"/api/external-sources/{r.json()['id']}/test").json()
            check("Usuario con permisos de escritura: aviso de usar uno de solo lectura", t["ok"] and "AVISO" in t["message"])
            c.delete(f"/api/external-sources/{r.json()['id']}")
            r = c.post("/api/external-sources", json={"name": "caido", "kind": "postgres", "config": {
                "host": "10.255.255.1", "database": "x", "user": "u", "password": "p", "sslmode": "require"}})
            t = c.post(f"/api/external-sources/{r.json()['id']}/test").json()
            check("Servidor que no responde (firewall de Azure): sugiere agregar la IP", not t["ok"] and "IP publica" in t["message"])
            c.delete(f"/api/external-sources/{r.json()['id']}")
            wp_id = ids["Landing (WordPress)"]
            wp_def = defs["Landing (WordPress)"]
            c.put(f"/api/external-sources/{wp_id}", json={"name": "Landing (WordPress)", "kind": "wordpress",
                                                         "config": {**wp_def["config"], "verify_cert": "si", "password": ""}})
            t = c.post(f"/api/external-sources/{wp_id}/test").json()
            check("FTPS con certificado propio y 'Verificar': rechazado", not t["ok"])
            c.put(f"/api/external-sources/{wp_id}", json={"name": "Landing (WordPress)", **wp_def})

            # ---------------- trabajo, destino y ejecucion ----------------
            dest = c.post("/api/backup-destinations", json={"name": "Disco cifrado", "kind": "local", "remote_path": str(ROOT / "externo"),
                                                            "encrypt": True, "config": {"crypt_password": "Cifrado-Prueba-7"}}).json()
            job = c.post("/api/backup-jobs", json={"name": "Externos nocturno", "include_repos": False, "include_sidecar_db": False,
                                                   "include_bundle": False, "include_diff": False, "frequency": "daily", "hour": 3,
                                                   "minute": 0, "incrementals_per_full": 0, "keep_chains_local": 2, "keep_chains_remote": 3,
                                                   "destination_ids": [dest["id"]], "source_ids": list(ids.values())})
            check("Trabajo solo con sistemas externos", job.status_code == 201 and len(job.json()["source_names"]) == len(ids))
            job = job.json()
            r = c.delete(f"/api/external-sources/{mysql_id}")
            check("No se borra un sistema que usa un trabajo", r.status_code == 409)
            t = c.post(f"/api/backup-jobs/{job['id']}/test").json()
            check("Probar el trabajo revisa cada sistema", t["ok"] and sum(1 for x in t["checks"] if x["kind"] == "sistema") == len(ids))

            run_id = backup_jobs.run_job(job["id"], "manual")
            s = SessionLocal()
            rr = s.get(models.BackupJobRun, run_id)
            check(f"Ejecucion: {rr.status}", rr.status == "ok")
            if rr.status != "ok":
                print(rr.log)
            pts = {p.repo_name: p for p in s.query(models.BackupPoint).filter_by(job_id=job["id"]).all()}
            check("Un punto por sistema", len(pts) == len(ids))
            check("Cada punto enviado y verificado en el destino cifrado",
                  all(any(t.status == "ok" and t.verified for t in p.transfers) for p in pts.values()))
            keys = {name: s.get(models.ExternalSource, sid).folder_key for name, sid in ids.items()}

            def folder(name):
                p = pts[keys[name]]
                return backup_jobs.chain_dir(s.get(models.BackupJob, job["id"]), p.repo_name, p.chain_label)

            # MySQL: el volcado se restaura en una base NUEVA y queda igual
            f_my = folder("BD ventas (MySQL 8.4)")
            dump = next(f_my.glob("00_completo_*.sql.gz"))
            text = gzip.open(dump, "rt", encoding="utf-8").read()
            check("MySQL: sin la linea 'sandbox' de mariadb-dump (solo sirve al restaurar en MariaDB)", "sandbox mode" not in text)
            check("MySQL: sin CREATE DATABASE/USE (se restaura en cualquier base)", "CREATE DATABASE" not in text and "\nUSE " not in text)
            check("MySQL: incluye vista y procedimiento", "VIEW `vip`" in text and "PROCEDURE `contar`" in text)
            check("MySQL: RESTAURAR.txt y manifest.json en la carpeta", (f_my / "RESTAURAR.txt").exists() and (f_my / "manifest.json").exists())
            maria("ext_mysql", "CREATE DATABASE ventas_restaurada")
            run(["mariadb", "-h", "ext_mysql", "-uroot", f"-p{ROOTPW}", "--skip-ssl", "ventas_restaurada"], stdin=text)
            a = maria("ext_mysql", "CHECKSUM TABLE ventas.clientes, ventas_restaurada.clientes").split("\n")
            check(f"MySQL: restaurado en otra base, CHECKSUM identico ({len(a)} tablas)", a[0].split("\t")[1] == a[1].split("\t")[1])
            check("MySQL: tildes, comillas y binarios intactos",
                  maria("ext_mysql", "SELECT CONCAT(nombre, HEX(foto)) FROM clientes WHERE id = 1", "ventas_restaurada").strip() == "Ñandú Pérez00FF10")
            check("MySQL: el procedimiento funciona en la base restaurada",
                  maria("ext_mysql", "CALL contar()", "ventas_restaurada").strip() == "102")
            (ROOT / "para_mysql.sql").write_text(text, encoding="utf-8")

            # PostgreSQL
            f_pg = folder("BD inventario (PostgreSQL 18)")
            pgdump = next(f_pg.glob("00_completo_*.dump"))
            psql("CREATE DATABASE inventario_restaurada")
            env = dict(os.environ, PGPASSWORD=ROOTPW, PGSSLMODE="require")
            run(["pg_restore", "-h", "ext_pg", "-U", "postgres", "-d", "inventario_restaurada", "--no-owner", "--no-privileges", str(pgdump)], env=env)
            q = "SELECT count(*), sum((datos->>'n')::int) FROM equipos"
            check("PostgreSQL: restaurado en otra base con los mismos datos", psql(q, "inventario") == psql(q, "inventario_restaurada"))

            # WordPress
            f_wp = folder("Landing (WordPress)")
            names = sorted(p.name for p in f_wp.iterdir())
            check(f"WordPress: archivos + base + RESTAURAR + manifest ({len(names)})",
                  any(n.endswith("_archivos.tar.gz") for n in names) and any(n.endswith("_basedatos.sql.gz") for n in names))
            import tarfile
            with tarfile.open(next(f_wp.glob("*_archivos.tar.gz"))) as tar:
                members = tar.getnames()
            check("WordPress: incluye wp-config.php, tema, subidas y nucleo",
                  {"sitio/wp-config.php", "sitio/wp-content/themes/landing/style.css", "sitio/wp-content/uploads/2026/10/foto.jpg",
                   "sitio/wp-admin/index.php"} <= set(members))
            check("WordPress: sin la cache", not any("/cache/" in m for m in members))
            wptext = gzip.open(next(f_wp.glob("*_basedatos.sql.gz")), "rt", encoding="utf-8").read()
            check("WordPress: la base sale con los datos de wp-config.php (servidor del formulario)",
                  "landing.prueba" in wptext and "Landing Ñ" in wptext)
            maria("ext_maria", "CREATE DATABASE wp_restaurada")
            run(["mariadb", "-h", "ext_maria", "-uroot", f"-p{ROOTPW}", "--skip-ssl", "wp_restaurada"], stdin=wptext)
            check("WordPress: base restaurada en otra base", maria("ext_maria", "SELECT option_value FROM lp_options WHERE option_name='siteurl'",
                                                                  "wp_restaurada").strip() == "https://landing.prueba")

            # SQL Server
            if "BD facturas (SQL Server)" in ids:
                # Nombre nuevo en cada corrida: aqui no hay cliente de SQL Server para
                # borrar la anterior. Los datos se comparan con sqlcmd del servidor.
                mssql_target = f"Facturas_rest_{datetime.now():%H%M%S}"
                print("Base SQL Server restaurada:", mssql_target)
                bac = next(folder("BD facturas (SQL Server)").glob("*.bacpac"))
                r2 = subprocess.run([external_sources.SQLPACKAGE, "/Action:Import", f"/SourceFile:{bac}", "/TargetServerName:tcp:ext_mssql,1433",
                                     f"/TargetDatabaseName:{mssql_target}", "/TargetUser:sa", "/TargetPassword:Raiz-Prueba-1x",
                                     "/TargetTrustServerCertificate:True", "/Quiet:True"], capture_output=True, text=True, timeout=900,
                                    env=dict(os.environ, HOME=str(ROOT)))
                check(f"SQL Server: el .bacpac se importa en una base nueva ({(r2.stdout or r2.stderr)[-120:].strip()})", r2.returncode == 0)

            # ---------------- segunda noche: cambios en el sitio ----------------
            (site / "wp-content" / "uploads" / "2026" / "10" / "nueva.png").write_bytes(b"png" * 1000)
            ftp_upload(site / "wp-content" / "uploads" / "2026" / "10" / "nueva.png", "public_html/landing/wp-content/uploads/2026/10/nueva.png", True)
            maria("ext_mysql", "INSERT INTO clientes (nombre, total) VALUES ('nuevo', 1)", "ventas")
            run_id = backup_jobs.run_job(job["id"], "manual")
            s.expire_all()
            check("Segunda ejecucion OK", s.get(models.BackupJobRun, run_id).status == "ok")
            latest = s.query(models.BackupPoint).filter_by(job_id=job["id"], repo_name=keys["Landing (WordPress)"]) \
                .order_by(models.BackupPoint.id.desc()).first()
            with tarfile.open(next(backup_jobs.chain_dir(s.get(models.BackupJob, job["id"]), latest.repo_name, latest.chain_label)
                                   .glob("*_archivos.tar.gz"))) as tar:
                check("Segunda noche: el archivo nuevo del sitio esta en el respaldo", "sitio/wp-content/uploads/2026/10/nueva.png" in tar.getnames())

            # ---------------- restaurar: verificar, descargar, danado ----------------
            point = pts[keys["BD ventas (MySQL 8.4)"]]
            for mode in ("verificar", "descargar"):
                r = c.post("/api/restores", json={"mode": mode, "point_id": point.id, "source": str(dest["id"])})
                for _ in range(60):
                    st = c.get(f"/api/restores/{r.json()['id']}").json()
                    if st["status"] != "en_curso":
                        break
                    time.sleep(1)
                check(f"Restaurar ({mode}) desde el destino cifrado: {st['status']}", st["status"] == "ok" and "SHA-256 correcto" in st["log"])
            check("Descargar deja el volcado y RESTAURAR.txt", {o["name"] for o in st["outputs"]} >= {dump.name, "RESTAURAR.txt"})
            r = c.post("/api/restores", json={"mode": "subir", "point_id": point.id, "source": "local", "push_url": "https://github.com/x/y.git"})
            check("Un respaldo externo no se sube a Git", r.status_code == 422)
            r = c.post("/api/restores", json={"mode": "aplicar", "point_id": point.id, "source": "local", "confirmacion": "RESTAURAR TODO"})
            check("Un respaldo externo nunca se 'aplica' sobre el sistema de origen", r.status_code == 422)
            with open(dump, "r+b") as fh:
                fh.seek(40)
                fh.write(b"XXXX")
            r = c.post("/api/restores", json={"mode": "verificar", "point_id": point.id, "source": "local"})
            for _ in range(60):
                st = c.get(f"/api/restores/{r.json()['id']}").json()
                if st["status"] != "en_curso":
                    break
                time.sleep(1)
            check("Copia danada en el servidor: la verificacion la detecta", st["status"] == "error" and "DANADO" in st["log"])

            # ---------------- restaurar en una base NUEVA, con avance y log ----------------
            def restore_new(point_id, source, target):
                r = c.post("/api/restores", json={"mode": "nueva_base", "point_id": point_id, "source": source, "target": target})
                if r.status_code != 202:
                    print("restaurar rechazado:", r.status_code, r.text[:300])
                    return r, {"status": "rechazado", "progress": 0, "steps": [], "log": r.text, "id": 0}, set()
                seen = set()
                for _ in range(300):
                    st = c.get(f"/api/restores/{r.json()['id']}").json()
                    seen.add(st["progress"])
                    if st["status"] != "en_curso":
                        break
                    time.sleep(0.5)
                return r, st, seen

            s.expire_all()
            pts = {p.repo_name: p for p in s.query(models.BackupPoint).filter_by(job_id=job["id"]).order_by(models.BackupPoint.id).all()}
            src_info = c.get(f"/api/backup-points/{pts[keys['BD inventario (PostgreSQL 18)']].id}/sources").json()["point"]
            check("El punto informa el tipo y sugiere un nombre de base nuevo",
                  src_info["ext_kind"] == "postgres" and src_info["prefill"]["database"].startswith("inventario_restaurada_")
                  and src_info["prefill"]["host"] == "ext_pg" and "password" not in src_info["prefill"])
            r = c.post("/api/restores", json={"mode": "nueva_base", "point_id": pts[keys["BD ventas (MySQL 8.4)"]].id, "source": str(dest["id"]),
                                              "target": {"host": "ext_mysql", "user": "root", "password": ROOTPW, "database": "ventas", "tls": "cifrar"}})
            check("Restaurar sobre la base de origen: rechazado antes de empezar", r.status_code == 422 and "base de origen" in r.json()["detail"])
            r = c.post("/api/restores", json={"mode": "nueva_base", "point_id": pts[keys["BD ventas (MySQL 8.4)"]].id, "source": "local",
                                              "target": {"host": "ext_mysql", "user": "root", "password": ROOTPW, "database": "1-mala"}})
            check("Nombre de base no valido: rechazado", r.status_code == 422)

            maria("ext_mysql", "DROP DATABASE IF EXISTS ventas_nueva")
            r, st, seen = restore_new(pts[keys["BD ventas (MySQL 8.4)"]].id, str(dest["id"]),
                                      {"host": "ext_mysql", "user": "root", "password": ROOTPW, "database": "ventas_nueva", "tls": "cifrar"})
            check(f"MySQL en base nueva desde el destino cifrado: {st['status']} {st['progress']}%", st["status"] == "ok" and st["progress"] == 100)
            check("Pasos de la restauracion desde un destino", [x["status"] for x in st["steps"]] == ["ok", "ok", "ok"]
                  and [x["name"] for x in st["steps"]] == ["Descargar del destino", "Verificar integridad", "Cargar en la base nueva"])
            # El cliente de pruebas corre la tarea antes de responder: el avance
            # intermedio se comprueba en la clase que lo calcula y lo guarda.
            from app.services import restore_service
            fake = models.RestoreRun(source_label="x", chain_path="a/b/c", repo_name="_externo_x", seq=0, mode="nueva_base")
            s.add(fake)
            s.commit()
            pr = restore_service.Progress(s, fake, [], [("Descargar del destino", 30), ("Cargar en la base nueva", 70)])
            pr.interval = 0
            pr.start("Descargar del destino")
            pr.update(0.5, "15 de 30 MB")
            a1 = (fake.progress, fake.step)
            pr.sub("Cargar en la base nueva")(0.5, "objeto 5 de 10")
            a2 = fake.progress
            s.refresh(fake)
            check(f"Avance ponderado y guardado en vivo ({a1[0]}% -> {a2}%, paso '{a1[1]}')",
                  a1 == (15, "Descargar del destino - 15 de 30 MB") and a2 == 65 and fake.progress == 65
                  and json.loads(fake.steps_json)[0]["status"] == "ok")
            s.delete(fake)
            s.commit()
            check("MySQL: base nueva con los mismos datos que el origen",
                  maria("ext_mysql", "SELECT COUNT(*) FROM clientes", "ventas_nueva") == maria("ext_mysql", "SELECT COUNT(*) FROM clientes", "ventas"))
            check("Las credenciales del destino no quedan en la base del sidecar ni en el log",
                  ROOTPW not in (s.get(models.RestoreRun, st["id"]).log or "") and ROOTPW not in json.dumps(st))
            logtxt = c.get(f"/api/restores/{st['id']}/log")
            check("Log descargable con pasos y detalle", logtxt.status_code == 200 and "attachment" in logtxt.headers.get("content-disposition", "")
                  and "[ok] Cargar en la base nueva" in logtxt.text)
            r, st, _ = restore_new(pts[keys["BD ventas (MySQL 8.4)"]].id, "local",
                                   {"host": "ext_mysql", "user": "root", "password": ROOTPW, "database": "ventas_nueva", "tls": "cifrar"})
            check("Base destino con datos: se detiene sin tocarla", st["status"] == "error" and "ya existe y tiene" in st["log"])
            check("Mapa del error: paso, pasos completados, causa y sugerencia",
                  "=== MAPA DEL ERROR ===" in st["log"] and "Fallo en el paso 2 de 2: Cargar en la base nueva" in st["log"]
                  and "Sugerencia" in st["log"] and "Nada se modifico en el sistema de origen" in st["log"]
                  and [x["status"] for x in st["steps"]] == ["ok", "error"])

            psql("DROP DATABASE IF EXISTS inventario_nueva")
            r, st, _ = restore_new(pts[keys["BD inventario (PostgreSQL 18)"]].id, "local",
                                   {"host": "ext_pg", "user": "postgres", "password": ROOTPW, "database": "inventario_nueva", "sslmode": "require"})
            q = "SELECT count(*), sum((datos->>'n')::int) FROM equipos"
            check(f"PostgreSQL en base nueva: {st['status']}", st["status"] == "ok" and psql(q, "inventario") == psql(q, "inventario_nueva"))

            if "BD facturas (SQL Server)" in ids:
                name = f"Facturas_nueva_{datetime.now():%H%M%S}"
                r, st, _ = restore_new(pts[keys["BD facturas (SQL Server)"]].id, "local",
                                       {"host": "ext_mssql", "user": "sa", "password": "Raiz-Prueba-1x", "database": name, "tls": "confiar"})
                check(f"SQL Server en base nueva ({name}): {st['status']}", st["status"] == "ok" and "Importado" in st["log"])
                if st["status"] != "ok":
                    print(st["log"][-1500:])

            maria("ext_maria", "DROP DATABASE IF EXISTS wp_nueva; GRANT ALL ON wp_nueva.* TO 'wpuser'@'%'")
            wp_target = {"protocol": "ftps", "host": "ext_ftp", "user": "ftpu", "password": "clave-ftp", "verify_cert": "no",
                         "wp_path": f"public_html/landing-restaurada-{datetime.now():%H%M%S}", "db_host": "ext_maria", "db_user": "root",
                         "db_password": ROOTPW, "database": "wp_nueva", "db_tls": "cifrar", "config_db_host": "localhost",
                         "new_url": "https://landing2.prueba"}
            r, st, _ = restore_new(pts[keys["Landing (WordPress)"]].id, "local", wp_target)
            check(f"WordPress en base y carpeta nuevas: {st['status']} {st['progress']}%", st["status"] == "ok" and st["progress"] == 100
                  and [x["name"] for x in st["steps"]] == ["Verificar integridad", "Cargar en la base nueva", "Subir archivos del sitio"])
            if st["status"] != "ok":
                print(st["log"][-1500:])
            check("WordPress: siteurl cambiado en la base nueva",
                  maria("ext_maria", "SELECT option_value FROM lp_options WHERE option_name='siteurl'", "wp_nueva").strip() == "https://landing2.prueba")
            pw = run(["rclone", "obscure", "clave-ftp"], env=dict(os.environ, HOME=str(ROOT))).strip()
            cfg = run(["rclone", "cat", f":ftp:{wp_target['wp_path']}/wp-config.php", "--ftp-host", "ext_ftp", "--ftp-user", "ftpu",
                       "--ftp-pass", pw, "--ftp-explicit-tls", "--ftp-no-check-certificate"], env=dict(os.environ, HOME=str(ROOT)))
            check("WordPress: wp-config.php subido con la base nueva", "'wp_nueva'" in cfg and "'localhost'" in cfg and "$table_prefix = 'lp_'" in cfg)
            r, st, _ = restore_new(pts[keys["Landing (WordPress)"]].id, "local", {**wp_target, "database": "wp_otra"})
            check("WordPress: carpeta destino con archivos -> se detiene sin tocarla", st["status"] == "error" and "ya tiene archivos" in st["log"])
            check("Pagina Restaurar ofrece 'base nueva' y la barra de avance", all(x in c.get("/backups/restaurar").text
                                                                                for x in ("rmN", "progress-bar", "Descargar log")))

            # ---------------- renombrar no corta las cadenas; pagina ----------------
            r = c.put(f"/api/external-sources/{mysql_id}", json={"name": "Ventas Azure", **defs["BD ventas (MySQL 8.4)"]})
            check("Renombrar conserva la carpeta (no corta las cadenas)", r.json()["folder_key"] == keys["BD ventas (MySQL 8.4)"])
            check("Pagina /backups/sistemas responde 200", c.get("/backups/sistemas").status_code == 200)
            check("Pagina de trabajos lista los sistemas", "Ventas Azure" in c.get("/backups/trabajos").text)
            s.close()
    finally:
        for host, sql in (("ext_mysql", "DROP DATABASE IF EXISTS ventas_restaurada"), ("ext_maria", "DROP DATABASE IF EXISTS wp_restaurada")):
            try:
                maria(host, sql)
            except RuntimeError:
                pass

    fails = [n for ok, n in RESULTS if not ok]
    for ok, n in RESULTS:
        print(("OK    " if ok else "FALLA ") + n)
    print(f"{len(RESULTS)} pruebas, {len(fails)} fallas")
    print("Volcado para probar con el cliente de MySQL:", ROOT / "para_mysql.sql")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
