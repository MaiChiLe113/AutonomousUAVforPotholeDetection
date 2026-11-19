"""Go / no-go flight gate, simulated weather, task priority and the decision log.

The drones decide for themselves whether to fly. `can_fly` is the single check (offline, service area,
rain, wind, gusts, battery at launch, wind-adjusted round trip). The allocators call it through a
`SafetyGate` for every drone that could launch now, and the dispatcher turns a failed gate into a `held`
task with a human readable reason. `mid_flight_check` recalls flying drones when the weather turns bad.

Weather is SIMULATED: `weather_at` is a seeded timeline (config.WEATHER). A monitor or a test can pin the
weather with `set_weather_override`. A real feed would replace `current_weather` and keep the same type.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Protocol

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import FLYING_STATES, AppMeta, Mission, Report
from app.services.fleet import DroneStatus
from app.services.flight_planner import FlightPlanner, OutOfServiceAreaError
from config import ENERGY, FLEET, SAFETY, WEATHER, EnergyConfig, FleetConfig, SafetyConfig, WeatherConfig
from sim.energy import haversine_m

_DECISIONS_KEY = "safety:decisions"
_DECISION_SEQ_KEY = "safety:decision_seq"
_WEATHER_OVERRIDE_KEY = "safety:weather_override"

# Gate codes that make a task wait on the ground (held). The others (offline, out_of_area and a round trip
# that is too long even in calm air) keep the old behaviour: the task stays queued without a hold.
HOLD_CODES = frozenset({"rain", "wind", "gust", "low_battery", "wind_range"})


def _utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


def _upsert_meta(db: Session, key: str, value: str) -> None:
    row = db.get(AppMeta, key)
    if row is None:
        db.add(AppMeta(key=key, value=value))
    else:
        row.value = value
    db.flush()  # a second upsert of the same key in this transaction must find the row


# ---------------------------------------------------------------------------
# Weather (simulated)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Weather:
    wind_mps: float
    gust_mps: float
    rain: bool
    flyable: bool
    updated_at: datetime
    simulated: bool = True


def is_flyable(wind_mps: float, gust_mps: float, rain: bool, cfg: SafetyConfig) -> bool:
    if rain and cfg.rain_blocks_flight:
        return False
    return wind_mps <= cfg.max_wind_mps and gust_mps <= cfg.max_gust_mps


def _in_window(phase: float, windows: tuple[tuple[float, float], ...]) -> bool:
    return any(start <= phase < end for start, end in windows)


def weather_at(
    now: datetime,
    *,
    weather_cfg: WeatherConfig | None = None,
    safety_cfg: SafetyConfig | None = None,
) -> Weather:
    """The seeded weather timeline at `now`: calm steps, a storm window and a rain window every period."""
    wcfg = weather_cfg or WEATHER
    scfg = safety_cfg or SAFETY
    at = _utc(now)
    if not wcfg.enabled:
        return Weather(0.0, 0.0, False, True, at)
    t = at.timestamp()
    phase = (t % wcfg.period_s) / wcfg.period_s
    bucket = int(t // wcfg.step_s)
    rng = random.Random(f"{wcfg.seed}:{bucket}")
    wind_range = wcfg.storm_wind_mps if _in_window(phase, wcfg.storm_windows) else wcfg.calm_wind_mps
    wind = rng.uniform(*wind_range)
    gust = wind + rng.uniform(*wcfg.gust_extra_mps)
    rain = _in_window(phase, wcfg.rain_windows)
    wind, gust = round(wind, 1), round(gust, 1)
    return Weather(wind, gust, rain, is_flyable(wind, gust, rain, scfg), at)


def set_weather_override(
    db: Session, wind_mps: float, gust_mps: float | None = None, rain: bool = False, *, commit: bool = True
) -> None:
    """Pin the weather (demo and tests) until `clear_weather_override`."""
    payload = {"wind_mps": float(wind_mps), "gust_mps": float(wind_mps if gust_mps is None else gust_mps), "rain": rain}
    _upsert_meta(db, _WEATHER_OVERRIDE_KEY, json.dumps(payload))
    if commit:
        db.commit()


def clear_weather_override(db: Session, *, commit: bool = True) -> None:
    row = db.get(AppMeta, _WEATHER_OVERRIDE_KEY)
    if row is not None:
        db.delete(row)
        db.flush()
    if commit:
        db.commit()


def current_weather(db: Session, now: datetime) -> Weather:
    """The pinned weather when one is set, else the seeded timeline."""
    scfg = SAFETY
    row = db.get(AppMeta, _WEATHER_OVERRIDE_KEY)
    if row is None:
        return weather_at(now)
    data = json.loads(row.value)
    wind, gust, rain = float(data["wind_mps"]), float(data["gust_mps"]), bool(data["rain"])
    return Weather(wind, gust, rain, is_flyable(wind, gust, rain, scfg), _utc(now))


def with_wind(energy_cfg: EnergyConfig, wind_mps: float) -> EnergyConfig:
    # Gate-only: wind raises the drain in launch / reserve checks; a dispatched mission's telemetry battery
    # still uses calm drain (known simplification).
    """`energy_cfg` with the wind that raises the battery drain (time is unchanged)."""
    return replace(energy_cfg, wind_mps=float(wind_mps))


# ---------------------------------------------------------------------------
# Decision log (capped, newest first, stored in AppMeta)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Decision:
    id: str
    at: datetime
    drone_id: str | None
    report_id: int | None
    action: str  # launch | hold | recall | abort
    code: str
    reason: str


def _decision_from_dict(d: dict) -> Decision:
    return Decision(
        id=d["id"],
        at=datetime.fromisoformat(d["at"]),
        drone_id=d.get("drone_id"),
        report_id=d.get("report_id"),
        action=d["action"],
        code=d["code"],
        reason=d["reason"],
    )


def _load_decisions(db: Session) -> list[dict]:
    row = db.get(AppMeta, _DECISIONS_KEY)
    return json.loads(row.value) if row is not None else []


def log_decision(
    db: Session,
    action: str,
    code: str,
    reason: str,
    *,
    at: datetime,
    drone_id: str | None = None,
    report_id: int | None = None,
) -> Decision:
    """Append a decision (kept newest first and capped at SAFETY.decision_log_max)."""
    seq_row = db.get(AppMeta, _DECISION_SEQ_KEY)
    seq = (int(seq_row.value) if seq_row is not None else 0) + 1
    _upsert_meta(db, _DECISION_SEQ_KEY, str(seq))
    entry = {
        "id": f"d{seq}",
        "at": _utc(at).isoformat(),
        "drone_id": drone_id,
        "report_id": report_id,
        "action": action,
        "code": code,
        "reason": reason,
    }
    entries = [entry, *_load_decisions(db)][: SAFETY.decision_log_max]
    _upsert_meta(db, _DECISIONS_KEY, json.dumps(entries))
    return _decision_from_dict(entry)


def list_decisions(db: Session, limit: int | None = None) -> list[Decision]:
    """Newest first."""
    cap = SAFETY.decision_log_max if limit is None else limit
    return [_decision_from_dict(d) for d in _load_decisions(db)[:cap]]


# ---------------------------------------------------------------------------
# Priority
# ---------------------------------------------------------------------------
def report_priority(report: Report, cfg: SafetyConfig | None = None) -> int:
    """Task priority from the server detections: worst class severity, plus a bonus for a confident box."""
    scfg = cfg or SAFETY
    boxes = [d for d in report.detections if d.source == "server" and not d.flagged_wrong]
    if not boxes:
        return scfg.priority_default
    severity = max(scfg.priority_by_severity.get(d.cls, scfg.priority_default) for d in boxes)
    confident = any(d.confidence >= scfg.priority_confidence_min for d in boxes)
    return severity + (scfg.priority_confidence_bonus if confident else 0)


# ---------------------------------------------------------------------------
# Go / no-go
# ---------------------------------------------------------------------------
class _Target(Protocol):
    lat: float
    lon: float


class _Drone(Protocol):
    drone_id: str
    status: DroneStatus
    battery_pct: float

    @property
    def position(self) -> tuple[float, float, float]: ...


@dataclass(frozen=True)
class LaunchPoint:
    """A drone as it would be at launch time (position and battery from a projection)."""

    drone_id: str
    position: tuple[float, float, float]
    battery_pct: float
    status: DroneStatus = DroneStatus.idle


@dataclass(frozen=True)
class GateResult:
    go: bool
    code: str  # "go" or the first failing check
    reasons: list[str] = field(default_factory=list)
    hold: bool = False  # True: the task should wait on the ground (see HOLD_CODES)

    @property
    def reason(self) -> str:
        return "; ".join(self.reasons)


def can_fly(
    drone: _Drone,
    task: _Target,
    now: datetime,
    *,
    weather: Weather | None = None,
    fleet_cfg: FleetConfig = FLEET,
    energy_cfg: EnergyConfig = ENERGY,
    planner: FlightPlanner | None = None,
) -> GateResult:
    """Go / no-go for `drone` flying to `task` at `now`.

    Checks, in order: offline, service area, rain, wind, gusts, battery at launch, and the round trip with
    the wind-adjusted drain. `reasons` lists every failed check in plain words.
    """
    cfg = SAFETY
    if not cfg.enabled:
        return GateResult(True, "go")
    wx = weather or weather_at(now)
    failures: list[tuple[str, str]] = []

    if drone.status == DroneStatus.offline:
        failures.append(("offline", f"{drone.drone_id} is offline"))
    dist_m = haversine_m((fleet_cfg.base_lat, fleet_cfg.base_lon), (task.lat, task.lon))
    in_area = dist_m <= fleet_cfg.service_radius_m + fleet_cfg.area_epsilon_m
    if not in_area:
        failures.append(
            ("out_of_area", f"Target is {dist_m:.0f} m from base, outside the {fleet_cfg.service_radius_m:.0f} m area")
        )
    if wx.rain and cfg.rain_blocks_flight:
        failures.append(("rain", "Rain in the area"))
    if wx.wind_mps > cfg.max_wind_mps:
        failures.append(("wind", f"Wind {wx.wind_mps:.1f} m/s exceeds {cfg.max_wind_mps:.1f} m/s limit"))
    if wx.gust_mps > cfg.max_gust_mps:
        failures.append(("gust", f"Gusts {wx.gust_mps:.1f} m/s exceed {cfg.max_gust_mps:.1f} m/s limit"))
    if drone.battery_pct < cfg.min_launch_battery_pct:
        failures.append(
            (
                "low_battery",
                f"Battery {drone.battery_pct:.0f}% is below the {cfg.min_launch_battery_pct:.0f}% launch minimum",
            )
        )

    if in_area:
        failures.extend(_round_trip_failures(drone, task, wx, fleet_cfg, energy_cfg, planner))

    if not failures:
        return GateResult(True, "go")
    code = failures[0][0]
    return GateResult(False, code, [text for _, text in failures], hold=any(c in HOLD_CODES for c, _ in failures))


def _round_trip_failures(
    drone: _Drone,
    task: _Target,
    wx: Weather,
    fleet_cfg: FleetConfig,
    energy_cfg: EnergyConfig,
    planner: FlightPlanner | None,
) -> list[tuple[str, str]]:
    """Round trip must end with the reserve. Calm air failing is `insufficient_battery` (no hold); only
    wind making a feasible trip infeasible is `wind_range` (the task waits for the wind to drop)."""
    reserve = energy_cfg.reserve_pct

    def used_pct(cfg: EnergyConfig) -> float | None:
        use = planner if (planner is not None and cfg.wind_mps == planner.energy.wind_mps) else None
        active = use or FlightPlanner(energy=cfg, fleet=fleet_cfg)
        try:
            proposal = active.propose(
                task.lat,
                task.lon,
                drone_id=drone.drone_id,
                start_pos=drone.position,
                start_battery_pct=drone.battery_pct,
                return_to_home=True,
            )
        except OutOfServiceAreaError:
            return None
        return proposal.estimated_battery_pct

    calm_used = used_pct(with_wind(energy_cfg, 0.0))
    if calm_used is None:
        return []
    if drone.battery_pct - calm_used < reserve:
        return [
            (
                "insufficient_battery",
                f"Round trip needs {calm_used:.0f}% battery but only {max(0.0, drone.battery_pct - reserve):.0f}% "
                f"is usable above the {reserve:.0f}% reserve",
            )
        ]
    windy_used = used_pct(with_wind(energy_cfg, wx.wind_mps)) if wx.wind_mps > 0 else calm_used
    if windy_used is not None and drone.battery_pct - windy_used < reserve:
        return [
            (
                "wind_range",
                f"Wind {wx.wind_mps:.1f} m/s raises the round trip to {windy_used:.0f}% battery, "
                f"above the {max(0.0, drone.battery_pct - reserve):.0f}% usable over the reserve",
            )
        ]
    return []


class SafetyGate:
    """One go / no-go context for an allocation pass: the weather is read once, every check is recorded.

    `energy_cfg` is the caller's energy config with the current wind applied, so every reserve check in the
    allocators becomes wind-adjusted. `rejections` keeps, per task, the most relevant failed check; a task
    that at least one drone may fly (`passed`) is not safety-blocked.
    """

    def __init__(
        self,
        db: Session,
        now: datetime,
        *,
        fleet_cfg: FleetConfig = FLEET,
        energy_cfg: EnergyConfig = ENERGY,
        weather: Weather | None = None,
    ) -> None:
        self.now = _utc(now)
        self.fleet_cfg = fleet_cfg
        self.weather = weather or current_weather(db, now)
        self.energy_cfg = with_wind(energy_cfg, self.weather.wind_mps)
        self.rejections: dict[int, GateResult] = {}
        self.passed: set[int] = set()
        self._planner = FlightPlanner(energy=self.energy_cfg, fleet=fleet_cfg)

    def check(self, drone: _Drone, task) -> bool:
        result = can_fly(
            drone,
            task,
            self.now,
            weather=self.weather,
            fleet_cfg=self.fleet_cfg,
            energy_cfg=self.energy_cfg,
            planner=self._planner,
        )
        task_id = int(task.task_id)
        if result.go:
            self.passed.add(task_id)
            return True
        known = self.rejections.get(task_id)
        if known is None or (result.hold and not known.hold):
            self.rejections[task_id] = result
        return False

    def blocked(self, task_id: int) -> GateResult | None:
        """The hold reason of a task that no drone may fly right now, else None."""
        result = self.rejections.get(task_id)
        if result is None or task_id in self.passed or not result.hold:
            return None
        return result


# ---------------------------------------------------------------------------
# Mid-flight check
# ---------------------------------------------------------------------------
def unsafe_in_flight(wx: Weather, cfg: SafetyConfig | None = None) -> tuple[str, str] | None:
    """(code, reason) when the weather is bad enough to recall a flying drone, else None.
    Wind and gusts need the launch limit plus `recall_wind_margin_mps`, so a drone is not recalled by noise."""
    scfg = cfg or SAFETY
    if wx.rain and scfg.rain_blocks_flight:
        return "rain", "Rain started"
    limit = scfg.max_wind_mps + scfg.recall_wind_margin_mps
    if wx.wind_mps > limit:
        return "wind", f"Wind {wx.wind_mps:.1f} m/s exceeds {limit:.1f} m/s in-flight limit"
    gust_limit = scfg.max_gust_mps + scfg.recall_wind_margin_mps
    if wx.gust_mps > gust_limit:
        return "gust", f"Gusts {wx.gust_mps:.1f} m/s exceed {gust_limit:.1f} m/s in-flight limit"
    return None


def mid_flight_check(
    db: Session,
    now: datetime,
    *,
    weather: Weather | None = None,
    fleet_cfg: FleetConfig = FLEET,
    energy_cfg: EnergyConfig = ENERGY,
) -> list[Mission]:
    """Recall every flying mission when the weather turns bad (dispatcher.recall_mission: the drone flies
    home and the task goes back to the queue, where the gate holds it until the weather clears)."""
    cfg = SAFETY
    if not cfg.enabled or not cfg.mid_flight_recall:
        return []
    wx = weather or current_weather(db, now)
    verdict = unsafe_in_flight(wx, cfg)
    if verdict is None:
        return []
    code, why = verdict

    from app.services.dispatcher import recall_mission  # lazy: the dispatcher imports this module

    recalled: list[Mission] = []
    skipped: set[int] = set()
    while True:
        flying = db.scalars(
            select(Mission)
            .where(Mission.state.in_(FLYING_STATES), Mission.started_at.is_not(None))
            .order_by(Mission.started_at.asc(), Mission.id.asc())
        ).all()
        mission = next((m for m in flying if m.id not in skipped), None)
        if mission is None:
            return recalled
        skipped.add(mission.id)
        try:
            recalled.append(
                recall_mission(
                    db,
                    mission.id,
                    reason=f"Recalled by the drone: {why}",
                    now=now,
                    fleet_cfg=fleet_cfg,
                    energy_cfg=energy_cfg,
                    code=code,
                    action="recall",
                )
            )
        except HTTPException:
            continue  # already landed or finished: nothing to recall
