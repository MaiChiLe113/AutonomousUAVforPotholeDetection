"""Database tables. Owner: Chi (SCRUM-23). Statuses follow the activity diagram (§2)."""

from __future__ import annotations

import enum
from datetime import UTC, datetime

from sqlalchemy import JSON, Boolean, DateTime, Enum, Float, ForeignKey, Integer, String, TypeDecorator
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from sim.energy import estimate
from sim.mock_flight import flight_duration_s, haversine_m


def _now() -> datetime:
    return datetime.now(UTC)


class UtcDateTime(TypeDecorator):
    """Stores UTC and always returns timezone-aware datetimes (SQLite drops the offset otherwise,
    and the frontend would then read the time as local time)."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)

    def process_result_value(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)


class ReportStatus(enum.StrEnum):
    submitted = "submitted"
    no_damage = "no_damage"  # closed by the AI pre-check
    under_review = "under_review"
    rejected = "rejected"  # rejected by the UAV admin
    uav_dispatched = "uav_dispatched"
    confirmed = "confirmed"
    not_confirmed = "not_confirmed"


class PlanStatus(enum.StrEnum):
    proposed = "proposed"
    approved = "approved"
    changes_needed = "changes_needed"
    rejected = "rejected"


class MissionState(enum.StrEnum):
    pending = "pending"
    takeoff = "takeoff"
    surveying = "surveying"
    landing = "landing"
    done = "done"
    failed = "failed"


FLYING_STATES = (MissionState.takeoff, MissionState.surveying, MissionState.landing)


class CameraStatus(enum.StrEnum):
    idle = "idle"  # no request yet (not stored; returned when a mission has no session)
    requested = "requested"
    live = "live"
    denied = "denied"
    ended = "ended"


class Report(Base):
    __tablename__ = "reports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    photo_path: Mapped[str] = mapped_column(String)  # relative to PATHS.media_dir, e.g. "seed/pothole-1.jpg"
    status: Mapped[ReportStatus] = mapped_column(Enum(ReportStatus), default=ReportStatus.submitted)
    review_note: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=_now, onupdate=_now)

    detections: Mapped[list[Detection]] = relationship(back_populates="report", order_by="Detection.id")
    flight_plans: Mapped[list[FlightPlan]] = relationship(back_populates="report", order_by="FlightPlan.id")
    missions: Mapped[list[Mission]] = relationship(back_populates="report", order_by="Mission.id")

    @property
    def photo_url(self) -> str:
        """Path under /media; the frontend prefixes the API base URL."""
        return f"/media/{self.photo_path}"

    @property
    def latest_plan_id(self) -> int | None:
        return self.flight_plans[-1].id if self.flight_plans else None

    @property
    def latest_plan_status(self) -> PlanStatus | None:
        return self.flight_plans[-1].status if self.flight_plans else None

    @property
    def mission_id(self) -> int | None:
        return self.missions[-1].id if self.missions else None


class Detection(Base):
    """One box from either the server pre-check or the UAV edge device."""

    __tablename__ = "detections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    report_id: Mapped[int | None] = mapped_column(ForeignKey("reports.id"), nullable=True)
    mission_id: Mapped[int | None] = mapped_column(ForeignKey("missions.id"), nullable=True)
    source: Mapped[str] = mapped_column(String)  # "server" | "edge"
    deployment: Mapped[str] = mapped_column(String)  # "server-fp32" | "jetson-int8" | "pi-int8"
    cls: Mapped[str] = mapped_column(String)  # D00 | D10 | D20 | D40
    confidence: Mapped[float] = mapped_column(Float)
    box_xyxy: Mapped[list[float]] = mapped_column(JSON)
    frame_id: Mapped[str] = mapped_column(String)
    model_version: Mapped[str] = mapped_column(String)
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)  # edge detections after geo-location
    lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    size_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    annotated_path: Mapped[str | None] = mapped_column(String, nullable=True)
    flagged_wrong: Mapped[bool] = mapped_column(Boolean, default=False)  # SCRUM-37
    flag_note: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=_now)

    report: Mapped[Report | None] = relationship(back_populates="detections")

    @property
    def annotated_url(self) -> str | None:
        return f"/media/{self.annotated_path}" if self.annotated_path else None


class FlightPlan(Base):
    __tablename__ = "flight_plans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    report_id: Mapped[int] = mapped_column(ForeignKey("reports.id"))
    drone_id: Mapped[str] = mapped_column(String)
    altitude_m: Mapped[float] = mapped_column(Float)
    survey_radius_m: Mapped[float] = mapped_column(Float)
    route: Mapped[list[dict]] = mapped_column(JSON)  # [{"lat", "lon", "alt", "action"}]
    status: Mapped[PlanStatus] = mapped_column(Enum(PlanStatus), default=PlanStatus.proposed)
    decision_reason: Mapped[str | None] = mapped_column(String, nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=_now)

    report: Mapped[Report] = relationship(back_populates="flight_plans")
    missions: Mapped[list[Mission]] = relationship(back_populates="flight_plan", order_by="Mission.id")

    @property
    def mission_id(self) -> int | None:
        """The mission created when this plan was approved."""
        return self.missions[-1].id if self.missions else None

    @property
    def distance_m(self) -> float:
        """Horizontal length of the route (sum of haversine legs)."""
        points = [(wp["lat"], wp["lon"]) for wp in self.route]
        return round(sum(haversine_m(a, b) for a, b in zip(points, points[1:], strict=False)), 1)

    @property
    def estimated_duration_s(self) -> float:
        """Simulated flight duration in seconds from sim.energy.estimate."""
        return flight_duration_s(self.route)

    @property
    def estimated_battery_pct(self) -> float:
        """Estimated battery percentage used by the route (sim.energy.estimate)."""
        return estimate(self.route).battery_used_pct


class Mission(Base):
    __tablename__ = "missions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    flight_plan_id: Mapped[int] = mapped_column(ForeignKey("flight_plans.id"))
    report_id: Mapped[int] = mapped_column(ForeignKey("reports.id"))
    state: Mapped[MissionState] = mapped_column(Enum(MissionState), default=MissionState.pending)
    started_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)

    flight_plan: Mapped[FlightPlan] = relationship(back_populates="missions")
    report: Mapped[Report] = relationship(back_populates="missions")

    @property
    def drone_id(self) -> str:
        return self.flight_plan.drone_id


class UavTelemetry(Base):
    """One telemetry sample. `source`: "sim" (mock flight), "drone" (/telemetry/ingest) or "api"."""

    __tablename__ = "uav_telemetry"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    mission_id: Mapped[int] = mapped_column(ForeignKey("missions.id"))
    source: Mapped[str] = mapped_column(String, default="api")
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    altitude_m: Mapped[float] = mapped_column(Float)
    heading_deg: Mapped[float] = mapped_column(Float)
    state: Mapped[MissionState] = mapped_column(Enum(MissionState))
    ts: Mapped[datetime] = mapped_column(UtcDateTime, default=_now)
    drone_id: Mapped[str | None] = mapped_column(String, nullable=True)
    home_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    home_lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    home_alt_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    distance_to_home_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    distance_to_target_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    gimbal_pitch_deg: Mapped[float | None] = mapped_column(Float, nullable=True)
    gimbal_yaw_deg: Mapped[float | None] = mapped_column(Float, nullable=True)
    gimbal_roll_deg: Mapped[float | None] = mapped_column(Float, nullable=True)
    battery_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    in_mission: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    current_waypoint: Mapped[int | None] = mapped_column(Integer, nullable=True)
    progress_pct: Mapped[float | None] = mapped_column(Float, nullable=True)


class AppMeta(Base):
    """Key/value facts about the database itself, e.g. which seed it was loaded from (not part of the API)."""

    __tablename__ = "app_meta"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[str] = mapped_column(String)


class CameraSession(Base):
    """Live camera request for a mission (mocked: no real video yet, stream_url stays null)."""

    __tablename__ = "camera_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    mission_id: Mapped[int] = mapped_column(ForeignKey("missions.id"), unique=True)
    status: Mapped[CameraStatus] = mapped_column(Enum(CameraStatus), default=CameraStatus.requested)
    stream_url: Mapped[str | None] = mapped_column(String, nullable=True)
    requested_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
