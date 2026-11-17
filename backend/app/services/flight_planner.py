"""Propose a UAV flight plan for a confirmed report (§2.1 step 2). Owner: Hoan (SCRUM-27)."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from config import ENERGY, FLEET, MOCK, UAV, EnergyConfig, FleetConfig, MockConfig, UavConfig
from sim.energy import bearing_deg, destination, estimate, haversine_m

# Words in the monitor's change request that set the direction of the change (otherwise a stable hash does).
_LOWER = ("lower", "descend", "closer", "too high")
_HIGHER = ("higher", "raise", "climb", "too low")
_SMALLER = ("smaller", "tighter", "narrow", "too wide", "too big")
_WIDER = ("wider", "larger", "bigger", "too small", "too narrow")


class OutOfServiceAreaError(ValueError):
    """Target lies outside the district fleet's configured service radius."""


@dataclass
class ProposedPlan:
    drone_id: str
    altitude_m: float
    survey_radius_m: float
    route: list[dict]  # [{"lat", "lon", "alt", "action"}], takeoff -> target -> survey -> land
    estimated_duration_s: float = 0.0
    estimated_battery_pct: float = 0.0
    start_battery_pct: float = ENERGY.full_battery_pct


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
    def __init__(
        self,
        cfg: UavConfig = UAV,
        mock: MockConfig = MOCK,
        energy: EnergyConfig = ENERGY,
        fleet: FleetConfig = FLEET,
    ) -> None:
        self.cfg = cfg
        self.mock = mock
        self.energy = energy
        self.fleet = fleet

    def propose(
        self,
        target_lat: float,
        target_lon: float,
        previous_reason: str | None = None,
        *,
        drone_id: str | None = None,
        start_pos: tuple[float, float] | tuple[float, float, float] | None = None,
        start_battery_pct: float | None = None,
        return_to_home: bool = True,
    ) -> ProposedPlan:
        """Build a survey route and energy/time estimate for a target pin."""
        home = (
            (self.cfg.home_lat, self.cfg.home_lon)
            if self.fleet is FLEET
            else (self.fleet.base_lat, self.fleet.base_lon)
        )
        target = (float(target_lat), float(target_lon))
        dist_from_base_m = haversine_m(home, target)
        if dist_from_base_m > self.fleet.service_radius_m + 1e-3:
            raise OutOfServiceAreaError(
                f"Target ({target_lat:.5f}, {target_lon:.5f}) is {dist_from_base_m:.0f} m from base, "
                f"outside the {self.fleet.service_radius_m:.0f} m service area"
            )

        altitude = self.cfg.default_altitude_m
        radius = self.cfg.survey_radius_m
        if previous_reason and previous_reason.strip():
            alt_factor, rad_factor = _replan_factors(previous_reason, self.mock.replan_step_pct)
            altitude, radius = round(altitude * alt_factor, 1), round(radius * rad_factor, 1)

        chosen_drone = drone_id or self.fleet.drone_ids[0]
        start_bat = float(self.energy.full_battery_pct if start_battery_pct is None else start_battery_pct)
        if start_pos is None:
            origin = home
            origin_alt = 0.0
            in_air = False
        else:
            origin = (float(start_pos[0]), float(start_pos[1]))
            origin_alt = float(start_pos[2]) if len(start_pos) == 3 else 0.0
            in_air = origin_alt > 0.0

        start = bearing_deg(origin, target) if origin != target else 0.0
        points = max(1, self.mock.survey_points)

        first_wp = (
            {"lat": origin[0], "lon": origin[1], "alt": origin_alt, "action": "fly"}
            if in_air
            else {"lat": origin[0], "lon": origin[1], "alt": altitude, "action": "takeoff"}
        )
        route = [
            first_wp,
            {"lat": target[0], "lon": target[1], "alt": altitude, "action": "fly"},
        ]
        for k in range(points):
            lat, lon = destination(target, start + 360.0 * k / points, radius)
            route.append({"lat": round(lat, 7), "lon": round(lon, 7), "alt": altitude, "action": "survey"})
        if return_to_home:
            route += [
                {"lat": home[0], "lon": home[1], "alt": altitude, "action": "fly"},
                {"lat": home[0], "lon": home[1], "alt": 0.0, "action": "land"},
            ]

        est = estimate(route, start_battery_pct=start_bat, start_pos=start_pos, cfg=self.energy)
        return ProposedPlan(
            chosen_drone,
            altitude,
            radius,
            route,
            estimated_duration_s=est.duration_s,
            estimated_battery_pct=est.battery_used_pct,
            start_battery_pct=start_bat,
        )
