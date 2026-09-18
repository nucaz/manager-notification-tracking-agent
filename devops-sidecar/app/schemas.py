from datetime import date, datetime

from pydantic import BaseModel, Field


class RepoCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    github_url: str = Field(min_length=1, max_length=500)
    github_token: str | None = None
    sync_interval_minutes: int = Field(default=60, ge=5, le=10080)


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
