"""Sistemas externos que se respaldan con los trabajos programados: bases
de datos en la nube (Azure Database for MySQL/MariaDB y PostgreSQL, Azure
SQL / SQL Server) y sitios WordPress en un hosting (cPanel por FTPS/SFTP).

Solo se LEE del sistema externo: se recomienda un usuario de solo lectura
y "Probar conexion" avisa si el usuario puede escribir. Nunca se restaura
encima del sistema de origen desde aqui: los respaldos se verifican y se
descargan (cada uno trae RESTAURAR.txt con los comandos para levantarlo en
otra base u otro hosting).

Cada respaldo es una carpeta (un "punto" completo) con archivos
00_completo_*: el volcado de la base, en WordPress tambien los archivos
del sitio, manifest.json con el SHA-256 de cada archivo y RESTAURAR.txt.

Las contrasenas viven cifradas en ExternalSource.config_enc
(crypto_service) y llegan a cada herramienta sin pasar por la linea de
comandos cuando la herramienta lo permite: archivo de opciones 0600 para
mariadb-dump, PGPASSWORD para pg_dump. sqlpackage solo las acepta como
argumento (visible solo dentro del contenedor).
"""
import gzip
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

from ..config import settings
from . import crypto_service, rclone_service

DUMP_TIMEOUT = 6 * 3600
TEST_TIMEOUT = 120
SYSTEM_CA = "/etc/ssl/certs/ca-certificates.crt"
SQLPACKAGE = os.environ.get("SQLPACKAGE_BIN", "/opt/sqlpackage/sqlpackage")

_TLS_MYSQL = [["verificar", "Cifrado y verificando el certificado (Azure, recomendado)"],
              ["cifrar", "Cifrado sin verificar el certificado (certificado propio del hosting)"],
              ["no", "Sin cifrar (solo en una red privada)"]]
_DB_FIELDS = [
    {"key": "host", "label": "Servidor", "type": "text", "required": True},
    {"key": "port", "label": "Puerto", "type": "text"},
    {"key": "database", "label": "Base de datos", "type": "text", "required": True},
    {"key": "user", "label": "Usuario (de solo lectura)", "type": "text", "required": True},
    {"key": "password", "label": "Contrasena", "type": "password", "secret": True, "required": True},
]

