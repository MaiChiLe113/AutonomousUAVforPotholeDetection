"""Helpers shared by the routers: lookups, errors, and the mock mission computed on read.

Mission state, telemetry and results come from the pure functions in sim.mock_flight (no background
thread). Every read that can see a mission calls `sync_mission` / `sync_active_missions` first, so a
flight finishes (mission done, edge detections stored, report confirmed / not_confirmed) exactly once,
even when nobody watches the dashboard (SCRUM-33, SCRUM-34, SCRUM-39).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import TypeVar

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.models import FLYING_STATES, Detection, Mission, MissionState, ReportStatus, UavTelemetry
from app.schemas import TelemetryIn
from config import MOCK, UAV
from sim.mock_flight import edge_results, flight_duration_s, haversine_m, telemetry_at

T = TypeVar("T")


def now_utc() -> datetime:
    return datetime.now(UTC)


def get_or_404(db: Session, model: type[T], obj_id: int, label: str) -> T:
    obj = db.get(model, obj_id)
    if obj is None:
        raise HTTPException(status_code=404, detail=f"{label} {obj_id} not found")
    return obj


def conflict(message: str) -> HTTPException:
    """409: the object is not in a state that allows this action."""
    return HTTPException(status_code=409, detail=message)


def seconds_between(start: datetime, end: datetime) -> float:
    return (end - start).total_seconds()


# ---------------------------------------------------------------------------
# Simulated flight
# ---------------------------------------------------------------------------
def mission_home() -> tuple[float, float, float]:
    return UAV.home_lat, UAV.home_lon, MOCK.home_alt_m


def mission_duration_s(mission: Mission) -> float:
    return flight_duration_s(mission.flight_plan.route)


def mission_elapsed_s(mission: Mission, now: datetime) -> float:
    return seconds_between(mission.started_at, now) if mission.started_at else 0.0


def simulated_sample(mission: Mission, elapsed_s: float) -> dict:
    """Telemetry dict (TelemetryIn fields) of the mock flight `elapsed_s` after dispatch."""
    plan = mission.flight_plan
    sample = telemetry_at(plan.route, elapsed_s, plan.drone_id, mission_home())
    return TelemetryIn.model_validate(sample).model_dump()


def store_sample(db: Session, mission: Mission, sample: dict, source: str, ts: datetime) -> UavTelemetry:
    row = UavTelemetry(mission_id=mission.id, source=source, ts=ts, **sample)
    db.add(row)
    db.commit()
    return row


def distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    return round(haversine_m(a, b), 1)


def external_sample(mission: Mission, body: TelemetryIn, now: datetime) -> dict:
    """Telemetry posted from outside the simulation: state forced to the mission's current state (the
    mission timeline owns it, so a pushed "done" or "pending" cannot end or reset a flight), heading
    normalised to 0-360, distance to home recomputed when home is known (the drone's own value is not
    trusted alone), distance to target and progress filled in when missing."""
    sample = body.model_dump()
    sample["state"] = mission.state
    sample["heading_deg"] = body.heading_deg % 360.0
    position = (body.lat, body.lon)
    if body.home_lat is not None and body.home_lon is not None:
        sample["distance_to_home_m"] = distance_m(position, (body.home_lat, body.home_lon))
    if sample["distance_to_target_m"] is None:
        sample["distance_to_target_m"] = distance_m(position, (mission.report.lat, mission.report.lon))
    if sample["progress_pct"] is None and mission.started_at is not None:
        duration = mission_duration_s(mission)
        elapsed = mission_elapsed_s(mission, now)
        sample["progress_pct"] = round(min(100.0, 100.0 * elapsed / duration), 1) if duration > 0 else 100.0
    if sample["drone_id"] is None:
        sample["drone_id"] = mission.drone_id
    return sample


def edge_detection_row(mission_id: int, d: dict) -> Detection:
    """A Detection row from one EdgeDetectionIn-shaped dict (pose lat/lon used as the location)."""
    pose = d.get("pose") or {}
    return Detection(
        report_id=None,
        mission_id=mission_id,
        source="edge",
        deployment=d["deployment"],
        cls=d["cls"],
        confidence=d["confidence"],
        box_xyxy=list(d["box_xyxy"]),
        frame_id=d["frame_id"],
        model_version=d["model_version"],
        lat=pose.get("lat"),
        lon=pose.get("lon"),
    )


def complete_mission(db: Session, mission: Mission, finished_at: datetime, edge: list[dict]) -> bool:
    """Mark the mission done, store the edge detections and set the report confirmed / not_confirmed.

    Runs at most once per mission: the guarded UPDATE only matches while the mission is not done, so a
    second caller (another poll, a late upload) changes nothing and gets False.
    """
    result = db.execute(
        update(Mission)
        .where(Mission.id == mission.id, Mission.state != MissionState.done)
        .values(state=MissionState.done, finished_at=finished_at)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        db.rollback()
        db.refresh(mission)
        return False

    for d in edge:
        db.add(edge_detection_row(mission.id, d))
    mission.report.status = ReportStatus.confirmed if edge else ReportStatus.not_confirmed
    db.commit()
    db.refresh(mission)
    return True


def sync_mission(db: Session, mission: Mission, now: datetime | None = None) -> Mission:
    """Advance a flying mission to the state of the mock flight at `now` (finishes it when time is up)."""
    if mission.state not in FLYING_STATES or mission.started_at is None:
        return mission
    now = now or now_utc()
    duration = mission_duration_s(mission)
    elapsed = mission_elapsed_s(mission, now)

    if elapsed >= duration:
        report = mission.report
        server = [
            {
                "id": d.id,
                "cls": d.cls,
                "confidence": d.confidence,
                "box_xyxy": d.box_xyxy,
                "flagged_wrong": d.flagged_wrong,
            }
            for d in report.detections
        ]
        edge = edge_results(server, (report.lat, report.lon), altitude_m=mission.flight_plan.altitude_m)
        complete_mission(db, mission, mission.started_at + timedelta(seconds=duration), edge)
        return mission

    state = MissionState(telemetry_at(mission.flight_plan.route, elapsed, mission.drone_id, mission_home())["state"])
    if state in FLYING_STATES and state != mission.state:
        mission.state = state
        db.commit()
    return mission


def sync_active_missions(db: Session) -> None:
    """Advance every flying mission (called before reads that show report or mission status)."""
    now = now_utc()
    for mission in db.scalars(select(Mission).where(Mission.state.in_(FLYING_STATES))).all():
        sync_mission(db, mission, now)
