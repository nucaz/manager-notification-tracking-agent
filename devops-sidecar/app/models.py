from datetime import datetime, date
from sqlalchemy import (
    Column, Integer, String, Text, Boolean, Date, DateTime, ForeignKey, UniqueConstraint
)
from sqlalchemy.orm import relationship
from .database import Base


class Repo(Base):
    """Un repositorio de GitHub que este modulo debe clonar/sincronizar y
    auditar. local_path se calcula como repos_base_path/name al crearlo."""
    __tablename__ = "repos"

    id = Column(Integer, primary_key=True)
    name = Column(String(120), unique=True, nullable=False)
    github_url = Column(String(500), nullable=False)
    # PAT de GitHub para repos privados, cifrado con crypto_service
    # (enc:v1:...). Leerlo siempre con git_service.repo_token(); git lo
    # recibe por cabecera, nunca dentro de la URL (ver git_service.auth_env).
    github_token = Column(String(255), nullable=True)
    local_path = Column(String(500), nullable=False)
    sync_interval_minutes = Column(Integer, nullable=False, default=60)
    active = Column(Boolean, nullable=False, default=True)
    last_synced_at = Column(DateTime, nullable=True)
    last_sync_status = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    commit_stats = relationship("CommitStat", back_populates="repo", cascade="all, delete-orphan")
    audit_reports = relationship("AuditReport", back_populates="repo", cascade="all, delete-orphan")
    backup_runs = relationship("BackupRun", back_populates="repo", cascade="all, delete-orphan")
    git_targets = relationship("GitTarget", back_populates="repo", cascade="all, delete-orphan")


class AppSetting(Base):
    """Configuracion editable desde el dashboard (proveedor de IA activo y
    sus credenciales/modelos) que sobreescribe los valores por defecto de
    .env en app/config.py - asi un cambio se aplica sin reiniciar el
    contenedor. Ver services/settings_store.py."""
    __tablename__ = "app_settings"

    key = Column(String(100), primary_key=True)
    value = Column(Text, nullable=True)


class Deployment(Base):
    """Un evento de despliegue recibido via webhook. Se guarda el payload
    completo tal cual llego (raw_payload), ademas de los campos ya
    interpretados. El mapeo de campos abajo esta verificado contra el
    codigo fuente real de Coolify (toWebhook() en
    app/Notifications/Application/DeploymentSuccess.php y
    DeploymentFailed.php del repo coollabsio/coolify) - Coolify NO manda
    commit ni autor del push, por eso esos dos campos quedan casi siempre
    vacios con Coolify real (se dejan por si algun dia otro emisor de
    webhooks los manda)."""
    __tablename__ = "deployments"

    id = Column(Integer, primary_key=True)
    project = Column(String(200), nullable=True)
    application_name = Column(String(200), nullable=True)
    commit_sha = Column(String(64), nullable=True)
    author = Column(String(200), nullable=True)
    environment = Column(String(100), nullable=True)
    status = Column(String(50), nullable=True)
    deployment_url = Column(String(500), nullable=True)
    raw_payload = Column(Text, nullable=True)
    received_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class CommitStat(Base):
    """Commits/lineas por autor y por dia, para el dashboard y el
    leaderboard. Una fila por (repo, autor, dia) - se va acumulando cada
    vez que corre la sincronizacion/auditoria diaria."""
    __tablename__ = "commit_stats"
    __table_args__ = (UniqueConstraint("repo_id", "author", "commit_date", name="uq_commit_stat"),)

    id = Column(Integer, primary_key=True)
    repo_id = Column(Integer, ForeignKey("repos.id", ondelete="CASCADE"), nullable=False)
    author = Column(String(200), nullable=False)
    commit_date = Column(Date, nullable=False, default=date.today)
    commits_count = Column(Integer, nullable=False, default=0)
    lines_added = Column(Integer, nullable=False, default=0)
    lines_deleted = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    repo = relationship("Repo", back_populates="commit_stats")


