from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from .config import settings

Path(settings.database_path).parent.mkdir(parents=True, exist_ok=True)

engine = create_engine(
    f"sqlite:///{settings.database_path}",
    connect_args={"check_same_thread": False},
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# Columnas agregadas despues de crear la tabla (create_all no las agrega).
_ADDED_COLUMNS = {
    "backup_jobs": [
        ("include_repos", "BOOLEAN NOT NULL DEFAULT 1"),
        ("include_main_app", "BOOLEAN NOT NULL DEFAULT 0"),
        ("source_ids_json", "TEXT NOT NULL DEFAULT '[]'"),
    ],
}


def init_db():
    from . import models  # noqa: F401 (registra los modelos en Base antes de crear tablas)
    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        for table, cols in _ADDED_COLUMNS.items():
            have = {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")}
            for name, ddl in cols:
                if name not in have:
                    conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