KINDS = {
    "mysql": {
        "label": "MySQL / MariaDB (Azure Database for MySQL, servidor propio)",
        "default_port": "3306",
        "help": ("Azure: servidor.mysql.database.azure.com. En el portal (Redes del servidor) agregue la IP publica de salida "
                 "de la empresa. Usuario de solo lectura: CREATE USER 'respaldo'@'%' IDENTIFIED BY '...'; "
                 "GRANT SELECT, SHOW VIEW, TRIGGER, EVENT ON base.* TO 'respaldo'@'%'; en MySQL 8 agregue "
                 "GRANT SHOW_ROUTINE ON *.* TO 'respaldo'@'%' para los procedimientos. La copia es consistente "
                 "(--single-transaction) sin detener la aplicacion."),
        "fields": _DB_FIELDS + [
            {"key": "tls", "label": "Conexion", "type": "select", "options": _TLS_MYSQL, "default": "verificar"},
            {"key": "routines", "label": "Procedimientos y funciones", "type": "select",
             "options": [["si", "Incluir"], ["no", "No incluir (el usuario no tiene permiso para leerlos)"]], "default": "si"},
        ],
    },
    "postgres": {
        "label": "PostgreSQL (Azure Database for PostgreSQL, servidor propio)",
        "default_port": "5432",
        "help": ("Azure: servidor.postgres.database.azure.com y la IP de la empresa en Redes. Usuario de solo lectura: "
                 "CREATE ROLE respaldo LOGIN PASSWORD '...'; GRANT pg_read_all_data TO respaldo; (PostgreSQL 14+). "
                 "Formato personalizado de pg_dump: se restaura con pg_restore, completo o por tablas."),
        "fields": _DB_FIELDS + [
            {"key": "sslmode", "label": "Conexion", "type": "select", "options": [
                ["verify-full", "Cifrado y verificando el certificado (Azure, recomendado)"],
                ["require", "Cifrado sin verificar el certificado"],
                ["disable", "Sin cifrar (solo en una red privada)"]], "default": "verify-full"},
        ],
    },
    "mssql": {
        "label": "Azure SQL / SQL Server (exportacion .bacpac)",
        "default_port": "1433",
        "help": ("Azure: servidor.database.windows.net y la IP de la empresa en 'Redes' del servidor SQL. Usuario dentro de la "
                 "base: CREATE USER respaldo WITH PASSWORD = '...'; ALTER ROLE db_datareader ADD MEMBER respaldo; "
                 "GRANT VIEW DEFINITION, VIEW DATABASE STATE TO respaldo;. La exportacion .bacpac NO es una foto en un "
                 "instante: si la base recibe escrituras mientras se exporta, Microsoft recomienda exportar una copia "
                 "(CREATE DATABASE copia AS COPY OF base)."),
        "fields": _DB_FIELDS + [
            {"key": "tls", "label": "Conexion", "type": "select", "options": [
                ["verificar", "Cifrado y verificando el certificado (Azure, recomendado)"],
                ["confiar", "Cifrado confiando en el certificado del servidor (SQL Server propio)"]], "default": "verificar"},
        ],
    },
    "wordpress": {
        "label": "Sitio WordPress en un hosting (cPanel u otro, por FTPS/SFTP)",
        "help": ("Archivos: la cuenta FTP del hosting (cPanel > Cuentas FTP) por FTPS. Base: cPanel > MySQL remoto, agregue la "
                 "IP publica de la empresa; el servidor suele ser el mismo del hosting. Si deja la base, el usuario y la "
                 "contrasena vacios se leen de wp-config.php. El respaldo incluye wp-config.php (con la clave de la base): "
                 "envielo a un destino con cifrado."),
        "fields": [
            {"key": "protocol", "label": "Protocolo de archivos", "type": "select", "options": [
                ["ftps", "FTPS explicito (FTP con TLS, recomendado en cPanel)"], ["ftps_implicit", "FTPS implicito (puerto 990)"],
                ["sftp", "SFTP (cuenta con acceso SSH)"], ["ftp", "FTP sin cifrar (no recomendado)"]], "default": "ftps"},
            {"key": "host", "label": "Servidor del hosting", "type": "text", "required": True},
            {"key": "port", "label": "Puerto (vacio = el del protocolo)", "type": "text"},
            {"key": "user", "label": "Usuario FTP/SFTP", "type": "text", "required": True},
            {"key": "password", "label": "Contrasena FTP/SFTP", "type": "password", "secret": True, "required": True},
            {"key": "wp_path", "label": "Carpeta del sitio", "type": "text", "default": "public_html",
             "help": "Donde esta wp-config.php, relativa a la cuenta FTP: public_html, public_html/landing, o . si la cuenta ya entra ahi."},
            {"key": "verify_cert", "label": "Certificado del servidor", "type": "select", "options": [
                ["si", "Verificar (recomendado)"], ["no", "No verificar (certificado propio o vencido del hosting)"]], "default": "si"},
            {"key": "known_hosts", "label": "Huella del servidor SFTP (known_hosts, recomendado con SFTP)", "type": "textarea"},
            {"key": "scope", "label": "Archivos a respaldar", "type": "select", "options": [
                ["todo", "Todo el sitio (WordPress, temas, plugins y subidas)"],
                ["contenido", "Solo wp-content y los archivos de la raiz (WordPress se reinstala)"]], "default": "todo"},
            {"key": "db_host", "label": "Servidor MySQL (vacio = el del hosting)", "type": "text"},
            {"key": "db_port", "label": "Puerto MySQL", "type": "text", "default": "3306"},
            {"key": "db_name", "label": "Base de datos (vacio = la de wp-config.php)", "type": "text"},
            {"key": "db_user", "label": "Usuario MySQL (vacio = el de wp-config.php)", "type": "text"},
            {"key": "db_password", "label": "Contrasena MySQL (vacio = la de wp-config.php)", "type": "password", "secret": True},
            {"key": "db_tls", "label": "Conexion MySQL", "type": "select", "options": _TLS_MYSQL, "default": "cifrar"},
        ],
    },
}

# Lo que no vale la pena copiar todas las noches de un WordPress: caches y
# respaldos que generan otros plugins (pueden pesar mas que el sitio).
WP_EXCLUDES = ["/wp-content/cache/**", "/wp-content/upgrade/**", "/wp-content/ai1wm-backups/**", "/wp-content/updraft/**",
               "/wp-content/backups-dup-*/**", "/wp-content/wflogs/**", "/wp-content/et-cache/**", "error_log", "**/error_log"]


class SourceError(Exception):
    pass


def secret_keys(kind: str) -> set[str]:
    return {f["key"] for f in KINDS[kind]["fields"] if f.get("secret")}


def load_config(src) -> dict:
    raw = crypto_service.decrypt(src.config_enc) if src.config_enc else "{}"
    try:
        return json.loads(raw)
    except ValueError as e:
        raise SourceError("No se pudo leer la configuracion (clave de cifrado distinta a la que la guardo?).") from e


def store_config(src, config: dict) -> None:
    src.config_enc = crypto_service.encrypt(json.dumps(config))


