"""Demo helpers for the mock prototype ("Reset demo" link on the login screen)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.mock_seed import reset_and_seed
from app.schemas import ResetOut
from config import MOCK

router = APIRouter(prefix="/dev", tags=["dev"])


@router.post("/reset", response_model=ResetOut)
def reset_demo(db: Session = Depends(get_db)) -> ResetOut:
    """Wipe the database and uploads, then reload backend/mock/seed.json. 404 when MOCK.enabled is off."""
    if not MOCK.enabled:
        raise HTTPException(status_code=404, detail="Demo reset is only available in mock mode")
    counts = reset_and_seed(db)
    return ResetOut(
        reports=counts.reports, flight_plans=counts.flight_plans, missions=counts.missions, reset_at=counts.reset_at
    )
