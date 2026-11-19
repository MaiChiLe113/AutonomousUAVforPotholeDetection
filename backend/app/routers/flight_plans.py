"""Flight plan proposal and approval. Owner: Hoan (SCRUM-27, SCRUM-31). No flight without approval."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import FlightPlan, Mission, MissionState, PlanStatus, Report, ReportStatus
from app.routers.auth import require_monitor
from app.routers.common import conflict, get_or_404, now_utc
from app.schemas import EnqueueOut, FlightPlanOut, PlanDecision, ReportOut, TickOut
from app.services.dispatcher import (
    TaskStatus,
    cancel_task,
    dispatch_tick,
    enqueue_report,
    get_task_for_report,
)
from app.services.fleet import DroneStatus, get_drone_state, select_drone_for_target
from app.services.flight_planner import FlightPlanner, OutOfServiceAreaError

router = APIRouter(tags=["flight-plans"])

_ACTIVE_PLAN = (PlanStatus.proposed, PlanStatus.approved)
MONITOR = Depends(require_monitor)  # control endpoints: X-Role must be the monitor role


def _new_plan(
    db: Session,
    report: Report,
    previous_reason: str | None = None,
    drone_id: str | None = None,
) -> FlightPlan:
    drone = get_drone_state(db, drone_id) if drone_id else None
    if drone is None or drone.status != DroneStatus.idle:
        drone = select_drone_for_target(db, report.lat, report.lon)
    try:
        proposal = FlightPlanner().propose(
            report.lat,
            report.lon,
            previous_reason=previous_reason,
            drone_id=drone.drone_id if drone else None,
            start_pos=drone.position if drone else None,
            start_battery_pct=drone.battery_pct if drone else None,
        )
    except OutOfServiceAreaError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return FlightPlan(
        report_id=report.id,
        drone_id=proposal.drone_id,
        altitude_m=proposal.altitude_m,
        survey_radius_m=proposal.survey_radius_m,
        route=proposal.route,
        status=PlanStatus.proposed,
    )


def _proposed_plan(db: Session, plan_id: int) -> FlightPlan:
    plan = get_or_404(db, FlightPlan, plan_id, "Flight plan")
    if plan.status != PlanStatus.proposed:
        raise conflict(f"Flight plan {plan_id} is {plan.status.value}; only a proposed plan can be decided")
    if plan.report.status != ReportStatus.under_review:
        raise conflict(f"Report {plan.report_id} is {plan.report.status.value}; its flight plan can no longer change")
    return plan


@router.post("/reports/{report_id}/flight-plan", response_model=FlightPlanOut, status_code=201, dependencies=[MONITOR])
def propose_flight_plan(report_id: int, db: Session = Depends(get_db)) -> FlightPlan:
    """Generate a plan with services.flight_planner for a confirmed report. SCRUM-27.
    409 when the report is not under_review, already has a proposed / approved plan, or already has an
    open inspection task (the fleet plans it itself; this manual plan is only an override when no task exists)."""
    report = get_or_404(db, Report, report_id, "Report")
    if report.status != ReportStatus.under_review:
        raise conflict(f"Report {report_id} is {report.status.value}; a flight plan needs an under_review report")
    task = get_task_for_report(db, report_id)
    if task is not None and task.status in (TaskStatus.queued, TaskStatus.held, TaskStatus.dispatched):
        raise conflict(f"Report {report_id} is already in the inspection queue ({task.status.value})")
    active = next((p for p in reversed(report.flight_plans) if p.status in _ACTIVE_PLAN), None)
    if active is not None:
        raise conflict(f"Report {report_id} already has flight plan {active.id} ({active.status.value})")
    plan = _new_plan(db, report)
    db.add(plan)
    db.commit()
    db.refresh(plan)
    return plan


@router.get("/reports/{report_id}/flight-plans", response_model=list[FlightPlanOut])
def list_flight_plans(report_id: int, db: Session = Depends(get_db)) -> list[FlightPlan]:
    """All plan versions of a report, newest first (decision history). SCRUM-31."""
    get_or_404(db, Report, report_id, "Report")
    query = (
        select(FlightPlan)
        .where(FlightPlan.report_id == report_id)
        .order_by(FlightPlan.created_at.desc(), FlightPlan.id.desc())
    )
    return list(db.scalars(query).all())


@router.get("/flight-plans/{plan_id}", response_model=FlightPlanOut)
def get_flight_plan(plan_id: int, db: Session = Depends(get_db)) -> FlightPlan:
    """One plan version. SCRUM-31."""
    return get_or_404(db, FlightPlan, plan_id, "Flight plan")


@router.post("/flight-plans/{plan_id}/approve", response_model=FlightPlanOut, dependencies=[MONITOR])
def approve_flight_plan(plan_id: int, db: Session = Depends(get_db)) -> FlightPlan:
    """Approve and create a pending Mission. Log the decision. SCRUM-31.
    The response carries mission_id for "Launch UAV" (POST /missions/{id}/dispatch)."""
    plan = _proposed_plan(db, plan_id)
    plan.status = PlanStatus.approved
    plan.decided_at = now_utc()
    db.add(Mission(flight_plan_id=plan.id, report_id=plan.report_id, state=MissionState.pending))
    db.commit()
    db.refresh(plan)
    return plan


@router.post("/flight-plans/{plan_id}/reject", response_model=FlightPlanOut, dependencies=[MONITOR])
def reject_flight_plan(plan_id: int, body: PlanDecision, db: Session = Depends(get_db)) -> FlightPlan:
    """Reject with a required reason (422 without one or with a blank one). Log the decision. SCRUM-31.
    No flight happens, so the report is closed as rejected with the plan reason as its review_note."""
    plan = _proposed_plan(db, plan_id)
    plan.status = PlanStatus.rejected
    plan.decision_reason = body.reason
    plan.decided_at = now_utc()
    plan.report.status = ReportStatus.rejected
    plan.report.review_note = body.reason
    db.commit()
    db.refresh(plan)
    return plan


@router.post("/flight-plans/{plan_id}/request-changes", response_model=FlightPlanOut, dependencies=[MONITOR])
def request_changes(plan_id: int, body: PlanDecision, db: Session = Depends(get_db)) -> FlightPlan:
    """Send back for changes; the planner proposes a new version. SCRUM-31.
    The old plan becomes changes_needed (with the reason); returns the NEW proposed plan."""
    plan = _proposed_plan(db, plan_id)
    plan.status = PlanStatus.changes_needed
    plan.decision_reason = body.reason
    plan.decided_at = now_utc()
    new_plan = _new_plan(db, plan.report, previous_reason=body.reason, drone_id=plan.drone_id)
    db.add(new_plan)
    db.commit()
    db.refresh(new_plan)
    return new_plan


@router.post("/reports/{report_id}/enqueue", response_model=EnqueueOut, dependencies=[MONITOR])
def enqueue_report_endpoint(report_id: int, db: Session = Depends(get_db)) -> EnqueueOut:
    """Queue a confirmed report for automatic dispatch (merges within report_merge_radius_m)."""
    try:
        task = enqueue_report(db, report_id)
    except OutOfServiceAreaError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return EnqueueOut(
        task_id=task.task_id,
        status=task.status.value,  # type: ignore[arg-type]
        report_ids=task.report_ids,
        drone_id=task.drone_id,
        flight_plan_id=task.plan_id,
        mission_id=task.mission_id,
    )


@router.post("/reports/{report_id}/cancel", response_model=ReportOut, dependencies=[MONITOR])
def cancel_queued_report(
    report_id: int,
    body: PlanDecision | None = None,
    db: Session = Depends(get_db),
) -> Report:
    """Monitor override: cancel a queued inspection task and close its reports as rejected."""
    reason = body.reason if body is not None else "Cancelled by monitor"
    cancel_task(db, report_id, reason=reason)
    return get_or_404(db, Report, report_id, "Report")


@router.post("/dispatcher/tick", response_model=TickOut, dependencies=[MONITOR])
def trigger_dispatch_tick(db: Session = Depends(get_db)) -> TickOut:
    """Advance active missions and dispatch any queued tasks."""
    missions = dispatch_tick(db)
    return TickOut(dispatched_mission_ids=[m.id for m in missions])
