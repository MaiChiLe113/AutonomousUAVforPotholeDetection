"""Distance-based flight timing, battery drain model, and simulated clock (docs/fleet-plan.md §4).

Pure functions only: no I/O, no threads, no database, no randomness. Flight estimates and the
simulated telemetry timeline use the exact same `estimate` function so predicted duration and
battery consumption always match the simulated flight.
"""

from __future__ import annotations

import math
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, fields
from typing import Any

from config import ENERGY, EnergyConfig

EARTH_RADIUS_M = 6_371_000.0

_CRUISE_PHASES = ("outbound", "return")
_HOVER_PHASES = ("climb", "survey", "descent")


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------
def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in metres between two (lat, lon) points in degrees."""
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def bearing_deg(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Initial bearing from a to b, degrees clockwise from north, in [0, 360)."""
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dlon = lon2 - lon1
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return math.degrees(math.atan2(x, y)) % 360.0


def destination(origin: tuple[float, float], bearing: float, distance_m: float) -> tuple[float, float]:
    """The (lat, lon) reached from `origin` after `distance_m` metres on `bearing` degrees."""
    lat1, lon1 = math.radians(origin[0]), math.radians(origin[1])
    brg, d = math.radians(bearing), distance_m / EARTH_RADIUS_M
    lat2 = math.asin(math.sin(lat1) * math.cos(d) + math.cos(lat1) * math.sin(d) * math.cos(brg))
    y = math.sin(brg) * math.sin(d) * math.cos(lat1)
    x = math.cos(d) - math.sin(lat1) * math.sin(lat2)
    lon2 = lon1 + math.atan2(y, x)
    return math.degrees(lat2), (math.degrees(lon2) + 540.0) % 360.0 - 180.0


def route_target(route: list[dict]) -> tuple[float, float]:
    """The surveyed point of a route: mean of the survey waypoints, else the first "fly" waypoint,
    else the last waypoint."""
    if not route:
        raise ValueError("route is empty")
    survey = [wp for wp in route if wp.get("action") == "survey"]
    if survey:
        return sum(wp["lat"] for wp in survey) / len(survey), sum(wp["lon"] for wp in survey) / len(survey)
    fly = next((wp for wp in route if wp.get("action") == "fly"), route[-1])
    return fly["lat"], fly["lon"]


# ---------------------------------------------------------------------------
# Simulated clock
# ---------------------------------------------------------------------------
def _validated_time_scale(cfg: EnergyConfig) -> float:
    if not math.isfinite(cfg.time_scale) or cfg.time_scale <= 0:
        raise ValueError(f"time_scale must be finite and positive (got {cfg.time_scale})")
    return float(cfg.time_scale)


def sim_seconds(wall_s: float, cfg: EnergyConfig = ENERGY) -> float:
    """Convert elapsed wall-clock seconds to simulated seconds."""
    return float(wall_s) * _validated_time_scale(cfg)


def wall_seconds(sim_s: float, cfg: EnergyConfig = ENERGY) -> float:
    """Convert simulated seconds to elapsed wall-clock seconds."""
    return float(sim_s) / _validated_time_scale(cfg)


# ---------------------------------------------------------------------------
# Phase speed and drain model
# ---------------------------------------------------------------------------
def phase_speed_mps(phase: str, cfg: EnergyConfig = ENERGY) -> float:
    """Flight speed (m/s) for a leg phase."""
    speeds = {
        "climb": cfg.climb_speed_mps,
        "outbound": cfg.cruise_speed_mps,
        "survey": cfg.survey_speed_mps,
        "return": cfg.cruise_speed_mps,
        "descent": cfg.descent_speed_mps,
    }
    if phase not in speeds:
        raise ValueError(f"unknown flight phase {phase!r}")
    speed = float(speeds[phase])
    if not math.isfinite(speed) or speed <= 0:
        raise ValueError(f"speed for phase {phase!r} must be positive (got {speed})")
    return speed


def phase_drain_pct_per_s(phase: str, cfg: EnergyConfig = ENERGY) -> float:
    """Battery drain rate (% per simulated second) including `cfg.safety_factor`."""
    if phase in _CRUISE_PHASES:
        endurance_min = cfg.cruise_endurance_min
    elif phase in _HOVER_PHASES:
        endurance_min = cfg.hover_endurance_min
    else:
        raise ValueError(f"unknown flight phase {phase!r}")
    if not math.isfinite(endurance_min) or endurance_min <= 0:
        raise ValueError(f"endurance_min for phase {phase!r} must be positive (got {endurance_min})")
    return (100.0 / (endurance_min * 60.0)) * cfg.safety_factor


# ---------------------------------------------------------------------------
# Timed legs and route energy estimator
# ---------------------------------------------------------------------------
class _FieldMapping(Mapping[str, Any]):
    """Expose dataclass fields via Mapping interface so callers can use attributes or dict keys."""

    _extra_keys: tuple[str, ...] = ()

    def _keys(self) -> tuple[str, ...]:
        return tuple(f.name for f in fields(self)) + self._extra_keys  # type: ignore[arg-type]

    def __getitem__(self, key: str) -> Any:
        if key in self._keys():
            return getattr(self, key)
        raise KeyError(key)

    def __iter__(self) -> Iterator[str]:
        return iter(self._keys())

    def __len__(self) -> int:
        return len(self._keys())


