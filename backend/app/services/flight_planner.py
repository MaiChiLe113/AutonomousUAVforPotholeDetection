"""Propose a UAV flight plan for a confirmed report (§2.1 step 2). Owner: Hoan (SCRUM-27)."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from config import MOCK, UAV, MockConfig, UavConfig
from sim.mock_flight import bearing_deg, destination

# Words in the monitor's change request that set the direction of the change (otherwise a stable hash does).
_LOWER = ("lower", "descend", "closer", "too high")
_HIGHER = ("higher", "raise", "climb", "too low")
_SMALLER = ("smaller", "tighter", "narrow", "too wide", "too big")
_WIDER = ("wider", "larger", "bigger", "too small", "too narrow")


@dataclass
class ProposedPlan:
    drone_id: str
    altitude_m: float
    survey_radius_m: float
    route: list[dict]  # [{"lat", "lon", "alt", "action"}], takeoff -> target -> survey -> land


def _direction(reason: str, down: tuple[str, ...], up: tuple[str, ...], bit: int) -> int:
    text = reason.lower()
    if any(word in text for word in down):
        return -1
    if any(word in text for word in up):
        return 1
    return 1 if bit else -1


def _replan_factors(reason: str, step_pct: float) -> tuple[float, float]:
    """Deterministic (altitude, radius) multipliers for a change request: each moves 1-2 steps of
    `step_pct`, so the new version always differs from the default plan."""
    digest = hashlib.sha256(reason.strip().lower().encode()).digest()
    alt_steps = _direction(reason, _LOWER, _HIGHER, digest[0] & 1) * (1 + (digest[1] & 1))
    rad_steps = _direction(reason, _SMALLER, _WIDER, digest[2] & 1) * (1 + (digest[3] & 1))
    return (1 + step_pct) ** alt_steps, (1 + step_pct) ** rad_steps


class FlightPlanner:
    def __init__(self, cfg: UavConfig = UAV, mock: MockConfig = MOCK) -> None:
        self.cfg = cfg
        self.mock = mock

    def propose(self, target_lat: float, target_lon: float, previous_reason: str | None = None) -> ProposedPlan:
        """Takeoff at home, fly to the pin, survey pattern of cfg.survey_radius_m, return and land.
        `previous_reason` is the admin's change request, if any.

        Route (12 waypoints with the default `survey_points` of 8):
        takeoff at home (climb to altitude) -> fly to the target -> `survey_points` survey waypoints on a
        circle of the survey radius around the target, clockwise, starting straight ahead of the approach ->
        fly back above home -> land at home (alt 0). `alt` is metres above home.

        With `previous_reason`, altitude and radius each change by 1-2 steps of `mock.replan_step_pct`,
        decided by the reason text: words like "lower"/"higher" and "smaller"/"wider" set the direction,
        otherwise a hash of the text does. The same reason always gives the same plan.
        """
        altitude = self.cfg.default_altitude_m
        radius = self.cfg.survey_radius_m
        if previous_reason and previous_reason.strip():
            alt_factor, rad_factor = _replan_factors(previous_reason, self.mock.replan_step_pct)
            altitude, radius = round(altitude * alt_factor, 1), round(radius * rad_factor, 1)

        home = (self.cfg.home_lat, self.cfg.home_lon)
        target = (target_lat, target_lon)
        start = bearing_deg(home, target) if home != target else 0.0
        points = max(1, self.mock.survey_points)

        route = [
            {"lat": home[0], "lon": home[1], "alt": altitude, "action": "takeoff"},
            {"lat": target_lat, "lon": target_lon, "alt": altitude, "action": "fly"},
        ]
        for k in range(points):
            lat, lon = destination(target, start + 360.0 * k / points, radius)
            route.append({"lat": round(lat, 7), "lon": round(lon, 7), "alt": altitude, "action": "survey"})
        route += [
            {"lat": home[0], "lon": home[1], "alt": altitude, "action": "fly"},
            {"lat": home[0], "lon": home[1], "alt": 0.0, "action": "land"},
        ]
        return ProposedPlan(self.cfg.drone_ids[0], altitude, radius, route)
