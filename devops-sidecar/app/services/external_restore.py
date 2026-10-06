"""Restaurar el respaldo de un sistema externo en una base NUEVA (o vacia):
MySQL/MariaDB, PostgreSQL, Azure SQL / SQL Server y sitios WordPress (base
nueva + archivos a una carpeta nueva del hosting).

Nunca se escribe sobre datos existentes: antes de cargar se comprueba que
la base destino no exista o este vacia (y la carpeta del sitio, vacia); si
tiene algo, se detiene sin tocar nada. Las credenciales del destino llegan
con la orden y se usan solo en memoria (no se guardan).

Cada funcion informa el avance con progress(fraccion, detalle) y deja en
el log lo necesario para entender un error: el comando que fallo, sus
ultimas lineas (ej. "ERROR 1064 at line 523") y una sugerencia.
"""
import gzip
import json
import re
import shutil
import subprocess
import tarfile
import zipfile
from pathlib import Path

from . import rclone_service
from .external_sources import (DUMP_TIMEOUT, SQLPACKAGE, SourceError, _connect_hint, _files_config, _mysql_cnf,
                               _mysql_query, _pg_env, _private_dir, _tail, _wp_config_values)

_DB_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,62}$")
_URL = re.compile(r"^https?://[A-Za-z0-9.-]+(:\d{1,5})?(/[A-Za-z0-9._~/-]*)?$")
_PREFIX = re.compile(r"^[A-Za-z0-9_]{1,30}$")

# Campos del destino de la restauracion, por tipo (la pantalla los dibuja).
_DB = [
    {"key": "host", "label": "Servidor destino", "type": "text", "required": True},
    {"key": "port", "label": "Puerto", "type": "text"},
    {"key": "user", "label": "Usuario con permiso para crear la base", "type": "text", "required": True},
    {"key": "password", "label": "Contrasena", "type": "password", "required": True},
    {"key": "database", "label": "Base NUEVA (o vacia)", "type": "text", "required": True,
     "help": "Letras, numeros y _; empieza con letra. Si existe y tiene tablas, la restauracion se detiene sin tocarla."},
]
RESTORE_FIELDS = {
    "mysql": _DB + [{"key": "tls", "label": "Conexion", "type": "select", "default": "verificar", "options": [
        ["verificar", "Cifrado y verificando el certificado"], ["cifrar", "Cifrado sin verificar"], ["no", "Sin cifrar"]]}],
    "postgres": _DB + [{"key": "sslmode", "label": "Conexion", "type": "select", "default": "verify-full", "options": [
        ["verify-full", "Cifrado y verificando el certificado"], ["require", "Cifrado sin verificar"], ["disable", "Sin cifrar"]]}],
    "mssql": _DB + [{"key": "tls", "label": "Conexion", "type": "select", "default": "verificar", "options": [
        ["verificar", "Cifrado y verificando el certificado"], ["confiar", "Cifrado confiando en el certificado"]]}],
    "wordpress": [
        {"key": "protocol", "label": "Protocolo de archivos", "type": "select", "default": "ftps", "options": [
            ["ftps", "FTPS explicito"], ["ftps_implicit", "FTPS implicito"], ["sftp", "SFTP"], ["ftp", "FTP sin cifrar"]]},
        {"key": "host", "label": "Servidor del hosting", "type": "text", "required": True},
        {"key": "port", "label": "Puerto (vacio = el del protocolo)", "type": "text"},
        {"key": "user", "label": "Usuario FTP/SFTP", "type": "text", "required": True},
        {"key": "password", "label": "Contrasena FTP/SFTP", "type": "password", "required": True},
        {"key": "verify_cert", "label": "Certificado", "type": "select", "default": "si", "options": [["si", "Verificar"], ["no", "No verificar"]]},
        {"key": "wp_path", "label": "Carpeta NUEVA (o vacia) del sitio", "type": "text", "required": True,
         "help": "Relativa a la cuenta FTP, ej. public_html/landing-restaurada. Si tiene archivos, se detiene sin tocarla."},
        {"key": "db_host", "label": "Servidor MySQL (vacio = el del hosting)", "type": "text"},
        {"key": "db_port", "label": "Puerto MySQL", "type": "text", "default": "3306"},
        {"key": "db_user", "label": "Usuario MySQL (con permiso en la base nueva)", "type": "text", "required": True},
        {"key": "db_password", "label": "Contrasena MySQL", "type": "password", "required": True},
        {"key": "database", "label": "Base MySQL NUEVA (o vacia)", "type": "text", "required": True},
        {"key": "db_tls", "label": "Conexion MySQL", "type": "select", "default": "cifrar", "options": [
            ["verificar", "Cifrado y verificando"], ["cifrar", "Cifrado sin verificar"], ["no", "Sin cifrar"]]},
        {"key": "config_db_host", "label": "DB_HOST que usara WordPress", "type": "text", "default": "localhost",
         "help": "Como ve WordPress la base desde el hosting (en cPanel casi siempre localhost). Se escribe en wp-config.php."},
        {"key": "new_url", "label": "Direccion nueva del sitio (opcional)", "type": "text",
         "help": "ej. https://landing2.empresa.com. Cambia siteurl y home; el resto de enlaces: wp search-replace."},
    ],
}


