"""Mission dispatch, live telemetry and edge results. Owner: Hoan / Hai (SCRUM-33, SCRUM-34, SCRUM-39).

Mock: the flight is computed on read from sim.mock_flight (see app.routers.common), no background thread.
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import (
    FLYING_STATES,
    CameraSession,
    CameraStatus,
    Detection,
    Mission,
    MissionState,
    PlanStatus,
    ReportStatus,
    UavTelemetry,
)
from app.routers.common import (
    complete_mission,
    conflict,
    external_sample,
    get_or_404,
    mission_duration_s,
    mission_elapsed_s,
    mission_home,
    now_utc,
    seconds_between,
    store_sample,
    sync_active_missions,
    sync_mission,
)
from app.schemas import (
    CameraSessionOut,
    DetectionOut,
    MissionOut,
    MissionResultsIn,
    TelemetryIn,
    TelemetryOut,
)
from app.services.fleet import DroneStatus, MissionStart, get_drone_state, get_mission_start, record_mission_start
from config import MOCK, UAV
from sim.mock_flight import telemetry_at

router = APIRouter(prefix="/missions", tags=["missions"])

_ACTIVE = (MissionState.pending, *FLYING_STATES)


def _mission(db: Session, mission_id: int) -> Mission:
    """The mission, advanced to now."""
    return sync_mission(db, get_or_404(db, Mission, mission_id, "Mission"))


@router.get("", response_model=list[MissionOut])
def list_missions(active: bool = False, db: Session = Depends(get_db)) -> list[Mission]:
    """Newest first. active=true: pending, takeoff, surveying or landing. SCRUM-39."""
    sync_active_missions(db)
    query = select(Mission).order_by(Mission.id.desc())
    if active:
        query = query.where(Mission.state.in_(_ACTIVE))
    return list(db.scalars(query).all())


@router.get("/{mission_id}", response_model=MissionOut)
def get_mission(mission_id: int, db: Session = Depends(get_db)) -> Mission:
    """One mission with its current state. SCRUM-39."""
    return _mission(db, mission_id)


@router.post("/{mission_id}/dispatch", response_model=MissionOut)
def dispatch_mission(mission_id: int, db: Session = Depends(get_db)) -> Mission:
    """Start the simulated UAV (sim.uav) for an approved plan; report -> uav_dispatched. SCRUM-33.
    Mock: the flight runs from started_at and is computed on read from the mission's start state."""
    sync_active_missions(db)
    mission = _mission(db, mission_id)
    if mission.state != MissionState.pending:
        raise conflict(f"Mission {mission_id} is {mission.state.value}; only a pending mission can be dispatched")
    if mission.flight_plan.status != PlanStatus.approved:
        raise conflict(f"Flight plan {mission.flight_plan_id} is not approved")
    if mission.report.status != ReportStatus.under_review:
        raise conflict(f"Report {mission.report_id} is {mission.report.status.value}; it cannot be surveyed")
    now = now_utc()
    drone = get_drone_state(db, mission.flight_plan.drone_id, now)
    if drone.status != DroneStatus.idle:
        raise conflict(f"Drone {drone.drone_id} is {drone.status.value} and cannot be dispatched")
    record_mission_start(db, mission, MissionStart(drone.lat, drone.lon, drone.altitude_m, drone.battery_pct))
    mission.state = MissionState.takeoff
    mission.started_at = now
    mission.report.status = ReportStatus.uav_dispatched
    db.commit()
    db.refresh(mission)
    return mission


@router.post("/{mission_id}/telemetry", response_model=TelemetryOut, status_code=201)
def push_telemetry(mission_id: int, body: TelemetryIn, db: Session = Depends(get_db)) -> UavTelemetry:
    """Called by the simulator every config.UAV.telemetry_interval_s. SCRUM-33.
    Shown by /telemetry/latest instead of the mock flight for MOCK.ingest_hold_s. 409 unless flying.
    The body's `state` is ignored: the stored row takes the mission's current state (same as ingest)."""
    mission = _mission(db, mission_id)
    if mission.state not in FLYING_STATES:
        raise conflict(f"Mission {mission_id} is {mission.state.value}; telemetry is taken only while it is flying")
    now = now_utc()
    return store_sample(db, mission, external_sample(mission, body, now), source="api", ts=now)


def _mission_sample(db: Session, mission: Mission, elapsed_s: float) -> dict:
    plan = mission.flight_plan
    m_start = get_mission_start(db, mission)
    sample = telemetry_at(
        plan.route,
        elapsed_s,
        plan.drone_id,
        mission_home(),
        start_battery_pct=m_start.battery_pct,
        start_pos=m_start.pos,
    )
    return TelemetryIn.model_validate(sample).model_dump()


def current_telemetry(db: Session, mission: Mission) -> UavTelemetry:
    """Newest telemetry of a mission, advancing the mock flight first.

    - Flying: a posted/ingested sample younger than MOCK.ingest_hold_s wins; otherwise a new simulated
      sample is stored at most every UAV.telemetry_interval_s.
    - Done: the final landed sample (stamped at finished_at).
    - Pending / failed: the UAV parked at home (in_mission false).
    """
    now = now_utc()
    sync_mission(db, mission, now)
    query = (
        select(UavTelemetry)
        .where(UavTelemetry.mission_id == mission.id)
        .order_by(UavTelemetry.ts.desc(), UavTelemetry.id.desc())
        .limit(1)
    )
    if mission.state == MissionState.done:
        query = query.where(UavTelemetry.state == MissionState.done)
    newest = db.scalars(query).first()

    if mission.state in FLYING_STATES:
        if newest is not None:
            age = seconds_between(newest.ts, now)
            if newest.source != "sim" and age < MOCK.ingest_hold_s:
                return newest
            if newest.source == "sim" and newest.state in FLYING_STATES and age < UAV.telemetry_interval_s:
                return newest
        return store_sample(db, mission, _mission_sample(db, mission, mission_elapsed_s(mission, now)), "sim", now)

    if mission.state == MissionState.done:
        if newest is not None:
            return newest
        sample = _mission_sample(db, mission, mission_duration_s(mission))
        return store_sample(db, mission, sample, "sim", mission.finished_at or now)

    if newest is not None:
        return newest
    sample = _mission_sample(db, mission, 0.0)  # on the ground at start
    sample.update(state=mission.state, in_mission=False)
    return store_sample(db, mission, sample, "sim", now)


