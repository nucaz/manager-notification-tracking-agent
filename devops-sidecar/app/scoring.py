"""Leaderboard: puntaje simple y ajustable por desarrollador. v1 -
pensado para poder retocar las constantes de abajo sin tocar la logica.

commits: se premian de lleno (10 pts c/u) porque representan trabajo
terminado/entregado, la unidad mas confiable de "hizo algo".
lineas agregadas: puntaje bajo (0.05) - mas lineas no es necesariamente
mejor trabajo, solo se cuenta como señal secundaria de volumen.
lineas eliminadas: puntaje un poco mas alto que las agregadas (0.1) -
un buen refactor que borra codigo muerto/duplicado es tan valioso (o
mas) que agregar codigo nuevo, y no se quiere desincentivar limpiar.
"""
from datetime import date, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from . import models

POINTS_PER_COMMIT = 10
POINTS_PER_LINE_ADDED = 0.05
POINTS_PER_LINE_DELETED = 0.1

PERIODS = ("day", "week", "month", "year", "all")


def _since_for_period(period: str) -> date:
    today = date.today()
    if period == "day":
        return today
    if period == "week":
        return today - timedelta(days=today.weekday())
    if period == "month":
        return today.replace(day=1)
    if period == "year":
        return today.replace(month=1, day=1)
    return date(2000, 1, 1)  # "all"


def leaderboard(db: Session, period: str = "week", repo_id: int | None = None) -> list[dict]:
    since = _since_for_period(period)
    query = (
        db.query(
            models.CommitStat.author,
            func.sum(models.CommitStat.commits_count).label("commits"),
            func.sum(models.CommitStat.lines_added).label("added"),
            func.sum(models.CommitStat.lines_deleted).label("deleted"),
        )
        .filter(models.CommitStat.commit_date >= since)
    )
    if repo_id:
        query = query.filter(models.CommitStat.repo_id == repo_id)
    rows = query.group_by(models.CommitStat.author).all()

    result = []
    for author, commits, added, deleted in rows:
        commits = commits or 0
        added = added or 0
        deleted = deleted or 0
        score = commits * POINTS_PER_COMMIT + added * POINTS_PER_LINE_ADDED + deleted * POINTS_PER_LINE_DELETED
        result.append(
            {
                "author": author,
                "commits": commits,
                "lines_added": added,
                "lines_deleted": deleted,
                "score": round(score, 1),
            }
        )
    result.sort(key=lambda r: r["score"], reverse=True)
    return result
