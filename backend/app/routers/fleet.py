"""Fleet overview for the monitor dashboard and the resident map: GET /fleet (read-only)."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Mission
from app.routers.common import mission_elapsed_s, now_utc, sync_active_missions
from app.schemas import (
    DecisionOut,
    DistrictOut,
    FleetDroneOut,
    FleetOut,
    LatLon,
    LatLonAlt,
    QueueItemOut,
    WeatherOut,
)
from app.services.dispatcher import InspectionTask, TaskStatus, dispatch_tick, list_tasks
from app.services.fleet import DroneState, DroneStatus, get_fleet_state, get_mission_start
from app.services.safety import Decision, current_weather, list_decisions
from config import FLEET, SAFETY
from sim.energy import bearing_deg, route_target
from sim.mock_flight import telemetry_at

router = APIRouter(tags=["fleet"])

_OPEN = (TaskStatus.queued, TaskStatus.held, TaskStatus.dispatched, TaskStatus.flagged)


def _decision_out(d: Decision) -> DecisionOut:
    return DecisionOut(
        id=d.id, at=d.at, drone_id=d.drone_id, report_id=d.report_id, action=d.action, code=d.code, reason=d.reason
    )  # type: ignore[arg-type]


def _drone_out(db: Session, d: DroneState, now: datetime, decisions: list[Decision]) -> FleetDroneOut:
    base = (d.base_lat, d.base_lon)
    heading = 0.0
    mission_id = report_id = None
    target: LatLon | None = None

    if d.status == DroneStatus.flying and d.active_mission_id is not None:
        mission = db.get(Mission, d.active_mission_id)
        if mission is not None and mission.started_at is not None:
            plan = mission.flight_plan
            m_start = get_mission_start(db, mission)
            sample = telemetry_at(
                plan.route,
                mission_elapsed_s(mission, now),
                plan.drone_id,
                (*base, d.base_alt_m),
                start_battery_pct=m_start.battery_pct,
                start_pos=m_start.pos,
            )
            heading = float(sample["heading_deg"])
            mission_id, report_id = mission.id, mission.report_id
            lat, lon = route_target(plan.route)
            target = LatLon(lat=lat, lon=lon)
    elif d.status == DroneStatus.returning:
        heading = bearing_deg((d.lat, d.lon), base)

    waiting = d.status in (DroneStatus.flying, DroneStatus.returning, DroneStatus.swapping)
    last = next((x for x in decisions if x.drone_id == d.drone_id), None)
    return FleetDroneOut(
        drone_id=d.drone_id,
        status=d.status.value,  # type: ignore[arg-type]
        battery_pct=round(d.battery_pct, 1),
        position=LatLonAlt(lat=d.lat, lon=d.lon, alt_m=d.altitude_m),
        heading_deg=round(heading % 360.0, 1),
        mission_id=mission_id,
        report_id=report_id,
        target=target,
        available_at=d.available_at if waiting else None,
        last_decision=_decision_out(last) if last is not None else None,
    )


def _queue_out(tasks: list[InspectionTask]) -> list[QueueItemOut]:
    open_tasks = sorted((t for t in tasks if t.status in _OPEN), key=lambda t: (-t.priority, t.created_at, t.task_id))
    closed = sorted((t for t in tasks if t.status not in _OPEN), key=lambda t: t.queued_at, reverse=True)
    return [
        QueueItemOut(
            task_id=t.task_id,
            report_id=t.report_ids[0] if t.report_ids else t.task_id,
            status=t.status.value,  # type: ignore[arg-type]
            priority=t.priority,
            created_at=t.created_at,
            hold_reason=t.hold_reason if t.status == TaskStatus.held else None,
            lat=t.lat,
            lon=t.lon,
        )
        for t in [*open_tasks, *closed[: SAFETY.queue_recent_closed]]
    ]


@router.get("/fleet", response_model=FleetOut)
def get_fleet(db: Session = Depends(get_db)) -> FleetOut:
    """District, base, simulated weather, the drones, the inspection queue and the go / no-go decision log.

    Advances missions first, and the dispatcher too when the background loop is off. Open to residents."""
    sync_active_missions(db)
    now = now_utc()
    if not FLEET.auto_tick:  # the background loop ticks; without it a read advances the fleet
        dispatch_tick(db, now)
    weather = current_weather(db, now)
    decisions = list_decisions(db)
    base = LatLon(lat=FLEET.base_lat, lon=FLEET.base_lon)
    return FleetOut(
        district=DistrictOut(name=FLEET.district_name, center=base, radius_m=FLEET.service_radius_m),
        base=base,
        weather=WeatherOut(
            wind_mps=weather.wind_mps,
            gust_mps=weather.gust_mps,
            rain=weather.rain,
            flyable=weather.flyable,
            updated_at=weather.updated_at,
        ),
        drones=[_drone_out(db, d, now, decisions) for d in get_fleet_state(db, now)],
        queue=_queue_out(list_tasks(db)),
        decisions=[_decision_out(d) for d in decisions],
    )