def validate_target(kind: str, t: dict) -> list[str]:
    if kind not in RESTORE_FIELDS:
        return ["Este respaldo no se restaura en una base."]
    problems = [f"Falta: {f['label']}." for f in RESTORE_FIELDS[kind] if f.get("required") and not str(t.get(f["key"]) or "").strip()]
    if t.get("database") and not _DB_NAME.match(t["database"]):
        problems.append("Nombre de base no valido: letras, numeros y _, empezando con letra.")
    for k in ("host", "db_host"):
        if t.get(k) and not re.match(r"^[A-Za-z0-9._-]+$", t[k]):
            problems.append(f"Servidor no valido: {t[k]}.")
    if t.get("new_url") and not _URL.match(t["new_url"]):
        problems.append("Direccion nueva no valida (ej. https://landing2.empresa.com).")
    p = t.get("wp_path", "")
    if kind == "wordpress" and (p.startswith("/") or ".." in p.split("/") or p.strip("/") in ("", ".")):
        problems.append("La carpeta del sitio debe ser una carpeta nueva relativa a la cuenta FTP (no la raiz).")
    return problems


def kind_of_files(names: list[str]) -> str | None:
    """Tipo de sistema segun los archivos del respaldo (sirve tambien al
    explorar un destino sin la base del sidecar)."""
    if any(n.endswith("_archivos.tar.gz") for n in names):
        return "wordpress"
    if any(n.endswith(".sql.gz") for n in names):
        return "mysql"
    if any(n.endswith(".dump") for n in names):
        return "postgres"
    if any(n.endswith(".bacpac") for n in names):
        return "mssql"
    return None


