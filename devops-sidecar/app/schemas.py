from datetime import date, datetime

import re

from pydantic import BaseModel, Field, field_validator

# El nombre se usa como carpeta del clon (repos_base_path/nombre): solo letras,
# numeros, espacio, punto, guion y guion bajo; nunca una ruta.
REPO_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$")
# La URL va como argumento de git: https, ssh, usuario@servidor:ruta o una ruta
# absoluta del servidor (repositorios locales y pruebas), sin
# espacios y sin empezar con un guion (git lo tomaria como una opcion).
REPO_URL = re.compile(r"^(https?://|ssh://|file://|/|[A-Za-z0-9._-]+@)[^\s]+$")


def repo_name_from(text: str) -> str:
    """'https://github.com/org/mi-repo.git' -> 'mi-repo'; un nombre normal queda igual."""
    value = (text or "").strip()
    if "/" in value or value.lower().endswith(".git"):
        value = value.rstrip("/").split("/")[-1].split(":")[-1]
        if value.lower().endswith(".git"):
            value = value[:-4]
    return value.strip()


class RepoCreate(BaseModel):
    name: str = Field(default="", max_length=500)
    github_url: str = Field(min_length=1, max_length=500)
    github_token: str | None = None
    sync_interval_minutes: int = Field(default=60, ge=5, le=10080)

    @field_validator("github_url")
    @classmethod
    def _url(cls, v: str) -> str:
        v = (v or "").strip()
        if not REPO_URL.match(v):
            raise ValueError("La URL del repositorio no es válida: debe ser como https://github.com/organizacion/repositorio.git")
        return v

    @field_validator("github_token")
    @classmethod
    def _token(cls, v: str | None) -> str | None:
        v = (v or "").strip()
        return v or None

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        return repo_name_from(v)

    def resolved_name(self) -> str:
        """El nombre dado o, si falta o era una URL, el del repositorio."""
        name = self.name or repo_name_from(self.github_url)
        if not REPO_NAME.match(name) or ".." in name:
            raise ValueError(
                f'El nombre "{name}" no sirve como identificador: use letras, números, espacios, punto, guion o guion bajo (máximo 120).'
            )
        return name


class RepoOut(BaseModel):
    id: int
    name: str
    github_url: str
    local_path: str
    sync_interval_minutes: int
    active: bool
    last_synced_at: datetime | None
    last_sync_status: str | None

    class Config:
        from_attributes = True


class DeploymentOut(BaseModel):
    id: int
    project: str | None
    commit_sha: str | None
    author: str | None
    environment: str | None
    status: str | None
    received_at: datetime

    class Config:
        from_attributes = True


class LeaderboardRow(BaseModel):
    author: str
    commits: int
    lines_added: int
    lines_deleted: int
    score: float


class AuditReportOut(BaseModel):
    id: int
    repo_id: int
    report_date: date
    ai_provider_used: str | None
    created_at: datetime

    class Config:
        from_attributes = True
