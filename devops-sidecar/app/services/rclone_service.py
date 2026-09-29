"""Destinos externos de respaldo via rclone (un solo motor para OneDrive
personal y Microsoft 365, Google Drive, S3/Backblaze/Wasabi, SFTP, SMB,
WebDAV/Nextcloud y discos locales o USB montados en el contenedor).

La configuracion de cada destino se guarda cifrada en BD
(BackupDestination.config_enc). rclone necesita un archivo de config con
esos secretos: se genera solo mientras dura una operacion, en un
directorio temporal con permisos 0700/0600, y se borra al terminar
(RcloneSession). OneDrive y Google Drive renuevan su token OAuth por su
cuenta: al cerrar la sesion se lee el token renovado del archivo y se
devuelve para guardarlo otra vez cifrado - si no, el refresh token
original terminaria venciendo.

Cifrado opcional del lado del cliente con rclone crypt: contenido y
nombres de archivo. Se puede descifrar sin esta aplicacion, solo con
rclone y la contrasena (ver README, "Restaurar sin el sidecar").
"""
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import httpx

from . import crypto_service

RCLONE = "rclone"
LONG_TIMEOUT = 6 * 3600  # subidas grandes por enlaces lentos

# Especificacion de campos por tipo: la usa la API para validar y la
# pantalla para dibujar el formulario. secret=True: nunca se devuelve al
# navegador; al editar, dejarlo vacio conserva el valor guardado.
KINDS = {
    "onedrive": {
        "label": "OneDrive (personal o Microsoft 365)",
        "oauth": "onedrive",
        "path_help": "Carpeta dentro del OneDrive, ej. Respaldos/devops-sidecar",
        "fields": [
            {"key": "token", "label": "Autorizacion (JSON de rclone authorize)", "type": "textarea", "secret": True, "required": True,
             "help": 'En un PC con navegador: instale rclone y ejecute  rclone authorize "onedrive" . Inicie sesion con la cuenta (personal o de la empresa) y pegue aqui el JSON que aparece entre ---> y <---.'},
            {"key": "drive_type", "label": "Tipo de cuenta", "type": "select", "options": [
                ["auto", "Detectar automaticamente"], ["personal", "OneDrive personal"],
                ["business", "OneDrive de Microsoft 365 (empresa)"], ["documentLibrary", "Biblioteca de SharePoint"]], "default": "auto"},
            {"key": "drive_id", "label": "ID de la unidad (opcional)", "type": "text",
             "help": "Se detecta solo. Solo hace falta para una biblioteca de SharePoint especifica."},
            {"key": "client_id", "label": "Client ID propio (opcional)", "type": "text",
             "help": "Solo si el administrador de Microsoft 365 bloquea la app de rclone y registro una propia en Entra ID."},
            {"key": "client_secret", "label": "Client secret (opcional)", "type": "password", "secret": True},
        ],
    },
    "gdrive": {
        "label": "Google Drive",
        "oauth": "drive",
        "path_help": "Carpeta dentro de Google Drive, ej. Respaldos/devops-sidecar",
        "fields": [
            {"key": "token", "label": "Autorizacion (JSON de rclone authorize)", "type": "textarea", "secret": True, "required": True,
             "help": 'En un PC con navegador ejecute  rclone authorize "drive"  y pegue el JSON.'},
            {"key": "team_drive", "label": "ID de unidad compartida (opcional)", "type": "text"},
            {"key": "client_id", "label": "Client ID propio (opcional)", "type": "text"},
            {"key": "client_secret", "label": "Client secret (opcional)", "type": "password", "secret": True},
        ],
    },
    "s3": {
        "label": "S3 compatible (AWS, Backblaze B2, Wasabi, Cloudflare R2, MinIO)",
        "path_help": "bucket/carpeta, ej. mis-respaldos/devops-sidecar",
        "fields": [
            {"key": "provider", "label": "Proveedor", "type": "select", "options": [
                ["AWS", "Amazon S3"], ["Wasabi", "Wasabi"], ["Cloudflare", "Cloudflare R2"], ["Minio", "MinIO"],
                ["Other", "Otro compatible (Backblaze B2 S3, etc.)"]], "default": "AWS"},
            {"key": "access_key_id", "label": "Access key ID", "type": "text", "required": True},
            {"key": "secret_access_key", "label": "Secret access key", "type": "password", "secret": True, "required": True},
            {"key": "region", "label": "Region (opcional)", "type": "text"},
            {"key": "endpoint", "label": "Endpoint (obligatorio salvo AWS)", "type": "text",
             "help": "ej. s3.us-west-004.backblazeb2.com  o  s3.wasabisys.com"},
        ],
    },
    "sftp": {
        "label": "SFTP (servidor Linux por SSH)",
        "path_help": "Carpeta en el servidor, ej. /srv/respaldos/devops-sidecar",
        "fields": [
            {"key": "host", "label": "Servidor", "type": "text", "required": True},
            {"key": "port", "label": "Puerto", "type": "text", "default": "22"},
            {"key": "user", "label": "Usuario", "type": "text", "required": True},
            {"key": "pass", "label": "Contrasena (o use llave)", "type": "password", "secret": True, "obscure": True},
            {"key": "key_pem", "label": "Llave privada (opcional)", "type": "textarea", "secret": True},
            {"key": "known_hosts", "label": "Huella del servidor (known_hosts, recomendado)", "type": "textarea",
             "help": "Salida de  ssh-keyscan -p PUERTO SERVIDOR  (desde una red de confianza). Con ella se rechaza cualquier servidor que se haga pasar por el real; sin ella no se valida la identidad del servidor."},
        ],
    },
    "smb": {
        "label": "Carpeta compartida de Windows / NAS (SMB)",
        "path_help": "recurso/carpeta, ej. Respaldos/devops-sidecar  (para \\\\servidor\\Respaldos\\devops-sidecar)",
        "fields": [
            {"key": "host", "label": "Servidor (nombre o IP)", "type": "text", "required": True},
            {"key": "user", "label": "Usuario", "type": "text", "required": True},
            {"key": "pass", "label": "Contrasena", "type": "password", "secret": True, "obscure": True, "required": True},
            {"key": "domain", "label": "Dominio (opcional)", "type": "text", "default": "WORKGROUP"},
            {"key": "port", "label": "Puerto", "type": "text", "default": "445"},
        ],
    },
    "webdav": {
        "label": "WebDAV (Nextcloud, ownCloud u otro)",
        "path_help": "Carpeta dentro del servicio, ej. Respaldos/devops-sidecar",
        "fields": [
            {"key": "url", "label": "URL WebDAV", "type": "text", "required": True,
             "help": "Nextcloud: https://nube.empresa.com/remote.php/dav/files/USUARIO/"},
            {"key": "vendor", "label": "Tipo", "type": "select", "options": [
                ["nextcloud", "Nextcloud"], ["owncloud", "ownCloud"], ["other", "Otro"]], "default": "nextcloud"},
            {"key": "user", "label": "Usuario", "type": "text", "required": True},
            {"key": "pass", "label": "Contrasena o token de app", "type": "password", "secret": True, "obscure": True, "required": True},
        ],
    },
    "local": {
        "label": "Disco local, USB o carpeta montada en el servidor",
        "path_help": "Ruta DENTRO del contenedor, ej. /data/externo/devops-sidecar",
        "fields": [],
    },
}

