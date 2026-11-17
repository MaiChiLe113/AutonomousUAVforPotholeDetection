"""API request/response models. Keep in sync with frontend/lib/types.ts."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.models import CameraStatus, MissionState, PlanStatus, ReportStatus


class _Orm(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class DetectionOut(_Orm):
    id: int
    source: str
    deployment: str
    cls: str
    confidence: float
    box_xyxy: list[float]
    frame_id: str
    model_version: str
    lat: float | None = None
    lon: float | None = None
    size_m: float | None = None
    annotated_url: str | None = None
    flagged_wrong: bool


class ReportOut(_Orm):
    id: int
    lat: float
    lon: float
    photo_url: str  # path under /media, e.g. "/media/seed/pothole-1.jpg"; the frontend prefixes the API base URL
    status: ReportStatus
    review_note: str | None = None
    created_at: datetime
    updated_at: datetime
    detections: list[DetectionOut] = []  # server pre-check boxes only; edge boxes: GET /missions/{id}/detections
    latest_plan_id: int | None = None
    latest_plan_status: PlanStatus | None = None
    mission_id: int | None = None  # newest mission of the report


class ReportReview(BaseModel):
    """UAV admin decision on a report (SCRUM-29). Reject (confirmed=false) requires a note."""

    confirmed: bool
    note: str | None = None


class FlagIn(BaseModel):
    """Mark a detection as wrong (SCRUM-37)."""

    note: str | None = None


class Waypoint(BaseModel):
    lat: float
    lon: float
    alt: float
    action: str  # "takeoff" | "fly" | "survey" | "land"


class FlightPlanOut(_Orm):
    id: int
    report_id: int
    drone_id: str
    altitude_m: float
    survey_radius_m: float
    route: list[Waypoint]
    status: PlanStatus
    decision_reason: str | None = None
    decided_at: datetime | None = None
    created_at: datetime
    mission_id: int | None = None  # set once the plan is approved
    distance_m: float  # horizontal route length (sum of haversine legs)
    estimated_duration_s: float  # simulated flight duration from sim.energy.estimate
    estimated_battery_pct: float  # estimated battery percentage used


class PlanDecision(BaseModel):
    """Reject and changes-needed both require a reason (SCRUM-31)."""

    model_config = ConfigDict(str_strip_whitespace=True)

    reason: str = Field(min_length=1)


class MissionOut(_Orm):
    id: int
    flight_plan_id: int
    report_id: int
    drone_id: str
    state: MissionState
    started_at: datetime | None = None
    finished_at: datetime | None = None


class TelemetryIn(BaseModel):
    lat: float
    lon: float
    altitude_m: float
    heading_deg: float
    state: MissionState
    drone_id: str | None = None
    home_lat: float | None = None
    home_lon: float | None = None
    home_alt_m: float | None = None
    distance_to_home_m: float | None = None
    distance_to_target_m: float | None = None
    gimbal_pitch_deg: float | None = None
    gimbal_yaw_deg: float | None = None
    gimbal_roll_deg: float | None = None
    battery_pct: float | None = None
    in_mission: bool | None = None
    current_waypoint: int | None = None
    progress_pct: float | None = None


class TelemetryOut(_Orm, TelemetryIn):
    id: int
    mission_id: int
    ts: datetime


class DroneTelemetryIn(BaseModel):
    """Raw message from the drone app (wire format kept at the edge only). POST /telemetry/ingest."""

    drone_id: str = Field(alias="droneID", min_length=1)
    lat: float = Field(alias="aircraftLatitude", ge=-90, le=90)
    lon: float = Field(alias="aircraftLongitude", ge=-180, le=180)
    altitude_m: float = Field(alias="aircraftAltitude")
    heading_deg: float = Field(alias="headingDroneDegress")
    distance_to_home_m: float | None = Field(default=None, alias="distanceToHome")
    home_lat: float | None = Field(default=None, alias="homeLatitude", ge=-90, le=90)
    home_lon: float | None = Field(default=None, alias="homeLongitude", ge=-180, le=180)
    home_alt_m: float | None = Field(default=None, alias="homeAltitude")
    gimbal_pitch_deg: float | None = Field(default=None, alias="gimbal_PITCH")
    gimbal_yaw_deg: float | None = Field(default=None, alias="gimbal_YAW")
    gimbal_roll_deg: float | None = Field(default=None, alias="gimbal_ROLL")
    battery_pct: float | None = Field(default=None, alias="batteryPercentage")
    in_mission: bool | None = Field(default=None, alias="isInMission")
    current_waypoint: int | None = Field(default=None, alias="currentWaypointMissionPlanner")
    mission_plan: Any = Field(default=None, alias="missionPlan")  # ignored: the route comes from our plan


class CameraSessionOut(_Orm):
    mission_id: int
    status: CameraStatus
    stream_url: str | None = None  # null in the mock (UI shows a simulated feed); later an HLS/WebRTC URL
    requested_at: datetime | None = None
    started_at: datetime | None = None
    ended_at: datetime | None = None


class EdgeDetectionIn(BaseModel):
    """One detection uploaded by the edge device after landing (§3.4 output check)."""

    frame_id: str
    cls: str
    confidence: float
    box_xyxy: list[float]
    model_version: str
    deployment: str
    pose: dict  # lat, lon, altitude_m, heading_deg
    image_size: tuple[int, int]


class MissionResultsIn(BaseModel):
    detections: list[EdgeDetectionIn]


class MetricsOut(BaseModel):
    """Monitoring signals (§3.3 Table 3.6)."""

    reports_total: int
    correction_rate: float | None
    uav_agreement_rate: float | None
    mean_confidence_by_class: dict[str, float]
    model_version: str | None
    retrain_triggers: list[str]


class ResetOut(BaseModel):
    """POST /dev/reset: counts of the reseeded demo data."""

    reports: int
    flight_plans: int
    missions: int
    reset_at: datetime