# ---------------------------------- MySQL --------------------------------------
def restore_mysql(dump: Path, t: dict, log, progress) -> list[str]:
    """Carga un .sql.gz en una base nueva o vacia. Devuelve avisos."""
    name = t["database"]
    tmp = _private_dir()
    try:
        cnf = _mysql_cnf(tmp, t["host"], t.get("port"), t["user"], t["password"], t.get("tls", "verificar"))
        progress(0, "Comprobando la base destino")
        # El nombre ya paso por _DB_NAME (solo letras, numeros y _): el
        # cliente mariadb no tiene parametros enlazados.
        exists = _mysql_query(cnf, None, f"SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = '{name}'")[0][0] != "0"
        if exists:
            tables = int(_mysql_query(cnf, None, f"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '{name}'")[0][0])
            if tables:
                raise SourceError(f"La base '{name}' ya existe y tiene {tables} tabla(s): no se toca. Elija un nombre nuevo o vacie esa base.")
            log(f"  La base '{name}' existe y esta vacia: se carga ahi.")
        else:
            _mysql_query(cnf, None, f"CREATE DATABASE `{name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
            log(f"  Base '{name}' creada en {t['host']}.")
        size = dump.stat().st_size or 1
        err_file = tmp / "errores.txt"
        created = 0
        with open(err_file, "wb") as err, open(dump, "rb") as raw:
            proc = subprocess.Popen(["mariadb", f"--defaults-extra-file={cnf}", "--connect-timeout=20", "--binary-mode", name],
                                    stdin=subprocess.PIPE, stderr=err, stdout=subprocess.DEVNULL)
            try:
                with gzip.GzipFile(fileobj=raw) as gz:
                    for block in iter(lambda: gz.read(1024 * 1024), b""):
                        created += block.count(b"CREATE TABLE `")
                        proc.stdin.write(block)
                        progress(raw.tell() / size, f"Cargando datos ({raw.tell() / 1048576:.1f} de {size / 1048576:.1f} MB comprimidos)")
                proc.stdin.close()
            except BrokenPipeError:
                pass  # el cliente se detuvo por un error: se informa abajo
            proc.wait(timeout=DUMP_TIMEOUT)
        stderr = err_file.read_text(errors="replace")
        if proc.returncode != 0:
            raise SourceError("El cliente MySQL se detuvo: " + _tail(stderr, 4) + _connect_hint(stderr) +
                              " (la linea indicada es la del volcado descomprimido: gunzip -c archivo | sed -n 'Np').")
        progress(1, "Comprobando el resultado")
        tables = int(_mysql_query(cnf, None, f"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '{name}' AND table_type = 'BASE TABLE'")[0][0])
        log(f"  Cargado: {tables} tabla(s) en '{name}' (el volcado define {created}).")
        if tables < created:
            raise SourceError(f"Faltan tablas: el volcado define {created} y la base tiene {tables}.")
        return [_tail(stderr)] if stderr.strip() else []
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# -------------------------------- PostgreSQL -----------------------------------
def _psql(t: dict, tmp: Path, database: str, sql: str, variables: dict | None = None) -> str:
    env = _pg_env({**t, "database": database}, tmp)
    args = ["psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1"]
    for k, v in (variables or {}).items():
        args += ["-v", f"{k}={v}"]
    # Con -c psql no interpola :'var'; por stdin si.
    r = subprocess.run(args, input=sql, capture_output=True, text=True, timeout=120, env=env)
    if r.returncode != 0:
        err = _tail(r.stderr)
        raise SourceError(err + _connect_hint(err))
    return r.stdout.strip()


def restore_postgres(dump: Path, t: dict, log, progress) -> list[str]:
    name = t["database"]
    tmp = _private_dir()
    try:
        progress(0, "Comprobando la base destino")
        if _psql(t, tmp, "postgres", "SELECT count(*) FROM pg_database WHERE datname = :'n';", {"n": name}) != "0":
            tables = int(_psql(t, tmp, name, "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');"))
            if tables:
                raise SourceError(f"La base '{name}' ya existe y tiene {tables} tabla(s): no se toca. Elija un nombre nuevo.")
            log(f"  La base '{name}' existe y esta vacia: se carga ahi.")
        else:
            _psql(t, tmp, "postgres", 'CREATE DATABASE :"n";', {"n": name})
            log(f"  Base '{name}' creada en {t['host']}.")
        listing = subprocess.run(["pg_restore", "--list", str(dump)], capture_output=True, text=True, timeout=600)
        total = max(1, sum(1 for ln in listing.stdout.splitlines() if ln and not ln.startswith(";")))
        env = _pg_env({**t, "database": name}, tmp)
        proc = subprocess.Popen(["pg_restore", "--verbose", "--no-owner", "--no-privileges", "--no-password", "-d", name, str(dump)],
                                stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True, env=env)
        done, errors = 0, []
        for line in proc.stderr:
            line = line.rstrip()
            if re.match(r"pg_restore: (creating|processing data|processing item|executing)", line):
                done += 1
                progress(done / total, f"Objeto {min(done, total)} de {total}: {line.split(': ', 1)[-1][:80]}")
            elif "error:" in line:
                errors.append(line)
                log("  " + line[:300])
        proc.wait(timeout=DUMP_TIMEOUT)
        progress(1, "Comprobando el resultado")
        tables = _psql(t, tmp, name, "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');")
        log(f"  Cargado: {tables} tabla(s) en '{name}'.")
        if proc.returncode != 0 and not errors:
            raise SourceError(f"pg_restore termino con codigo {proc.returncode}.")
        if errors:
            # pg_restore sigue tras un error (ej. una extension que el
            # servidor destino no tiene): se informa como aviso, con cada linea.
            return [f"pg_restore reporto {len(errors)} error(es); los datos restantes se cargaron. Ver las lineas 'error:' del log "
                    "(lo habitual: extensiones o roles que no existen en el servidor destino)."]
        return []
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------- Azure SQL -------------------------------------
def restore_mssql(bacpac: Path, t: dict, log, progress) -> list[str]:
    with zipfile.ZipFile(bacpac) as z:
        total = max(1, len({n.split("/")[1] for n in z.namelist() if n.startswith("Data/") and n.count("/") >= 2}))
    tmp = _private_dir()
    try:
        args = [SQLPACKAGE, "/Action:Import", f"/SourceFile:{bacpac}", f"/TargetServerName:tcp:{t['host']},{t.get('port') or '1433'}",
                f"/TargetDatabaseName:{t['database']}", f"/TargetUser:{t['user']}", f"/TargetPassword:{t['password']}",
                "/TargetEncryptConnection:True", f"/TargetTrustServerCertificate:{'True' if t.get('tls') == 'confiar' else 'False'}",
                "/TargetTimeout:30"]
        progress(0, "Importando el esquema")
        try:
            proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                    env={"PATH": "/usr/bin:/bin", "HOME": str(tmp), "DOTNET_CLI_TELEMETRY_OPTOUT": "1"})
        except FileNotFoundError:
            raise SourceError("sqlpackage no esta instalado en el contenedor (solo existe para x64).")
        done, tail = 0, []
        for line in proc.stdout:
            line = line.rstrip().replace(t["password"], "***")
            tail = (tail + [line])[-6:]
            if "Processing Table" in line or "Importing data" in line.lower():
                done += 1
                progress(min(done / total, 0.99), line[:100])
        proc.wait(timeout=DUMP_TIMEOUT)
        if proc.returncode != 0:
            err = " | ".join(x for x in tail if x.strip())[:600]
            if "contains one or more user objects" in err or "already exists" in err:
                raise SourceError(f"La base '{t['database']}' ya existe con objetos: no se toca. Elija un nombre nuevo.")
            raise SourceError("sqlpackage Import fallo: " + err + _connect_hint(err))
        log(f"  Importado en '{t['database']}' ({total} tabla(s) con datos).")
        return []
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# -------------------------------- WordPress ------------------------------------
def _set_wp_config(path: Path, values: dict) -> None:
    text = path.read_text(encoding="utf-8", errors="replace")
    for key, val in values.items():
        esc = val.replace("\\", "\\\\").replace("'", "\\'")
        text, n = re.subn(r"(define\s*\(\s*['\"]" + key + r"['\"]\s*,\s*)(['\"]).*?(?<!\\)\2(\s*\))",
                          lambda m: f"{m.group(1)}'{esc}'{m.group(3)}", text, count=1, flags=re.S)
        if not n:
            raise SourceError(f"wp-config.php no tiene define('{key}', ...): ajustelo a mano.")
    path.write_text(text, encoding="utf-8")