class AuditReport(Base):
    """El reporte de auditoria semantica generado por IA para un repo en
    un dia dado, mas las alertas del escaneo de secretos (deterministico,
    sin IA - ver services/secret_scanner.py)."""
    __tablename__ = "audit_reports"

    id = Column(Integer, primary_key=True)
    repo_id = Column(Integer, ForeignKey("repos.id", ondelete="CASCADE"), nullable=False)
    report_date = Column(Date, nullable=False, default=date.today)
    report_markdown = Column(Text, nullable=False)
    secret_alerts_json = Column(Text, nullable=True)
    ai_provider_used = Column(String(50), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    repo = relationship("Repo", back_populates="audit_reports")


class CommitSummary(Base):
    """Cache del resumen itemizado de UN commit especifico, generado por
    IA a pedido (boton 'Resumir con IA' en la vista de un commit) - se
    guarda para no volver a pagar/esperar la llamada a la IA si alguien
    vuelve a pedir el mismo commit."""
    __tablename__ = "commit_summaries"
    __table_args__ = (UniqueConstraint("repo_id", "commit_sha", name="uq_commit_summary"),)

    id = Column(Integer, primary_key=True)
    repo_id = Column(Integer, ForeignKey("repos.id", ondelete="CASCADE"), nullable=False)
    commit_sha = Column(String(40), nullable=False)
    summary_markdown = Column(Text, nullable=False)
    ai_provider_used = Column(String(50), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class BackupRun(Base):
    """Registro de cada respaldo generado (diferencial diario o mirror
    semanal comprimido), para poder listarlos/auditarlos desde el
    dashboard sin tener que leer el disco directamente."""
    __tablename__ = "backup_runs"

    id = Column(Integer, primary_key=True)
    repo_id = Column(Integer, ForeignKey("repos.id", ondelete="CASCADE"), nullable=False)
    backup_type = Column(String(20), nullable=False)  # 'daily_diff' | 'weekly_mirror'
    file_path = Column(String(500), nullable=False)
    size_bytes = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    repo = relationship("Repo", back_populates="backup_runs")


# ---------------------------------------------------------------------------
# Respaldos externos y trabajos programados (estilo Veeam)
# ---------------------------------------------------------------------------
class BackupDestination(Base):
    """Un destino externo de respaldos: una cuenta + una carpeta. Puede
    haber varios del mismo tipo (ej. dos OneDrive M365 y uno personal).
    Toda la configuracion del proveedor (tokens, claves, contrasenas) va
    en config_enc como JSON cifrado con crypto_service - nunca se devuelve
    al navegador. Ver services/rclone_service.py."""
    __tablename__ = "backup_destinations"

    id = Column(Integer, primary_key=True)
    name = Column(String(120), unique=True, nullable=False)
    # onedrive | gdrive | s3 | sftp | smb | webdav | local
    kind = Column(String(20), nullable=False)
    config_enc = Column(Text, nullable=False)
    # Carpeta dentro del destino (en S3: "bucket/carpeta").
    remote_path = Column(String(500), nullable=False, default="devops-sidecar")
    # Cifrado del lado del cliente con rclone crypt (contenido y nombres).
    # La contrasena va dentro de config_enc.
    encrypt = Column(Boolean, nullable=False, default=False)
    enabled = Column(Boolean, nullable=False, default=True)
    account_label = Column(String(200), nullable=True)  # ej. correo de la cuenta, para mostrar
    last_test_at = Column(DateTime, nullable=True)
    last_test_ok = Column(Boolean, nullable=True)
    last_test_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class ExternalSource(Base):
    """Sistema externo que se respalda (solo lectura): una base MySQL/
    MariaDB, PostgreSQL o Azure SQL, o un sitio WordPress en un hosting.
    Conexion y contrasenas en config_enc (JSON cifrado). folder_key es su
    carpeta dentro de cada trabajo y no cambia al renombrarlo. Ver
    services/external_sources.py."""
    __tablename__ = "external_sources"

    id = Column(Integer, primary_key=True)
    name = Column(String(120), unique=True, nullable=False)
    kind = Column(String(20), nullable=False)  # mysql | postgres | mssql | wordpress
    folder_key = Column(String(80), unique=True, nullable=False)
    config_enc = Column(Text, nullable=False)
    enabled = Column(Boolean, nullable=False, default=True)
    last_test_at = Column(DateTime, nullable=True)
    last_test_ok = Column(Boolean, nullable=True)
    last_test_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class BackupJob(Base):
    """Trabajo de respaldo programado: que se respalda, cuando, adonde y
    con que politica de cadena/retencion. Cada (trabajo, repositorio)
    forma cadenas: un completo seguido de hasta `incrementals_per_full`
    incrementales; la retencion borra cadenas enteras, nunca un completo
    del que dependan incrementales."""
    __tablename__ = "backup_jobs"

    id = Column(Integer, primary_key=True)
    name = Column(String(120), unique=True, nullable=False)
    enabled = Column(Boolean, nullable=False, default=True)
    # JSON: lista de ids de repos; vacia = todos los repos activos.
    repo_ids_json = Column(Text, nullable=False, default="[]")
    include_bundle = Column(Boolean, nullable=False, default=True)    # git bundle (historial completo / incremental)
    include_content = Column(Boolean, nullable=False, default=False)  # archivos sin .git (solo en completos)
    include_diff = Column(Boolean, nullable=False, default=True)      # .diff legible de los cambios
    include_sidecar_db = Column(Boolean, nullable=False, default=True)
    # False = el trabajo no respalda repositorios (ej. solo la aplicacion).
    include_repos = Column(Boolean, nullable=False, default=True)
    # Respaldo completo de la aplicacion principal (base, archivos y .env
    # cifrados): lo genera la app (/interno/respaldo/generar), aqui se guarda
    # en cadenas y se envia a los destinos. Ver backup_jobs.create_app_point.
    include_main_app = Column(Boolean, nullable=False, default=False)
    # daily | weekly | monthly | cron
    frequency = Column(String(10), nullable=False, default="daily")
    hour = Column(Integer, nullable=False, default=2)
    minute = Column(Integer, nullable=False, default=0)
    day_of_week = Column(String(3), nullable=False, default="sun")
    day_of_month = Column(Integer, nullable=False, default=1)
    cron_expr = Column(String(100), nullable=True)
    incrementals_per_full = Column(Integer, nullable=False, default=6)
    keep_chains_local = Column(Integer, nullable=False, default=2)
    keep_chains_remote = Column(Integer, nullable=False, default=4)
    # JSON: lista de ids de BackupDestination.
    destination_ids_json = Column(Text, nullable=False, default="[]")
    # JSON: lista de ids de ExternalSource (bases en Azure, sitios WordPress).
    source_ids_json = Column(Text, nullable=False, default="[]")
    last_run_at = Column(DateTime, nullable=True)
    last_status = Column(String(30), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    points = relationship("BackupPoint", back_populates="job", cascade="all, delete-orphan")
    runs = relationship("BackupJobRun", back_populates="job", cascade="all, delete-orphan")


class BackupJobRun(Base):
    """Una ejecucion de un trabajo (programada o manual), con su resumen."""
    __tablename__ = "backup_job_runs"

    id = Column(Integer, primary_key=True)
    job_id = Column(Integer, ForeignKey("backup_jobs.id", ondelete="CASCADE"), nullable=False)
    trigger = Column(String(20), nullable=False, default="programado")  # programado | manual
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    finished_at = Column(DateTime, nullable=True)
    # en_curso | ok | ok_con_avisos | error
    status = Column(String(20), nullable=False, default="en_curso")
    log = Column(Text, nullable=True)

    job = relationship("BackupJob", back_populates="runs")


class BackupPoint(Base):
    """Punto de restauracion: un completo (seq 0) o un incremental (seq
    1..n) de un repo dentro de una cadena. repo_id NULL = copia de la base
    del propio sidecar. files_json: [{name, path, size, sha256}]."""
    __tablename__ = "backup_points"

    id = Column(Integer, primary_key=True)
    job_id = Column(Integer, ForeignKey("backup_jobs.id", ondelete="CASCADE"), nullable=False)
    run_id = Column(Integer, ForeignKey("backup_job_runs.id", ondelete="SET NULL"), nullable=True)
    repo_id = Column(Integer, ForeignKey("repos.id", ondelete="SET NULL"), nullable=True)
    repo_name = Column(String(200), nullable=False)  # se conserva aunque se borre el repo
    kind = Column(String(12), nullable=False)  # full | incremental
    chain_id = Column(Integer, nullable=True)  # id del punto completo que inicia la cadena
    seq = Column(Integer, nullable=False, default=0)
    chain_label = Column(String(60), nullable=False)  # carpeta de la cadena (local y remota)
    files_json = Column(Text, nullable=False, default="[]")
    # Puntas de todas las referencias al crear el punto: el siguiente
    # incremental incluye solo los commits nuevos desde aqui.
    refs_json = Column(Text, nullable=True)
    total_bytes = Column(Integer, nullable=False, default=0)
    local_deleted = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    job = relationship("BackupJob", back_populates="points")
    transfers = relationship("BackupTransfer", back_populates="point", cascade="all, delete-orphan")


class BackupTransfer(Base):
    """Envio de un punto a un destino externo, con su verificacion."""
    __tablename__ = "backup_transfers"

    id = Column(Integer, primary_key=True)
    point_id = Column(Integer, ForeignKey("backup_points.id", ondelete="CASCADE"), nullable=False)
    destination_id = Column(Integer, ForeignKey("backup_destinations.id", ondelete="CASCADE"), nullable=False)
    # ok | error | borrado
    status = Column(String(12), nullable=False)
    remote_path = Column(String(500), nullable=True)
    bytes = Column(Integer, nullable=False, default=0)
    verified = Column(Boolean, nullable=False, default=False)
    message = Column(Text, nullable=True)
    finished_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    point = relationship("BackupPoint", back_populates="transfers")
    destination = relationship("BackupDestination")


# ---------------------------------------------------------------------------
# Git: mirror de respaldo a otro servidor y colaborador -> principal
# ---------------------------------------------------------------------------
class GitTarget(Base):
    """Otro repositorio Git relacionado con un repo registrado:
    - purpose='mirror': copia de respaldo en OTRO repositorio (GitHub,
      GitLab, Azure DevOps, Gitea o un repo bare en un disco montado).
    - purpose='upstream': el repositorio PRINCIPAL al que una cuenta
      colaboradora sube sus cambios (a una rama + Pull Request, o directo
      solo si es avance rapido). Nunca se fuerza ni se usa --mirror aqui.
    El token va cifrado (crypto_service) y git lo recibe por cabecera."""
    __tablename__ = "git_targets"

    id = Column(Integer, primary_key=True)
    repo_id = Column(Integer, ForeignKey("repos.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(120), nullable=False)
    purpose = Column(String(10), nullable=False)  # mirror | upstream
    url = Column(String(500), nullable=False)
    auth_user = Column(String(120), nullable=True)
    token_enc = Column(Text, nullable=True)
    # mirror: exacto (--mirror, borra/fuerza como el origen) | protegido (solo agrega)
    mirror_mode = Column(String(10), nullable=False, default="protegido")
    # upstream: rama del colaborador (vacia = la rama por defecto) y rama del principal
    source_branch = Column(String(200), nullable=True)
    base_branch = Column(String(200), nullable=True)
    push_mode = Column(String(10), nullable=False, default="pr")  # pr | directo
    schedule = Column(String(12), nullable=False, default="manual")  # manual | after_sync
    enabled = Column(Boolean, nullable=False, default=True)
    last_run_at = Column(DateTime, nullable=True)
    last_status = Column(String(12), nullable=True)  # ok | aviso | error
    last_message = Column(Text, nullable=True)
    last_pr_url = Column(String(500), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    repo = relationship("Repo", back_populates="git_targets")
    runs = relationship("GitTargetRun", back_populates="target", cascade="all, delete-orphan")


class GitTargetRun(Base):
    __tablename__ = "git_target_runs"

    id = Column(Integer, primary_key=True)
    target_id = Column(Integer, ForeignKey("git_targets.id", ondelete="CASCADE"), nullable=False)
    trigger = Column(String(20), nullable=False, default="manual")  # manual | tras_sync
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    finished_at = Column(DateTime, nullable=True)
    status = Column(String(12), nullable=False, default="en_curso")  # en_curso | ok | aviso | error
    log = Column(Text, nullable=True)

    target = relationship("GitTarget", back_populates="runs")


# ---------------------------------------------------------------------------
# Restauraciones (desde el servidor o desde un destino externo)
# ---------------------------------------------------------------------------
class RestoreRun(Base):
    """Una restauracion o prueba de restauracion. Trabaja con la carpeta
    de la cadena y su manifest.json, no con las filas de BackupPoint: asi
    tambien sirve cuando se perdio el servidor y solo queda el destino
    externo. Los archivos generados viven en backups_path/restores/<id>."""
    __tablename__ = "restore_runs"

    id = Column(Integer, primary_key=True)
    destination_id = Column(Integer, ForeignKey("backup_destinations.id", ondelete="SET NULL"), nullable=True)
    source_label = Column(String(200), nullable=False)  # "Servidor" o el nombre del destino
    chain_path = Column(String(500), nullable=False)  # trabajo/repo/cadena
    repo_name = Column(String(200), nullable=False)
    seq = Column(Integer, nullable=False, default=0)
    mode = Column(String(12), nullable=False)  # verificar | descargar | subir
    status = Column(String(12), nullable=False, default="en_curso")  # en_curso | ok | error
    log = Column(Text, nullable=True)
    outputs_json = Column(Text, nullable=False, default="[]")  # [{name, size}]
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    finished_at = Column(DateTime, nullable=True)