@dataclass(frozen=True)
class TimedLeg(_FieldMapping):
    start: tuple[float, float, float]  # lat, lon, alt above home
    end: tuple[float, float, float]
    waypoint: int  # 0-based route index the leg flies to
    phase: str
    length_m: float  # 3D length
    heading: float
    t0: float = 0.0
    t1: float = 0.0
    b0: float = 100.0
    b1: float = 100.0
    battery_used_pct: float = 0.0

    _extra_keys = ("duration_s",)

    @property
    def duration_s(self) -> float:
        return self.t1 - self.t0


@dataclass(frozen=True)
class RouteEstimate(_FieldMapping):
    duration_s: float
    battery_used_pct: float
    legs: list[TimedLeg]
    start_battery_pct: float
    end_battery_pct: float


def _initial_point(
    route: list[dict],
    start_pos: tuple[float, float] | tuple[float, float, float] | None,
) -> tuple[float, float, float]:
    first = route[0]
    if start_pos is not None:
        if len(start_pos) == 3:
            return float(start_pos[0]), float(start_pos[1]), float(start_pos[2])
        alt0 = 0.0 if first.get("action") == "takeoff" else float(first["alt"])
        return float(start_pos[0]), float(start_pos[1]), alt0
    if first.get("action") == "takeoff":
        return float(first["lat"]), float(first["lon"]), 0.0
    return float(first["lat"]), float(first["lon"]), float(first["alt"])


def _phase_of(
    index: int,
    action: str,
    point: tuple[float, float, float],
    prev: tuple[float, float, float],
    horiz_d: float,
    last_survey: int | None,
) -> str:
    if action == "takeoff" or (index == 0 and point[2] > prev[2] and horiz_d == 0.0):
        return "climb"
    if action == "land":
        return "descent"
    if action == "survey":
        return "survey"
    return "outbound" if last_survey is None or index < last_survey else "return"


def estimate(
    route: list[dict],
    start_battery_pct: float = ENERGY.full_battery_pct,
    *,
    start_pos: tuple[float, float] | tuple[float, float, float] | None = None,
    cfg: EnergyConfig = ENERGY,
) -> RouteEstimate:
    """Estimate simulated flight duration, battery usage, and timed legs for `route`.

    Supports both ground-start routes (first waypoint `action == "takeoff"`, climbing from `alt=0`)
    and airborne routes for chained missions (starting from `start_pos` or `route[0]` at altitude).
    """
    if not route:
        raise ValueError("route is empty")

    last_survey = next(
        (i for i in range(len(route) - 1, -1, -1) if route[i].get("action") == "survey"),
        None,
    )
    raw: list[tuple[tuple[float, float, float], tuple[float, float, float], int, str]] = []
    prev = _initial_point(route, start_pos)
    for i, wp in enumerate(route):
        action = wp.get("action", "fly")
        point = (float(wp["lat"]), float(wp["lon"]), float(wp["alt"]))
        horiz_d = haversine_m(prev[:2], point[:2])
        phase = _phase_of(i, action, point, prev, horiz_d, last_survey)
        raw.append((prev, point, i, phase))
        prev = point

    if route[-1].get("action") == "land" and prev[2] > 0:
        raw.append((prev, (prev[0], prev[1], 0.0), len(route) - 1, "descent"))

    horiz = [haversine_m(s[:2], e[:2]) for s, e, _, _ in raw]
    moving = [bearing_deg(s[:2], e[:2]) for (s, e, _, _), h in zip(raw, horiz, strict=True) if h > 0]
    heading = moving[0] if moving else 0.0
    headings: list[float] = []
    for (s, e, _, _), h in zip(raw, horiz, strict=True):
        heading = bearing_deg(s[:2], e[:2]) if h > 0 else heading
        headings.append(heading)

    legs: list[TimedLeg] = []
    t = 0.0
    cum_bat = 0.0
    start_bat = float(start_battery_pct)
    for (start, end, index, phase), h, hdg in zip(raw, horiz, headings, strict=True):
        length_m = math.hypot(h, end[2] - start[2])
        dt = length_m / phase_speed_mps(phase, cfg)
        if phase == "survey" and cfg.survey_dwell_s > 0:
            dt += cfg.survey_dwell_s
        leg_bat = dt * phase_drain_pct_per_s(phase, cfg)
        raw_b0 = start_bat - cum_bat
        raw_b1 = raw_b0 - leg_bat
        b0 = min(100.0, max(0.0, raw_b0))
        b1 = min(100.0, max(0.0, raw_b1))
        legs.append(TimedLeg(start, end, index, phase, length_m, hdg, t, t + dt, b0, b1, leg_bat))
        t += dt
        cum_bat += leg_bat

    used_pct = round(cum_bat, 2)
    end_pct = round(max(0.0, min(100.0, start_bat - used_pct)), 2)
    return RouteEstimate(
        duration_s=round(t, 2),
        battery_used_pct=used_pct,
        legs=legs,
        start_battery_pct=round(start_bat, 2),
        end_battery_pct=end_pct,
    )
