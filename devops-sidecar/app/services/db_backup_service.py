"""Respaldo y restauracion de la base de datos PROPIA de DevOps Sidecar
(sidecar.db, SQLite) - no confundir con el modulo "Respaldos" del sidebar,
que respalda los REPOSITORIOS de GitHub que se auditan. Esto es para
poder migrar TODA la configuracion (repos registrados, proveedor de IA,
historial de despliegues/auditorias) a otro servidor que ya tenga la app
y Docker instalados, sin tener que rehacerla a mano.

Usa la API de backup nativa de sqlite3 (Connection.backup()) en vez de
copiar el archivo con shutil.copy() - es segura incluso con la app
corriendo y escribiendo al mismo tiempo (nunca captura un archivo a
medio escribir).
"""
import shutil
import sqlite3
import tarfile
import tempfile
from datetime import datetime
from pathlib import Path

from ..config import settings
from ..database import engine

PRE_RESTORE_DIR = Path(settings.backups_path) / "_pre_restore_sidecar"
REQUIRED_TABLES = {"repos", "app_settings"}


def _sqlite_backup_to(dest_path: Path) -> None:
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(settings.database_path)
    dest = sqlite3.connect(str(dest_path))
    try:
        source.backup(dest)
    finally:
        dest.close()
        source.close()


def create_backup_archive() -> Path:
    """Genera un .tar.gz con una copia consistente de sidecar.db + un
    manifiesto de texto. Devuelve la ruta al archivo temporal (el
    llamador lo borra despues de servirlo por HTTP)."""
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    tmp_dir = Path(tempfile.mkdtemp(prefix="sidecar_backup_"))
    db_copy = tmp_dir / "sidecar.db"
    _sqlite_backup_to(db_copy)

    manifest = tmp_dir / "manifest.txt"
    manifest.write_text(
        "Respaldo de configuracion de DevOps Sidecar\n"
        f"Generado: {datetime.now().isoformat()}\n\n"
        "Para restaurar en otro servidor:\n"
        "1. Sube este archivo desde Configuracion -> Restaurar.\n"
        "2. IMPORTANTE: si el servidor de origen tenia CREDENTIALS_ENC_KEY\n"
        "   configurada, el .env del servidor NUEVO debe tener la MISMA\n"
        "   clave - si no, las API keys de IA guardadas quedan ilegibles\n"
        "   (cifradas) y hay que volver a escribirlas desde Configuracion.\n"
        "3. Los repositorios clonados y los archivos de respaldo/reportes\n"
        "   NO estan incluidos aca (son datos, no configuracion) - se\n"
        "   vuelven a sincronizar solos desde GitHub al reactivarlos.\n",
        encoding="utf-8",
    )

    archive_path = Path(tempfile.gettempdir()) / f"devops-sidecar-backup-{stamp}.tar.gz"
    with tarfile.open(archive_path, "w:gz") as tar:
        tar.add(db_copy, arcname="sidecar.db")
        tar.add(manifest, arcname="manifest.txt")
    shutil.rmtree(tmp_dir)
    return archive_path


def _validate_sqlite_db(path: Path) -> None:
    con = sqlite3.connect(str(path))
    try:
        rows = con.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        names = {r[0] for r in rows}
    finally:
        con.close()
    missing = REQUIRED_TABLES - names
    if missing:
        raise ValueError(
            f"El archivo no parece un respaldo valido de DevOps Sidecar (faltan tablas: {', '.join(sorted(missing))})."
        )


def restore_from_upload(upload_path: Path) -> str:
    """Restaura sidecar.db a partir de un .tar.gz (el que genera
    create_backup_archive) o un .db suelto. Es DESTRUCTIVO: reemplaza
    toda la configuracion actual. Antes de aplicar, guarda un snapshot
    de seguridad (con el mismo metodo de backup seguro) y devuelve su
    nombre de archivo."""
    tmp_dir = Path(tempfile.mkdtemp(prefix="sidecar_restore_"))
    try:
        if tarfile.is_tarfile(upload_path):
            with tarfile.open(upload_path) as tar:
                member = next((m for m in tar.getmembers() if m.name.endswith("sidecar.db")), None)
                if not member:
                    raise ValueError("El .tar.gz no contiene un sidecar.db - ¿es un respaldo de este mismo modulo?")
                tar.extract(member, tmp_dir, filter="data")
                new_db_path = tmp_dir / member.name
        else:
            new_db_path = upload_path

        _validate_sqlite_db(new_db_path)

        PRE_RESTORE_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        snapshot_name = f"antes_de_restaurar_{stamp}.db"
        _sqlite_backup_to(PRE_RESTORE_DIR / snapshot_name)

        # Cierra las conexiones abiertas del pool antes de reemplazar el
        # archivo - si no, alguna conexion vieja podria seguir apuntando
        # al inodo anterior hasta que se reciclara sola.
        engine.dispose()
        shutil.copy2(new_db_path, settings.database_path)

        return snapshot_name
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