def folder_key(name: str, taken: set[str]) -> str:
    """Carpeta fija del sistema dentro de cada trabajo (no cambia si se
    renombra, para no cortar sus cadenas)."""
    base = "_externo_" + (re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.")[:60] or "sistema")
    key, n = base, 1
    while key in taken:
        n += 1
        key = f"{base}-{n}"
    return key


_HOST = re.compile(r"^[A-Za-z0-9._-]+$")


def validate(kind: str, config: dict) -> list[str]:
    if kind not in KINDS:
        return [f"Tipo de sistema desconocido: {kind}"]
    problems = [f"Falta: {f['label']}." for f in KINDS[kind]["fields"]
                if f.get("required") and not str(config.get(f["key"]) or "").strip()]
    for k in ("host", "db_host"):
        if config.get(k) and not _HOST.match(config[k]):
            problems.append(f"Servidor no valido: {config[k]} (solo el nombre o la IP, sin http:// ni barras).")
    for k in ("port", "db_port"):
        if config.get(k) and not (str(config[k]).isdigit() and 0 < int(config[k]) < 65536):
            problems.append(f"Puerto no valido: {config[k]}.")
    if config.get("database") and not re.fullmatch(r"[A-Za-z0-9_$.-]{1,128}", config["database"]):
        problems.append("Nombre de base no valido.")
    if kind == "wordpress":
        p = config.get("wp_path", "public_html")
        if p.startswith("/") or ".." in p.split("/"):
            problems.append("La carpeta del sitio es relativa a la cuenta FTP, sin '..' (ej. public_html).")
    for f in KINDS[kind]["fields"]:
        if f["type"] == "select" and config.get(f["key"]) and config[f["key"]] not in [o[0] for o in f["options"]]:
            problems.append(f"Opcion no valida en {f['label']}.")
    return problems


def describe(kind: str, config: dict) -> str:
    """Texto corto para la lista (sin secretos)."""
    if kind == "wordpress":
        return f"{config.get('user', '')}@{config.get('host', '')}/{config.get('wp_path', 'public_html')}"
    return f"{config.get('user', '')}@{config.get('host', '')}:{config.get('port') or KINDS[kind]['default_port']}/{config.get('database', '')}"


# ------------------------------- ayudas comunes --------------------------------
def _private_dir() -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="externo_"))
    os.chmod(tmp, 0o700)
    return tmp