CRYPT_FIELDS = [
    {"key": "crypt_password", "label": "Contrasena de cifrado", "type": "password", "secret": True},
    {"key": "crypt_password2", "label": "Segunda contrasena / sal (opcional, recomendada)", "type": "password", "secret": True},
]


class RcloneError(Exception):
    pass


def secret_keys(kind: str) -> set[str]:
    keys = {f["key"] for f in KINDS[kind]["fields"] if f.get("secret")}
    return keys | {f["key"] for f in CRYPT_FIELDS}


def load_config(dest) -> dict:
    raw = crypto_service.decrypt(dest.config_enc) if dest.config_enc else "{}"
    try:
        return json.loads(raw)
    except ValueError as e:
        raise RcloneError("No se pudo leer la configuracion del destino (clave de cifrado distinta a la que la guardo?).") from e


def store_config(dest, config: dict) -> None:
    dest.config_enc = crypto_service.encrypt(json.dumps(config))


def validate(kind: str, config: dict, encrypt: bool, remote_path: str) -> list[str]:
    if kind not in KINDS:
        return [f"Tipo de destino desconocido: {kind}"]
    problems = []
    for f in KINDS[kind]["fields"]:
        if f.get("required") and not str(config.get(f["key"]) or "").strip():
            problems.append(f"Falta: {f['label']}.")
    if kind in ("onedrive", "gdrive") and config.get("token"):
        try:
            tok = json.loads(config["token"])
            if not tok.get("refresh_token"):
                problems.append("La autorizacion no trae refresh_token: copie el JSON completo que muestra rclone authorize.")
        except ValueError:
            problems.append("La autorizacion debe ser el JSON que muestra rclone authorize (empieza con {).")
    if kind == "sftp" and not (config.get("pass") or config.get("key_pem")):
        problems.append("SFTP necesita contrasena o llave privada.")
    if kind == "s3" and config.get("provider") not in ("AWS", None, "") and not config.get("endpoint"):
        problems.append("Para ese proveedor S3 indique el endpoint.")
    if kind == "local" and not remote_path.startswith("/"):
        problems.append("Para disco local la carpeta debe ser una ruta absoluta dentro del contenedor (ej. /data/externo).")
    if encrypt and not config.get("crypt_password"):
        problems.append("Con cifrado activado hace falta la contrasena de cifrado.")
    if not remote_path.strip():
        problems.append("Indique la carpeta de destino.")
    return problems


