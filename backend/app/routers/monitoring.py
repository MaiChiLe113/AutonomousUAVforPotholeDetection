"""Monitoring signals and drift report. Owner: Chi (SCRUM-36)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Detection, Mission, MissionState, Report, ReportStatus
from app.routers.common import sync_active_missions
from app.schemas import MetricsOut
from config import MOCK, MONITOR, PATHS

router = APIRouter(prefix="/monitoring", tags=["monitoring"])


def _rate(hits: int, total: int) -> float | None:
    return round(hits / total, 3) if total else None


@router.get("/metrics", response_model=MetricsOut)
def metrics(db: Session = Depends(get_db)) -> MetricsOut:
    """Correction rate, UAV agreement, mean confidence per class, active triggers (§3.3). SCRUM-36.

    Prototype: simple counts from the database. correction_rate = flagged / all server boxes (last
    MONITOR.corrections_window); uav_agreement_rate = confirmed / finished missions (last MONITOR.uav_window)."""
    sync_active_missions(db)
    reports_total = db.scalar(select(func.count(Report.id))) or 0

    recent_flags = db.scalars(
        select(Detection.flagged_wrong)
        .where(Detection.source == "server")
        .order_by(Detection.id.desc())
        .limit(MONITOR.corrections_window)
    ).all()
    correction_rate = _rate(sum(1 for f in recent_flags if f), len(recent_flags))

    recent_results = db.scalars(
        select(Report.status)
        .join(Mission, Mission.report_id == Report.id)
        .where(Mission.state == MissionState.done)
        .order_by(Mission.finished_at.desc(), Mission.id.desc())
        .limit(MONITOR.uav_window)
    ).all()
    agreement = _rate(sum(1 for s in recent_results if s == ReportStatus.confirmed), len(recent_results))

    mean_conf = {
        cls: round(float(avg), 3)
        for cls, avg in db.execute(
            select(Detection.cls, func.avg(Detection.confidence))
            .where(Detection.source == "server")
            .group_by(Detection.cls)
            .order_by(Detection.cls)
        ).all()
    }
    model_version = db.scalars(
        select(Detection.model_version).where(Detection.source == "server").order_by(Detection.id.desc()).limit(1)
    ).first()

    triggers = []
    if correction_rate is not None and correction_rate > MONITOR.corrections_rate:
        triggers.append(f"corrections rate {correction_rate:.0%} > {MONITOR.corrections_rate:.0%}")
    if agreement is not None and 1 - agreement > MONITOR.uav_disagree_rate:
        triggers.append(f"UAV disagreement {1 - agreement:.0%} > {MONITOR.uav_disagree_rate:.0%}")

    return MetricsOut(
        reports_total=reports_total,
        correction_rate=correction_rate,
        uav_agreement_rate=agreement,
        mean_confidence_by_class=mean_conf,
        model_version=model_version,
        retrain_triggers=triggers,
    )


@router.get("/drift-report")
def drift_report() -> FileResponse:
    """Latest Evidently HTML report written by run/drift_report.py (SCRUM-36).
    Mock prototype: always 404 (no drift job runs)."""
    if MOCK.enabled:
        raise HTTPException(status_code=404, detail="Drift report not available in the mock prototype")
    reports = []
    if PATHS.reports_dir.exists():
        reports = sorted(PATHS.reports_dir.glob("*drift*.html"), key=lambda p: p.stat().st_mtime)
    if not reports:
        raise HTTPException(status_code=404, detail="No drift report yet: run python -m run.drift_report --recent DIR")
    return FileResponse(reports[-1], media_type="text/html")