def _write_private(path: Path, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(text)


def _tail(text: str, n: int = 3) -> str:
    lines = [ln for ln in (text or "").splitlines() if ln.strip()]
    return " | ".join(lines[-n:])[:600]


def _missing_tool(tool: str) -> SourceError:
    return SourceError(f"{tool} no esta instalado en el contenedor (reconstruya la imagen de DevOps Sidecar).")


def _sha256(path: Path) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _connect_hint(err: str) -> str:
    e = err.lower()
    if any(s in e for s in ("timed out", "i/o timeout", "timeout expired", "can't connect", "could not connect", "connection refused", "no route", "error 2002", "error 2003")):
        return (" Sugerencia: el servidor no responde desde aqui. En Azure/cPanel agregue la IP publica de salida de la empresa "
                "en el firewall (Redes / MySQL remoto) y revise servidor y puerto.")
    if any(s in e for s in ("access denied", "password authentication failed", "login failed", "error 1045", "530 ")):
        return " Sugerencia: usuario o contrasena incorrectos (en Azure Database for MySQL antiguo el usuario es usuario@servidor)."
    if any(s in e for s in ("certificate", "ssl", "tls")):
        return (" Sugerencia: problema con el certificado o el cifrado. Si el servidor usa un certificado propio, elija "
                "'Cifrado sin verificar'; si no acepta cifrado, 'Sin cifrar' (solo en red privada).")
    return ""


# ---------------------------------- MySQL --------------------------------------
def _mysql_cnf(tmp: Path, host: str, port: str, user: str, password: str, tls: str) -> Path:
    def q(v: str) -> str:
        return '"' + str(v).replace("\\", "\\\\").replace('"', '\\"') + '"'
    lines = ["[client]", f"host={q(host)}", f"port={port or '3306'}", f"user={q(user)}", f"password={q(password)}",
             "default-character-set=utf8mb4"]
    if tls == "verificar":
        lines += ["ssl", "ssl-verify-server-cert", f"ssl-ca={SYSTEM_CA}"]
    elif tls == "cifrar":
        lines += ["ssl", "skip-ssl-verify-server-cert"]
    else:
        lines += ["skip-ssl"]
    cnf = tmp / "cliente.cnf"
    _write_private(cnf, "\n".join(lines) + "\n")
    return cnf


def _mysql_query(cnf: Path, database: str, sql: str) -> list[list[str]]:
    try:
        r = subprocess.run(["mariadb", f"--defaults-extra-file={cnf}", "--connect-timeout=20", "-N", "-B", "-e", sql, database],
                           capture_output=True, text=True, timeout=TEST_TIMEOUT)
    except FileNotFoundError:
        raise _missing_tool("mariadb")
    if r.returncode != 0:
        err = _tail(r.stderr)
        raise SourceError(err + _connect_hint(err))
    return [line.split("\t") for line in r.stdout.splitlines()]


def _mysql_test(c: dict) -> tuple[bool, str]:
    tmp = _private_dir()
    try:
        cnf = _mysql_cnf(tmp, c["host"], c.get("port"), c["user"], c["password"], c.get("tls", "verificar"))
        rows = _mysql_query(cnf, c["database"], "SELECT VERSION(); "
                            "SELECT COUNT(*), COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables "
                            "WHERE table_schema = DATABASE(); SHOW GRANTS")
        version = rows[0][0]
        tables, size = int(rows[1][0]), int(rows[1][1])
        grants = " ".join(r[0] for r in rows[2:]).upper()
        write = re.search(r"\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b", grants)
        msg = f"Conexion correcta: {version}, {tables} tabla(s), {size / 1048576:.1f} MB."
        if write:
            msg += " AVISO: el usuario puede modificar datos; para respaldar basta uno de solo lectura."
        return True, msg
    except SourceError as e:
        return False, str(e)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


_SANDBOX = re.compile(rb"^/\*M?!999999\\- enable the sandbox mode \*/\s*$")


def _mysql_dump(host, port, user, password, tls, database, routines: bool, target: Path) -> dict:
    """mariadb-dump consistente (--single-transaction), comprimido en
    streaming. Sin CREATE DATABASE/USE: se restaura en cualquier base."""
    tmp = _private_dir()
    try:
        cnf = _mysql_cnf(tmp, host, port, user, password, tls)
        server = _mysql_query(cnf, database, "SELECT VERSION()")[0][0]
        args = ["mariadb-dump", f"--defaults-extra-file={cnf}", "--single-transaction", "--quick", "--hex-blob",
                "--triggers", "--no-tablespaces", "--default-character-set=utf8mb4", "--skip-dump-date"]
        if routines:
            args.append("--routines")
        args.append(database)
        err_file = tmp / "errores.txt"
        tail = b""
        try:
            with open(err_file, "wb") as err, gzip.open(target, "wb") as out:
                proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=err)
                first = True
                for chunk in iter(lambda: proc.stdout.readline(), b""):
                    # La linea "sandbox" de mariadb-dump 11 solo tiene sentido al
                    # restaurar en MariaDB (la forma antigua /*!999999\- la
                    # rechaza el cliente de MySQL): se quita si el origen es MySQL.
                    if first:
                        first = False
                        if "mariadb" not in server.lower() and _SANDBOX.match(chunk):
                            continue
                    out.write(chunk)
                    tail = (tail + chunk)[-300:]
                proc.wait(timeout=DUMP_TIMEOUT)
        except FileNotFoundError:
            raise _missing_tool("mariadb-dump")
        stderr = err_file.read_text(errors="replace")
        if proc.returncode != 0:
            target.unlink(missing_ok=True)
            hint = " Sugerencia: el usuario no puede leer los procedimientos; elija 'No incluir' o de el permiso SHOW_ROUTINE." \
                if "routine" in stderr.lower() or "procedure" in stderr.lower() else _connect_hint(stderr)
            raise SourceError("mariadb-dump fallo: " + _tail(stderr) + hint)
        if b"-- Dump completed" not in tail:
            target.unlink(missing_ok=True)
            raise SourceError("El volcado quedo incompleto (no termina con 'Dump completed').")
        return {"server": server, "warnings": _tail(stderr)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# -------------------------------- PostgreSQL -----------------------------------
def _pg_env(c: dict, tmp: Path) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
    env.update({"PGHOST": c["host"], "PGPORT": str(c.get("port") or "5432"), "PGUSER": c["user"], "PGDATABASE": c["database"],
                "PGPASSWORD": c["password"], "PGSSLMODE": c.get("sslmode", "verify-full"), "PGCONNECT_TIMEOUT": "20",
                "PGAPPNAME": "devops-sidecar-respaldo", "HOME": str(tmp)})
    if env["PGSSLMODE"] == "verify-full":
        env["PGSSLROOTCERT"] = SYSTEM_CA
    return env


def _pg_test(c: dict) -> tuple[bool, str]:
    tmp = _private_dir()
    try:
        try:
            r = subprocess.run(["psql", "-X", "-A", "-t", "-F", "\t", "-c",
                                "SELECT version(), pg_database_size(current_database()), "
                                "(SELECT rolsuper FROM pg_roles WHERE rolname = current_user), "
                                "(SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema'))"],
                               capture_output=True, text=True, timeout=TEST_TIMEOUT, env=_pg_env(c, tmp))
        except FileNotFoundError:
            raise _missing_tool("psql")
        if r.returncode != 0:
            err = _tail(r.stderr)
            return False, err + _connect_hint(err)
        version, size, superuser, tables = r.stdout.strip().split("\t")
        dump_major = _pg_dump_major()
        server_major = int(re.search(r"PostgreSQL (\d+)", version).group(1))
        msg = f"Conexion correcta: PostgreSQL {server_major}, {tables} tabla(s), {int(size) / 1048576:.1f} MB."
        if dump_major and server_major > dump_major:
            return False, msg + f" Pero pg_dump es version {dump_major} y no puede respaldar un servidor {server_major}: actualice la imagen."
        if superuser == "t":
            msg += " AVISO: el usuario es superusuario; para respaldar basta uno con pg_read_all_data."
        return True, msg
    except SourceError as e:
        return False, str(e)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _pg_dump_major() -> int | None:
    try:
        out = subprocess.run(["pg_dump", "--version"], capture_output=True, text=True, timeout=30).stdout
        return int(re.search(r"(\d+)", out).group(1))
    except (FileNotFoundError, AttributeError, subprocess.TimeoutExpired):
        return None


def _pg_dump(c: dict, target: Path) -> dict:
    tmp = _private_dir()
    try:
        try:
            r = subprocess.run(["pg_dump", "--format=custom", "--compress=6", "--no-password", f"--file={target}"],
                               capture_output=True, text=True, timeout=DUMP_TIMEOUT, env=_pg_env(c, tmp))
        except FileNotFoundError:
            raise _missing_tool("pg_dump")
        if r.returncode != 0:
            target.unlink(missing_ok=True)
            err = _tail(r.stderr)
            raise SourceError("pg_dump fallo: " + err + _connect_hint(err))
        check = subprocess.run(["pg_restore", "--list", str(target)], capture_output=True, text=True, timeout=600)
        if check.returncode != 0:
            raise SourceError("El volcado no se puede leer con pg_restore: " + _tail(check.stderr))
        return {"objects": sum(1 for ln in check.stdout.splitlines() if ln and not ln.startswith(";")), "warnings": _tail(r.stderr)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------- Azure SQL -------------------------------------
def _sqlpackage(action: str, c: dict, target: Path, extra: list[str] | None = None, timeout: int = DUMP_TIMEOUT):
    tmp = _private_dir()
    try:
        args = [SQLPACKAGE, f"/Action:{action}", f"/SourceServerName:tcp:{c['host']},{c.get('port') or '1433'}",
                f"/SourceDatabaseName:{c['database']}", f"/SourceUser:{c['user']}", f"/SourcePassword:{c['password']}",
                "/SourceEncryptConnection:True", f"/SourceTrustServerCertificate:{'True' if c.get('tls') == 'confiar' else 'False'}",
                "/SourceTimeout:30", f"/TargetFile:{target}", "/Quiet:True", *(extra or [])]
        env = dict(os.environ, HOME=str(tmp), DOTNET_CLI_TELEMETRY_OPTOUT="1")
        try:
            r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=env)
        except FileNotFoundError:
            raise _missing_tool("sqlpackage (Azure SQL)")
        if r.returncode != 0:
            target.unlink(missing_ok=True)
            # sqlpackage escribe el error en stdout; nunca repite la contrasena.
            err = _tail((r.stdout or "") + "\n" + (r.stderr or ""), 4).replace(c["password"], "***")
            raise SourceError(err + _connect_hint(err))
        return r
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _mssql_test(c: dict) -> tuple[bool, str]:
    """Extrae solo el esquema (.dacpac): confirma conexion, certificado y
    permisos con lo mismo que usa la exportacion."""
    tmp = _private_dir()
    try:
        out = tmp / "prueba.dacpac"
        _sqlpackage("Extract", c, out, ["/p:ExtractAllTableData=False", "/p:VerifyExtraction=False"], timeout=600)
        with zipfile.ZipFile(out) as z:
            model = z.read("model.xml").decode("utf-8", errors="replace")
        tables = model.count('Type="SqlTable"')
        return True, f"Conexion correcta y permisos suficientes para exportar: {tables} tabla(s) en el esquema."
    except SourceError as e:
        return False, str(e)
    except (zipfile.BadZipFile, KeyError) as e:
        return False, f"sqlpackage no genero un esquema valido: {e}"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _mssql_export(c: dict, target: Path) -> dict:
    _sqlpackage("Export", c, target)
    return _check_bacpac(target)


def _check_bacpac(path: Path) -> dict:
    try:
        with zipfile.ZipFile(path) as z:
            bad = z.testzip()
            names = z.namelist()
    except zipfile.BadZipFile as e:
        raise SourceError(f"El .bacpac no es un archivo valido: {e}") from e
    if bad:
        raise SourceError(f"El .bacpac esta danado ({bad}).")
    if "model.xml" not in names:
        raise SourceError("El .bacpac no trae model.xml.")
    return {"tables_with_data": len({n.split("/")[1] for n in names if n.startswith("Data/") and n.count("/") >= 2})}


# -------------------------------- WordPress ------------------------------------
def _files_config(c: dict) -> SimpleNamespace:
    """Conexion de archivos como un 'destino' de rclone (misma sesion
    temporal y segura que usan los destinos)."""
    proto = c.get("protocol", "ftps")
    cfg = {"host": c["host"], "user": c["user"], "pass": c["password"]}
    if proto == "sftp":
        cfg.update({"port": c.get("port") or "22", "known_hosts": c.get("known_hosts", "")})
        kind = "sftp"
    else:
        kind = "ftp"
        cfg.update({"port": c.get("port") or ("990" if proto == "ftps_implicit" else "21"), "tls_mode": proto,
                    "no_check_certificate": c.get("verify_cert", "si") == "no"})
    return SimpleNamespace(kind=kind, remote_path=(c.get("wp_path") or "public_html").strip("/") or ".",
                           encrypt=False, config=cfg)


def _wp_config_values(text: str) -> dict:
    out = {}
    for key in ("DB_NAME", "DB_USER", "DB_PASSWORD", "DB_HOST"):
        m = re.search(r"define\s*\(\s*['\"]" + key + r"['\"]\s*,\s*(['\"])(.*?)(?<!\\)\1\s*\)", text, re.S)
        if m:
            out[key] = m.group(2).replace("\\'", "'").replace('\\"', '"')
    m = re.search(r"\$table_prefix\s*=\s*['\"]([A-Za-z0-9_]+)['\"]", text)
    out["prefix"] = m.group(1) if m else "wp_"
    return out


def _wp_db(c: dict, s) -> dict:
    """Datos de la base: los del formulario o, si faltan, los de
    wp-config.php (DB_HOST suele ser localhost: el servidor real lo da el
    formulario, por defecto el del hosting)."""
    r = s.run(["cat", s.path("wp-config.php")], timeout=TEST_TIMEOUT)
    if r.returncode != 0:
        raise SourceError("No se encontro wp-config.php en la carpeta del sitio: " + rclone_service._err(r))
    wp = _wp_config_values(r.stdout)
    db = {"host": c.get("db_host") or c["host"], "port": c.get("db_port") or "3306",
          "database": c.get("db_name") or wp.get("DB_NAME", ""), "user": c.get("db_user") or wp.get("DB_USER", ""),
          "password": c.get("db_password") or wp.get("DB_PASSWORD", ""), "tls": c.get("db_tls", "cifrar"), "prefix": wp["prefix"]}
    if not (db["database"] and db["user"]):
        raise SourceError("wp-config.php no trae DB_NAME/DB_USER: complete la base y el usuario en el formulario.")
    return db


def _wp_test(c: dict) -> tuple[bool, str]:  # noqa: C901
    try:
        with rclone_service.RcloneSession(_files_config(c)) as s:
            r = s.run(["lsjson", "--max-depth", "1", s.path()], timeout=TEST_TIMEOUT)
            if r.returncode != 0:
                err = rclone_service._err(r)
                return False, "No se pudo entrar por FTP/SFTP: " + err + _connect_hint(err)
            names = {i["Name"] for i in json.loads(r.stdout or "[]")}
            if "wp-config.php" not in names or "wp-content" not in names:
                return False, f"La carpeta '{s.dest.remote_path}' no parece un WordPress (no estan wp-config.php y wp-content)."
            db = _wp_db(c, s)
            size = s.run(["size", "--json", s.path("wp-content")], timeout=900)
        files = ""
        if size.returncode == 0:
            info = json.loads(size.stdout or "{}")
            files = f" wp-content: {info.get('count', 0)} archivo(s), {info.get('bytes', 0) / 1048576:.1f} MB."
        ok, msg = _mysql_test(db)
        if ok and not c.get("db_user"):
            msg = msg.replace("AVISO: el usuario puede modificar datos; para respaldar basta uno de solo lectura.",
                              "AVISO: es el usuario de WordPress (puede escribir): para respaldar basta uno de solo lectura creado en cPanel.")
        if not ok:
            return False, f"Archivos correctos.{files} Base de datos: {msg}"
        return True, f"Archivos correctos.{files} Base {db['database']}: {msg.replace('Conexion correcta: ', '')}"
    except (rclone_service.RcloneError, SourceError) as e:
        return False, str(e)
    except subprocess.TimeoutExpired:
        return False, "Tiempo de espera agotado conectando con el hosting."


def mirror_dir(src) -> Path:
    return Path(settings.backups_path) / "externos" / str(src.id) / "sitio"


def _wp_backup(src, c: dict, folder: Path, base: str, log) -> list[Path]:
    mirror = mirror_dir(src)
    mirror.mkdir(parents=True, exist_ok=True)
    filters = [f"- {p}" for p in WP_EXCLUDES]
    if c.get("scope") == "contenido":
        filters += ["+ /wp-content/**", "+ /*", "- **"]
    with rclone_service.RcloneSession(_files_config(c)) as s:
        ffile = s.tmp / "filtros.txt"
        ffile.write_text("\n".join(filters) + "\n")
        # sync: en el espejo local solo se descarga lo que cambio desde ayer.
        r = s.run(["sync", s.path(), str(mirror), "--filter-from", str(ffile), "--transfers", "4"], timeout=DUMP_TIMEOUT)
        if r.returncode != 0:
            err = rclone_service._err(r)
            raise SourceError("No se pudieron descargar los archivos del sitio: " + err + _connect_hint(err))
        db = _wp_db(c, s)
    if not (mirror / "wp-config.php").exists():
        raise SourceError("La copia del sitio no trae wp-config.php.")
    files_tar = folder / f"{base}_archivos.tar.gz"
    count = 0
    with tarfile.open(files_tar, "w:gz") as tar:
        for p in sorted(mirror.rglob("*")):
            if p.is_symlink():
                continue
            tar.add(p, arcname="sitio/" + p.relative_to(mirror).as_posix(), recursive=False)
            count += p.is_file()
    log(f"    archivos del sitio: {count} archivo(s), {files_tar.stat().st_size / 1048576:.1f} MB comprimidos")
    dump = folder / f"{base}_basedatos.sql.gz"
    info = _mysql_dump(db["host"], db["port"], db["user"], db["password"], db["tls"], db["database"], True, dump)
    log(f"    base {db['database']} ({info['server']}): {dump.stat().st_size / 1048576:.1f} MB comprimidos")
    (folder / "RESTAURAR.txt").write_text(
        f"Respaldo del sitio WordPress '{src.name}' generado por DevOps Sidecar.\n\n"
        f"  {files_tar.name}  -> carpeta sitio/ con los archivos (incluye wp-config.php)\n"
        f"  {dump.name}  -> base de datos {db['database']} (prefijo de tablas {db['prefix']})\n\n"
        "Restaurar en un hosting (cPanel u otro):\n"
        "  1. Cree una base y un usuario MySQL vacios.\n"
        f"  2. gunzip -c {dump.name} | mysql -h SERVIDOR -u USUARIO -p BASE_NUEVA\n"
        "     (o en phpMyAdmin: Importar el .sql descomprimido).\n"
        f"  3. tar -xzf {files_tar.name} y suba el contenido de sitio/ a la carpeta del sitio (public_html).\n"
        "  4. En wp-config.php ponga DB_NAME, DB_USER, DB_PASSWORD y DB_HOST de la base nueva.\n"
        "  5. Si cambia el dominio: wp search-replace 'https://dominio-viejo' 'https://dominio-nuevo' --all-tables\n"
        "Integridad: compare el SHA-256 de cada archivo con manifest.json (sha256sum).\n", encoding="utf-8")
    return [files_tar, dump]


# ---------------------------------- API ----------------------------------------
def test_source(src) -> tuple[bool, str]:
    c = load_config(src)
    try:
        if src.kind == "mysql":
            return _mysql_test(c)
        if src.kind == "postgres":
            return _pg_test(c)
        if src.kind == "mssql":
            return _mssql_test(c)
        if src.kind == "wordpress":
            return _wp_test(c)
    except subprocess.TimeoutExpired:
        return False, "Tiempo de espera agotado."
    return False, f"Tipo desconocido: {src.kind}"


def backup(src, folder: Path, stamp: str, log) -> list[dict]:
    """Genera el respaldo en `folder` y devuelve [{name, size, sha256}]
    (sin manifest ni RESTAURAR.txt, que tambien quedan en la carpeta)."""
    c = load_config(src)
    base = f"00_completo_{re.sub(r'[^A-Za-z0-9._-]+', '-', src.name).strip('-.')[:50] or 'sistema'}_{stamp}"
    started = datetime.utcnow()
    if src.kind == "mysql":
        out = folder / f"{base}.sql.gz"
        info = _mysql_dump(c["host"], c.get("port"), c["user"], c["password"], c.get("tls", "verificar"), c["database"],
                           c.get("routines", "si") == "si", out)
        files = [out]
        log(f"    {info['server']}: volcado de {c['database']} {out.stat().st_size / 1048576:.1f} MB comprimidos")
        restore = (f"Base MySQL/MariaDB '{c['database']}' de {c['host']} (volcado consistente con --single-transaction).\n\n"
                   "Restaurar en una base NUEVA (no encima de la de produccion sin estar seguro):\n"
                   f"  mysql -h SERVIDOR -u USUARIO -p -e 'CREATE DATABASE base_restaurada'\n"
                   f"  gunzip -c {out.name} | mysql -h SERVIDOR -u USUARIO -p base_restaurada\n"
                   "Azure: agregue --ssl-mode=REQUIRED (cliente de MySQL) o --ssl (cliente de MariaDB).\n")
    elif src.kind == "postgres":
        out = folder / f"{base}.dump"
        info = _pg_dump(c, out)
        files = [out]
        log(f"    PostgreSQL: volcado de {c['database']} {out.stat().st_size / 1048576:.1f} MB ({info['objects']} objeto(s))")
        restore = (f"Base PostgreSQL '{c['database']}' de {c['host']} (pg_dump, formato personalizado).\n\n"
                   "Restaurar en una base NUEVA:\n"
                   "  createdb -h SERVIDOR -U USUARIO base_restaurada\n"
                   f"  pg_restore -h SERVIDOR -U USUARIO -d base_restaurada --no-owner --no-privileges {out.name}\n"
                   f"Una sola tabla: pg_restore --list {out.name} y luego -t NOMBRE_TABLA.\n"
                   "Los roles (usuarios) no van en el volcado: cree los que use la aplicacion.\n")
    elif src.kind == "mssql":
        out = folder / f"{base}.bacpac"
        info = _mssql_export(c, out)
        files = [out]
        log(f"    Azure SQL: exportacion de {c['database']} {out.stat().st_size / 1048576:.1f} MB "
            f"({info['tables_with_data']} tabla(s) con datos). AVISO: un .bacpac no es una foto en un instante.")
        restore = (f"Base Azure SQL / SQL Server '{c['database']}' de {c['host']} (.bacpac de sqlpackage).\n\n"
                   "Restaurar en una base NUEVA:\n"
                   f"  sqlpackage /Action:Import /SourceFile:{out.name} /TargetServerName:SERVIDOR "
                   "/TargetDatabaseName:base_restaurada /TargetUser:USUARIO /TargetPassword:...\n"
                   "  o en el portal de Azure: servidor SQL > Importar base de datos (subiendo el .bacpac a un Storage).\n"
                   "  o en SSMS: Bases de datos > Importar aplicacion de capa de datos.\n")
    elif src.kind == "wordpress":
        files = _wp_backup(src, c, folder, base, log)
        restore = None
    else:
        raise SourceError(f"Tipo desconocido: {src.kind}")
    if restore:
        (folder / "RESTAURAR.txt").write_text(
            f"Respaldo de '{src.name}' generado por DevOps Sidecar el {started:%Y-%m-%d %H:%M} UTC.\n\n" + restore +
            "\nIntegridad: compare el SHA-256 del archivo con manifest.json (sha256sum).\n", encoding="utf-8")
    return [{"name": p.name, "size": p.stat().st_size, "sha256": _sha256(p)} for p in files]


def verify_file(path: Path) -> str:
    """Revision del contenido de un archivo del respaldo (ademas del
    SHA-256): que se pueda leer entero. Devuelve un resumen."""
    name = path.name
    if name.endswith("_archivos.tar.gz"):
        n = 0
        with tarfile.open(path, "r:gz") as tar:
            for m in tar:
                if m.name.startswith("/") or ".." in m.name.split("/") or m.issym() or m.islnk():
                    raise SourceError(f"{name} trae una ruta no permitida: {m.name}")
                n += m.isfile()
        return f"{name}: {n} archivo(s) legibles"
    if name.endswith(".sql.gz"):
        tail = b""
        with gzip.open(path, "rb") as fh:
            for block in iter(lambda: fh.read(1024 * 1024), b""):
                tail = (tail + block)[-300:]
        if b"-- Dump completed" not in tail:
            raise SourceError(f"{name} esta incompleto (no termina con 'Dump completed').")
        return f"{name}: volcado SQL completo"
    if name.endswith(".dump"):
        r = subprocess.run(["pg_restore", "--list", str(path)], capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise SourceError(f"{name} no se puede leer con pg_restore: {_tail(r.stderr)}")
        return f"{name}: volcado PostgreSQL legible ({sum(1 for ln in r.stdout.splitlines() if ln and not ln.startswith(';'))} objeto(s))"
    if name.endswith(".bacpac"):
        info = _check_bacpac(path)
        return f"{name}: .bacpac valido ({info['tables_with_data']} tabla(s) con datos)"
    return f"{name}: sin revision de contenido"