def _obscure(value: str) -> str:
    """rclone exige las contrasenas 'obscured' en su config. Se pasa por
    stdin para que no quede en la linea de comandos (visible en ps)."""
    result = subprocess.run([RCLONE, "obscure", "-"], input=value, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RcloneError("rclone obscure fallo: " + (result.stderr or "")[:200])
    return result.stdout.strip()


def discover_onedrive(token_json: str) -> dict:
    """Consulta Microsoft Graph con el token recien autorizado para saber
    el ID y el tipo de la unidad y la cuenta (rclone los necesita y el
    asistente interactivo que normalmente los pide no existe aqui)."""
    try:
        access = json.loads(token_json)["access_token"]
    except (ValueError, KeyError) as e:
        raise RcloneError("La autorizacion no trae access_token.") from e
    resp = httpx.get("https://graph.microsoft.com/v1.0/me/drive", headers={"Authorization": f"Bearer {access}"}, timeout=30)
    if resp.status_code == 401:
        raise RcloneError("La autorizacion de OneDrive ya vencio (dura 1 hora): genere una nueva con rclone authorize y peguela.")
    if resp.status_code != 200:
        raise RcloneError(f"Microsoft Graph respondio {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    owner = (data.get("owner") or {}).get("user") or {}
    return {
        "drive_id": data.get("id", ""),
        "drive_type": data.get("driveType", "personal"),
        "account": owner.get("email") or owner.get("displayName") or "",
    }


def _conf_sections(dest, config: dict, tmp: Path) -> tuple[str, str]:
    """Devuelve (texto del rclone.conf, destino base 'remoto:ruta').
    tmp: directorio privado de la sesion, para archivos auxiliares."""
    kind = dest.kind
    base = {"type": kind if kind != "gdrive" else "drive"}
    if kind == "onedrive":
        base.update({"token": config["token"], "drive_id": config.get("drive_id", ""), "drive_type": config.get("drive_type", "personal")})
    elif kind == "gdrive":
        base.update({"token": config["token"], "scope": "drive"})
        if config.get("team_drive"):
            base["team_drive"] = config["team_drive"]
    elif kind == "s3":
        base.update({k: config.get(k, "") for k in ("provider", "access_key_id", "secret_access_key", "region", "endpoint")})
        base["no_check_bucket"] = "true"
    elif kind == "sftp":
        base.update({"host": config["host"], "port": config.get("port") or "22", "user": config["user"]})
        if config.get("pass"):
            base["pass"] = _obscure(config["pass"])
        if config.get("key_pem"):
            base["key_pem"] = config["key_pem"].strip().replace("\r\n", "\n").replace("\n", "\\n")
        if config.get("known_hosts"):
            kh = tmp / "known_hosts"
            kh.write_text(config["known_hosts"].replace("\r\n", "\n").strip() + "\n")
            base["known_hosts_file"] = str(kh)
    elif kind == "smb":
        base.update({"host": config["host"], "user": config["user"], "pass": _obscure(config["pass"]),
                     "domain": config.get("domain") or "WORKGROUP", "port": config.get("port") or "445"})
    elif kind == "webdav":
        base.update({"url": config["url"], "vendor": config.get("vendor") or "other", "user": config["user"],
                     "pass": _obscure(config["pass"])})
    for k in ("client_id", "client_secret"):
        if config.get(k):
            base[k] = config[k]

    remote_path = dest.remote_path.strip().strip("/") if kind != "local" else dest.remote_path.rstrip("/")
    lines = ["[dst]"] + [f"{k} = {v}" for k, v in base.items() if v != ""]
    target = f"dst:{remote_path}"
    if dest.encrypt:
        lines += ["", "[dstc]", "type = crypt", f"remote = dst:{remote_path}",
                  f"password = {_obscure(config['crypt_password'])}",
                  "filename_encryption = standard", "directory_name_encryption = true"]
        if config.get("crypt_password2"):
            lines.append(f"password2 = {_obscure(config['crypt_password2'])}")
        target = "dstc:"
    return "\n".join(lines) + "\n", target


class RcloneSession:
    """Abre un rclone.conf temporal para un destino. Uso:
        with RcloneSession(dest) as s:
            s.run(["lsf", s.path("carpeta")])
        s.new_token  -> token OAuth renovado (o None) para guardarlo."""

    def __init__(self, dest):
        self.dest = dest
        self.config = load_config(dest)
        self.new_token = None

    def __enter__(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="rclone_"))
        os.chmod(self.tmp, 0o700)
        text, self.target = _conf_sections(self.dest, self.config, self.tmp)
        self.conf = self.tmp / "rclone.conf"
        fd = os.open(self.conf, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
        self.env = dict(os.environ)
        self.env.update({"RCLONE_CONFIG": str(self.conf), "RCLONE_CACHE_DIR": str(self.tmp / "cache"),
                         "XDG_CACHE_HOME": str(self.tmp / "cache"), "HOME": str(self.tmp)})
        return self

    def __exit__(self, *exc):
        try:
            if self.dest.kind in ("onedrive", "gdrive"):
                for line in self.conf.read_text().splitlines():
                    if line.startswith("token = "):
                        token = line[len("token = "):].strip()
                        if token and token != self.config.get("token"):
                            self.new_token = token
                        break
        finally:
            shutil.rmtree(self.tmp, ignore_errors=True)
        return False

    def path(self, sub: str = "") -> str:
        sub = sub.strip("/")
        if not sub:
            return self.target
        return f"{self.target}{sub}" if self.target.endswith(":") else f"{self.target}/{sub}"

    def run(self, args: list[str], timeout: int = 300, stdin: str | None = None) -> subprocess.CompletedProcess:
        return subprocess.run([RCLONE, *args, "--retries", "3", "--low-level-retries", "5", "--stats", "0"],
                              input=stdin, capture_output=True, text=True, timeout=timeout, env=self.env)


def persist_new_token(db, dest, session: RcloneSession) -> None:
    if session.new_token:
        config = load_config(dest)
        config["token"] = session.new_token
        store_config(dest, config)
        db.commit()


def _err(result: subprocess.CompletedProcess) -> str:
    lines = [ln for ln in (result.stderr or result.stdout or "").splitlines() if ln.strip()]
    return " | ".join(lines[-3:])[:600] or f"codigo {result.returncode}"


def test_destination(db, dest) -> tuple[bool, str]:
    """Crea la carpeta, escribe, lee y borra un archivo de prueba."""
    try:
        with RcloneSession(dest) as s:
            probe = ".devops-sidecar-prueba.txt"
            r = s.run(["mkdir", s.path()], timeout=120)
            if r.returncode != 0:
                return False, "No se pudo crear/abrir la carpeta: " + _err(r)
            r = s.run(["rcat", s.path(probe)], timeout=120, stdin="prueba de escritura del DevOps Sidecar\n")
            if r.returncode != 0:
                return False, "No se pudo escribir: " + _err(r)
            r = s.run(["cat", s.path(probe)], timeout=120)
            if r.returncode != 0 or "prueba de escritura" not in (r.stdout or ""):
                return False, "Se escribio pero no se pudo leer de vuelta: " + _err(r)
            s.run(["deletefile", s.path(probe)], timeout=120)
            about = s.run(["about", s.path(), "--json"], timeout=120)
            extra = ""
            if dest.kind == "sftp" and not s.config.get("known_hosts"):
                extra += " AVISO: sin huella del servidor (known_hosts) no se verifica su identidad."
            if about.returncode == 0:
                try:
                    info = json.loads(about.stdout)
                    if info.get("free") is not None:
                        extra = f" Espacio libre: {info['free'] / 1024 ** 3:.1f} GB."
                except ValueError:
                    pass
        persist_new_token(db, dest, s)
        return True, "Conexion correcta: se creo, leyo y borro un archivo de prueba." + extra
    except RcloneError as e:
        return False, str(e)
    except subprocess.TimeoutExpired:
        return False, "Tiempo de espera agotado conectando con el destino."
    except FileNotFoundError:
        return False, "rclone no esta instalado en el contenedor (reconstruya la imagen)."


def upload_dir(db, dest, local_dir: Path, remote_sub: str) -> tuple[bool, str]:
    """Copia la carpeta de una cadena (solo lo que falte o cambie) y
    verifica despues contra el destino: check compara hashes/tamanos;
    con cifrado se usa cryptcheck, que verifica el contenido cifrado."""
    try:
        with RcloneSession(dest) as s:
            target = s.path(remote_sub)
            r = s.run(["copy", str(local_dir), target], timeout=LONG_TIMEOUT)
            if r.returncode != 0:
                return False, "Fallo la subida: " + _err(r)
            verb = "cryptcheck" if dest.encrypt else "check"
            v = s.run([verb, str(local_dir), target, "--one-way"], timeout=LONG_TIMEOUT)
            if v.returncode != 0:
                return False, "Subido pero la verificacion encontro diferencias: " + _err(v)
        persist_new_token(db, dest, s)
        return True, f"Subido y verificado ({verb})."
    except RcloneError as e:
        return False, str(e)
    except subprocess.TimeoutExpired:
        return False, "Tiempo de espera agotado subiendo."


def purge(db, dest, remote_sub: str) -> tuple[bool, str]:
    try:
        with RcloneSession(dest) as s:
            r = s.run(["purge", s.path(remote_sub)], timeout=1800)
        persist_new_token(db, dest, s)
        if r.returncode != 0 and "directory not found" not in (r.stderr or "").lower():
            return False, _err(r)
        return True, "borrado"
    except (RcloneError, subprocess.TimeoutExpired) as e:
        return False, str(e)
