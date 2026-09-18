from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import models, schemas
from ..auth import require_dashboard_auth
from ..database import get_db

router = APIRouter(prefix="/api/deployments", tags=["deployments"], dependencies=[Depends(require_dashboard_auth)])


@router.get("", response_model=list[schemas.DeploymentOut])
def list_deployments(limit: int = 100, db: Session = Depends(get_db)):
    return (
        db.query(models.Deployment)
        .order_by(models.Deployment.received_at.desc())
        .limit(min(limit, 500))
        .all()
    )