@router.get("/{mission_id}/telemetry/latest", response_model=TelemetryOut)
def latest_telemetry(mission_id: int, db: Session = Depends(get_db)) -> UavTelemetry:
    """Polled by the dashboard map (SCRUM-39). Every field of the drone mapping table is filled."""
    return current_telemetry(db, get_or_404(db, Mission, mission_id, "Mission"))


@router.post("/{mission_id}/results", response_model=MissionOut)
def upload_results(mission_id: int, body: MissionResultsIn, db: Session = Depends(get_db)) -> Mission:
    """Edge detections after landing: geo-locate (ml.geo), merge repeats, store,
    mark the report confirmed / not_confirmed. SCRUM-34.
    Mock: the frame pose lat/lon is stored as the location; the simulated flight posts its own results
    when it ends, so this only works while the mission is still flying (409 otherwise)."""
    mission = _mission(db, mission_id)
    if mission.state not in FLYING_STATES:
        raise conflict(f"Mission {mission_id} is {mission.state.value}; results are taken only while it is flying")
    if not complete_mission(db, mission, now_utc(), [d.model_dump() for d in body.detections]):
        raise conflict(f"Mission {mission_id} already has results")
    return mission



@router.get("/{mission_id}/detections", response_model=list[DetectionOut])
def mission_detections(mission_id: int, db: Session = Depends(get_db)) -> list[Detection]:
    """Edge (UAV) detections of a mission (SCRUM-34); empty until it is done, and when not confirmed."""
    mission = _mission(db, mission_id)
    query = select(Detection).where(Detection.mission_id == mission.id).order_by(Detection.id)
    return list(db.scalars(query).all())


# ---------------------------------------------------------------------------
# Live camera (mocked: no real video yet, stream_url stays null)
# ---------------------------------------------------------------------------
def _camera(db: Session, mission: Mission) -> CameraSession | None:
    """The mission's camera session advanced to now: requested -> live after MOCK.camera_live_delay_s,
    requested/live -> ended once the mission is no longer flying."""
    cam = db.scalars(select(CameraSession).where(CameraSession.mission_id == mission.id)).first()
    if cam is None:
        return None
    now = now_utc()
    ended_at = None if mission.state in FLYING_STATES else (mission.finished_at or now)
    changed = False
    if cam.status == CameraStatus.requested and cam.requested_at is not None:
        live_at = cam.requested_at + timedelta(seconds=MOCK.camera_live_delay_s)
        if live_at <= now and (ended_at is None or live_at < ended_at):
            cam.status, cam.started_at, changed = CameraStatus.live, live_at, True
    if ended_at is not None and cam.status in (CameraStatus.requested, CameraStatus.live):
        cam.status, cam.ended_at, changed = CameraStatus.ended, ended_at, True
    if changed:
        db.commit()
    return cam


def _idle(mission: Mission) -> CameraSessionOut:
    return CameraSessionOut(mission_id=mission.id, status=CameraStatus.idle)


@router.post("/{mission_id}/camera/request", response_model=CameraSessionOut)
def request_camera(mission_id: int, db: Session = Depends(get_db)) -> CameraSession | CameraSessionOut:
    """Ask the UAV for its live camera. While the mission is takeoff, surveying or landing: "requested"
    (then "live" after MOCK.camera_live_delay_s). Otherwise 200 with status "denied"; the denial is not
    stored, so GET /camera keeps showing the earlier session (idle or ended)."""
    mission = _mission(db, mission_id)
    if mission.state not in FLYING_STATES:
        return CameraSessionOut(mission_id=mission.id, status=CameraStatus.denied, requested_at=now_utc())
    cam = _camera(db, mission)
    if cam is not None and cam.status in (CameraStatus.requested, CameraStatus.live):
        return cam
    if cam is None:
        cam = CameraSession(mission_id=mission.id)
        db.add(cam)
    cam.status = CameraStatus.requested
    cam.requested_at = now_utc()
    cam.started_at = None
    cam.ended_at = None
    cam.stream_url = None
    db.commit()
    db.refresh(cam)
    return cam


@router.get("/{mission_id}/camera", response_model=CameraSessionOut)
def get_camera(mission_id: int, db: Session = Depends(get_db)) -> CameraSession | CameraSessionOut:
    """Current camera session; status "idle" when never requested."""
    mission = _mission(db, mission_id)
    return _camera(db, mission) or _idle(mission)


@router.post("/{mission_id}/camera/stop", response_model=CameraSessionOut)
def stop_camera(mission_id: int, db: Session = Depends(get_db)) -> CameraSession | CameraSessionOut:
    """End the live camera. Stopping an ended session returns it unchanged; never requested -> idle."""
    mission = _mission(db, mission_id)
    cam = _camera(db, mission)
    if cam is None:
        return _idle(mission)
    if cam.status in (CameraStatus.requested, CameraStatus.live):
        cam.status = CameraStatus.ended
        cam.ended_at = now_utc()
        db.commit()
        db.refresh(cam)
    return cam
