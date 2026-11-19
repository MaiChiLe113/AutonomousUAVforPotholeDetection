"""Detection results and "wrong detection" flags. Owner: Hai / Chi (SCRUM-29, SCRUM-37)."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Detection, Report
from app.routers.auth import require_monitor
from app.routers.common import get_or_404
from app.schemas import DetectionOut, FlagIn

router = APIRouter(tags=["detections"])


@router.get("/reports/{report_id}/detections", response_model=list[DetectionOut])
def list_detections(report_id: int, db: Session = Depends(get_db)) -> list[Detection]:
    """Server pre-check boxes of one report (SCRUM-29). Edge boxes: GET /missions/{id}/detections."""
    get_or_404(db, Report, report_id, "Report")
    return list(db.scalars(select(Detection).where(Detection.report_id == report_id).order_by(Detection.id)).all())


@router.post("/detections/{detection_id}/flag", response_model=DetectionOut, dependencies=[Depends(require_monitor)])
def flag_detection(detection_id: int, body: FlagIn, db: Session = Depends(get_db)) -> Detection:
    """Mark as wrong; feeds the corrections-rate retraining trigger (§3.2). SCRUM-37."""
    detection = get_or_404(db, Detection, detection_id, "Detection")
    detection.flagged_wrong = True
    detection.flag_note = (body.note or "").strip() or None
    db.commit()
    db.refresh(detection)
    return detection
