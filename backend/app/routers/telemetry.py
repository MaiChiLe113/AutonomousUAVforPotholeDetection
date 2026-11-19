"""Telemetry from the real drone app (SCRUM-33, SCRUM-39). The raw wire format stays here; inside the
system the message is stored with the snake_case TelemetryIn fields."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import FLYING_STATES, FlightPlan, Mission, UavTelemetry
from app.routers.common import external_sample, now_utc, store_sample, sync_active_missions
from app.schemas import DroneTelemetryIn, TelemetryIn, TelemetryOut
from config import UAV

router = APIRouter(prefix="/telemetry", tags=["telemetry"])


# Not role-guarded on purpose: the drone app posts here and has no monitor role.
@router.post("/ingest", response_model=TelemetryOut, status_code=201)
def ingest(body: DroneTelemetryIn, db: Session = Depends(get_db)) -> UavTelemetry:
    """Store one raw drone message on the drone's active (flying) mission, found by droneID.

    Heading is normalised to 0-360 and distanceToHome is recomputed from the coordinates when home is
    set. The sample shows on the dashboard for MOCK.ingest_hold_s. 404 for an unknown droneID or a drone
    with no flying mission. missionPlan is ignored (the route comes from our flight plan)."""
    sync_active_missions(db)
    known = body.drone_id in UAV.drone_ids or db.scalars(
        select(FlightPlan.id).where(FlightPlan.drone_id == body.drone_id).limit(1)
    ).first() is not None
    if not known:
        raise HTTPException(status_code=404, detail=f"Unknown drone '{body.drone_id}'")

    mission = db.scalars(
        select(Mission)
        .join(FlightPlan, Mission.flight_plan_id == FlightPlan.id)
        .where(FlightPlan.drone_id == body.drone_id, Mission.state.in_(FLYING_STATES))
        .order_by(Mission.started_at.desc(), Mission.id.desc())
        .limit(1)
    ).first()
    if mission is None:
        raise HTTPException(
            status_code=404, detail=f"Drone '{body.drone_id}' has no active mission (dispatch a mission first)"
        )

    now = now_utc()
    reading = TelemetryIn(state=mission.state, **body.model_dump(exclude={"mission_plan"}))
    return store_sample(db, mission, external_sample(mission, reading, now), source="drone", ts=now)
