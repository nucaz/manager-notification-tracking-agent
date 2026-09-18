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
    # PAT de GitHub para repos privados. Igual que otros secretos de este
    # proyecto (ver glpi-licencias-app), se guarda en texto plano por ahora
    # - es una deuda tecnica conocida, no una omision.
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


class Deployment(Base):
    """Un evento de despliegue recibido via webhook de Coolify. Se guarda
    el payload completo tal cual llego, ademas de los campos que se
    lograron interpretar - asi no se pierde nada aunque el mapeo de
    campos no sea perfecto (ver README: pendiente de verificar contra un
    payload real de Coolify)."""
    __tablename__ = "deployments"

    id = Column(Integer, primary_key=True)
    project = Column(String(200), nullable=True)
    commit_sha = Column(String(64), nullable=True)
    author = Column(String(200), nullable=True)
    environment = Column(String(100), nullable=True)
    status = Column(String(50), nullable=True)
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
