"""Resident reports and admin review. Owner: Chi (SCRUM-23, SCRUM-30, SCRUM-45)."""

from __future__ import annotations

import mimetypes

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Detection, PlanStatus, Report, ReportStatus
from app.routers import todo
from app.routers.auth import require_monitor
from app.routers.common import conflict, get_or_404, now_utc, sync_active_missions
from app.schemas import ReportOut, ReportReview
from app.services.dispatcher import enqueue_report
from app.services.flight_planner import OutOfServiceAreaError
from app.services.mock_detector import MockDetector
from app.services.safety import log_decision
from config import API, MOCK, PATHS

router = APIRouter(prefix="/reports", tags=["reports"])

# File signatures for the allowed upload types; a type without an entry here is not content-checked.
_MAGIC = {"image/jpeg": b"\xff\xd8\xff", "image/png": b"\x89PNG\r\n\x1a\n"}


def _detector(request: Request):
    """The detector built at startup (MockDetector while MOCK.enabled); 501 until the real one exists."""
    detector = getattr(request.app.state, "detector", None)
    if detector is None:
        if not MOCK.enabled:
            raise todo("SCRUM-29 load the server detector")
        detector = request.app.state.detector = MockDetector()
    return detector


def _read_upload(photo: UploadFile) -> bytes:
    """Validate type (415) and size (413) with config.API; returns the file bytes."""
    content_type = (photo.content_type or "").split(";")[0].strip().lower()
    if content_type not in API.allowed_types:
        allowed = ", ".join(API.allowed_types)
        raise HTTPException(status_code=415, detail=f"Photo must be one of: {allowed} (got {content_type or 'none'})")
    limit = API.max_upload_mb * 1024 * 1024
    data = photo.file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(status_code=413, detail=f"Photo is larger than {API.max_upload_mb} MB")
    if not data:
        raise HTTPException(status_code=422, detail="Photo is empty")
    magic = _MAGIC.get(content_type)
    if magic and not data.startswith(magic):
        raise HTTPException(status_code=415, detail=f"Photo content is not a valid {content_type} file")
    return data


@router.post("", response_model=ReportOut, status_code=201)
def create_report(
    request: Request,
    lat: float = Form(..., ge=-90, le=90),
    lon: float = Form(..., ge=-180, le=180),
    photo: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> Report:
    """Save photo + coordinates as one report, run the AI pre-check (services.detector),
    store detections, set status to under_review or no_damage.
    Validate type in config.API.allowed_types and size <= config.API.max_upload_mb.
    SCRUM-23 / SCRUM-30."""
    data = _read_upload(photo)
    content_type = (photo.content_type or "").split(";")[0].strip().lower()
    ext = mimetypes.guess_extension(content_type) or ""

    report = Report(lat=lat, lon=lon, photo_path="", status=ReportStatus.submitted)
    db.add(report)
    db.flush()  # assigns report.id

    folder = PATHS.media_dir / MOCK.upload_subdir
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"report-{report.id}{ext}"
    path.write_bytes(data)
    report.photo_path = f"{MOCK.upload_subdir}/{path.name}"

    detector = _detector(request)
    deployment = getattr(detector, "deployment", "server")
    for r in detector.predict(path, frame_id=f"report-{report.id}"):
        db.add(
            Detection(
                report_id=report.id,
                source="server",
                deployment=deployment,
                cls=r.cls,
                confidence=r.confidence,
                box_xyxy=list(r.box_xyxy),
                frame_id=r.frame_id,
                model_version=r.model_version,
            )
        )
    db.flush()
    db.refresh(report)
    report.status = ReportStatus.under_review if report.detections else ReportStatus.no_damage
    db.commit()
    db.refresh(report)
    return report


@router.get("", response_model=list[ReportOut])
def list_reports(status: ReportStatus | None = None, db: Session = Depends(get_db)) -> list[Report]:
    """Report queue for the monitor, newest first, optional status filter. SCRUM-23."""
    sync_active_missions(db)
    query = select(Report).order_by(Report.created_at.desc(), Report.id.desc())
    if status is not None:
        query = query.where(Report.status == status)
    return list(db.scalars(query).all())


@router.get("/{report_id}", response_model=ReportOut)
def get_report(report_id: int, db: Session = Depends(get_db)) -> Report:
    """One report with its detections (also used by the resident status page, SCRUM-45). SCRUM-23."""
    sync_active_missions(db)
    return get_or_404(db, Report, report_id, "Report")


@router.patch("/{report_id}/review", response_model=ReportOut, dependencies=[Depends(require_monitor)])
def review_report(report_id: int, body: ReportReview, db: Session = Depends(get_db)) -> Report:
    """Admin confirms (-> inspection queue) or rejects the report. SCRUM-29. Monitor role only.

    Confirm keeps the report under_review and queues it (services.dispatcher.enqueue_report): a drone takes
    it automatically as soon as the safety gate says go, otherwise the task is held with a reason.
    Reject needs a note (422 without one) and closes the report as rejected."""
    report = get_or_404(db, Report, report_id, "Report")
    if report.status != ReportStatus.under_review:
        raise conflict(f"Report {report_id} is {report.status.value}; only under_review reports can be reviewed")
    note = (body.note or "").strip() or None
    if not body.confirmed:
        if note is None:
            raise HTTPException(status_code=422, detail="A reason is required to reject a report")
        if any(p.status == PlanStatus.approved for p in report.flight_plans):
            raise conflict(f"Report {report_id} already has an approved flight plan; it can no longer be rejected")
        report.status = ReportStatus.rejected
        for plan in report.flight_plans:
            if plan.status == PlanStatus.proposed:  # no flight for a rejected report
                plan.status = PlanStatus.rejected
                plan.decision_reason = f"Report rejected: {note}"
                plan.decided_at = now_utc()
    report.review_note = note
    db.commit()
    if body.confirmed:
        try:
            enqueue_report(db, report)
        except OutOfServiceAreaError as exc:  # confirmed, but no drone may fly there: leave a trace for the monitor
            log_decision(db, "hold", "out_of_area", str(exc), at=now_utc(), report_id=report.id)
            db.commit()
    db.refresh(report)
    return report