def restore_wordpress(folder: Path, work: Path, t: dict, log, progress_db, progress_files) -> list[str]:
    files_tar = next(folder.glob("*_archivos.tar.gz"), None)
    dump = next(folder.glob("*_basedatos.sql.gz"), None)
    if not files_tar or not dump:
        raise SourceError("El respaldo no trae los archivos y la base del sitio.")
    db_target = {"host": t.get("db_host") or t["host"], "port": t.get("db_port") or "3306", "user": t["db_user"],
                 "password": t["db_password"], "database": t["database"], "tls": t.get("db_tls", "cifrar")}
    files_conn = _files_config(t)
    # 1) la carpeta destino debe estar vacia (antes de cargar nada)
    with rclone_service.RcloneSession(files_conn) as s:
        r = s.run(["lsf", "--max-depth", "1", s.path()], timeout=120)
        if r.returncode == 0 and r.stdout.strip():
            raise SourceError(f"La carpeta '{files_conn.remote_path}' ya tiene archivos: no se toca. Elija una carpeta nueva.")
        if r.returncode != 0 and "not found" not in (r.stderr or "").lower() and "directory not found" not in (r.stderr or "").lower():
            err = rclone_service._err(r)
            raise SourceError("No se pudo entrar al hosting: " + err + _connect_hint(err))
    # 2) base
    warnings = restore_mysql(dump, db_target, log, progress_db)
    # 3) archivos: extraer, ajustar wp-config.php y subir
    site = work / "sitio_restaurado"
    with tarfile.open(files_tar, "r:gz") as tar:
        tar.extractall(work, filter="data")  # sin rutas absolutas, '..' ni enlaces fuera
    shutil.move(str(work / "sitio"), str(site))
    wp = _wp_config_values((site / "wp-config.php").read_text(encoding="utf-8", errors="replace"))
    _set_wp_config(site / "wp-config.php", {"DB_NAME": t["database"], "DB_USER": t["db_user"], "DB_PASSWORD": t["db_password"],
                                           "DB_HOST": t.get("config_db_host") or "localhost"})
    log("  wp-config.php ajustado con la base nueva (DB_NAME, DB_USER, DB_PASSWORD, DB_HOST).")
    if t.get("new_url"):
        prefix = wp.get("prefix", "wp_")
        if not _PREFIX.match(prefix):
            raise SourceError(f"Prefijo de tablas no valido en wp-config.php: {prefix}")
        tmp = _private_dir()
        try:
            cnf = _mysql_cnf(tmp, db_target["host"], db_target["port"], db_target["user"], db_target["password"], db_target["tls"])
            # URL y prefijo validados por expresion regular (sin comillas posibles).
            _mysql_query(cnf, t["database"], f"UPDATE `{prefix}options` SET option_value = '{t['new_url']}' WHERE option_name IN ('siteurl', 'home')")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        log(f"  siteurl y home cambiados a {t['new_url']} (el resto de enlaces: wp search-replace).")
    total = sum(p.stat().st_size for p in site.rglob("*") if p.is_file()) or 1
    with rclone_service.RcloneSession(files_conn) as s:
        proc = subprocess.Popen([rclone_service.RCLONE, "copy", str(site), s.path(), "--use-json-log", "-v", "--stats", "2s",
                                 "--stats-log-level", "NOTICE", "--retries", "3", "--transfers", "4"],
                                stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True, env=s.env)
        last = []
        for line in proc.stderr:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            st = ev.get("stats")
            if st:
                progress_files(min(st.get("bytes", 0) / total, 0.99), f"Subiendo archivos ({st.get('bytes', 0) / 1048576:.1f} de {total / 1048576:.1f} MB)")
            if ev.get("level") in ("error", "critical"):
                last.append(ev.get("msg", "")[:200])
        proc.wait(timeout=DUMP_TIMEOUT)
    if proc.returncode != 0:
        raise SourceError("No se pudieron subir los archivos del sitio: " + " | ".join(last[-3:]))
    progress_files(1, "Archivos subidos")
    log(f"  Archivos del sitio subidos a '{files_conn.remote_path}' ({total / 1048576:.1f} MB).")
    return warnings
