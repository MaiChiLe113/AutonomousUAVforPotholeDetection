"""Time-based mock flight for the prototype: telemetry and edge results computed on read (SCRUM-33).

Pure functions only: no I/O, no threads, no database, no randomness. The same inputs always give the
same output, so the API can recompute the UAV state from the mission start time on every request.

Route format (same as `schemas.Waypoint` and `FlightPlanner.propose`): a list of
`{"lat", "lon", "alt", "action"}` with action "takeoff" | "fly" | "survey" | "land". `alt` is the height
in metres above home. Routes may start on the ground at home or in the air (chained missions).

Timeline and battery drain come from `sim.energy.estimate`, so flight estimates and simulated
telemetry always share the exact same timing and battery calculations in simulated seconds.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import replace

from config import DATA, ENERGY, MOCK, UAV, EnergyConfig, MockConfig, UavConfig
from sim.energy import (
    EARTH_RADIUS_M,
    TimedLeg,
    bearing_deg,
    destination,
    estimate,
    haversine_m,
    route_target,
)

__all__ = [
    "EARTH_RADIUS_M",
    "bearing_deg",
    "destination",
    "edge_results",
    "flight_duration_s",
    "haversine_m",
    "route_target",
    "telemetry_at",
]

_Leg = TimedLeg

_PHASE_STATE = {
    "climb": "takeoff",
    "outbound": "takeoff",
    "survey": "surveying",
    "return": "landing",
    "descent": "landing",
}


# ---------------------------------------------------------------------------
# Timeline
# ---------------------------------------------------------------------------
def _legs(
    route: list[dict],
    duration_s: float | None = None,
    cfg: MockConfig = MOCK,
    *,
    start_battery_pct: float = ENERGY.full_battery_pct,
    start_pos: tuple[float, float] | tuple[float, float, float] | None = None,
    energy_cfg: EnergyConfig = ENERGY,
) -> list[TimedLeg]:
    """Split the route into timed legs using `sim.energy.estimate`."""
    del duration_s, cfg  # kept for backwards compatibility with earlier callers
    return estimate(route, start_battery_pct, start_pos=start_pos, cfg=energy_cfg).legs


def flight_duration_s(
    route: list[dict],
    cfg: MockConfig = MOCK,
    *,
    start_pos: tuple[float, float] | tuple[float, float, float] | None = None,
    energy_cfg: EnergyConfig = ENERGY,
) -> float:
    """Simulated flight duration in seconds from `sim.energy.estimate`."""
    del cfg
    return estimate(route, start_pos=start_pos, cfg=energy_cfg).duration_s


def telemetry_at(
    route: list[dict],
    elapsed_s: float,
    drone_id: str,
    home: tuple[float, float, float],
    cfg: MockConfig = MOCK,
    *,
    start_battery_pct: float = ENERGY.full_battery_pct,
    start_pos: tuple[float, float] | tuple[float, float, float] | None = None,
    energy_cfg: EnergyConfig = ENERGY,
    time_scale: float | None = None,
) -> dict:
    """UAV telemetry `elapsed_s` simulated seconds after dispatch (internal snake_case fields).

    `home` is (lat, lon, alt_m). `elapsed_s` is clamped to [0, duration]. State and gimbal follow the phase
    table. `altitude_m` is height above home. `current_waypoint` is the 0-based route index the UAV is
    flying to (the last index once done). Distances are horizontal (haversine) metres.
    Battery drains by phase rate from `sim.energy.estimate`, starting from `start_battery_pct`.
    """
    active_energy = replace(energy_cfg, time_scale=time_scale) if time_scale is not None else energy_cfg
    est = estimate(route, start_battery_pct, start_pos=start_pos, cfg=active_energy)
    duration = est.duration_s
    legs = est.legs
    t = min(max(float(elapsed_s), 0.0), duration)
    done = t >= duration

    if done:
        leg, frac = legs[-1], 1.0
        battery = est.end_battery_pct
    else:
        leg = next((lg for lg in legs if t < lg.t1), legs[-1])
        span = leg.t1 - leg.t0
        frac = min(1.0, max(0.0, (t - leg.t0) / span)) if span > 0 else 1.0
        battery = round(leg.b0 + (leg.b1 - leg.b0) * frac, 2)

    lat = leg.start[0] + (leg.end[0] - leg.start[0]) * frac
    lon = leg.start[1] + (leg.end[1] - leg.start[1]) * frac
    alt = leg.start[2] + (leg.end[2] - leg.start[2]) * frac

    progress = t / duration if duration > 0 else 1.0
    pitch = cfg.gimbal_survey_pitch_deg if leg.phase == "survey" and not done else cfg.gimbal_transit_pitch_deg
    heading = round(leg.heading % 360.0, 1)

    return {
        "lat": round(lat, 7),
        "lon": round(lon, 7),
        "altitude_m": round(alt, 2),
        "heading_deg": heading,
        "state": "done" if done else _PHASE_STATE[leg.phase],
        "drone_id": drone_id,
        "home_lat": home[0],
        "home_lon": home[1],
        "home_alt_m": home[2],
        "distance_to_home_m": round(haversine_m((lat, lon), (home[0], home[1])), 1),
        "distance_to_target_m": round(haversine_m((lat, lon), route_target(route)), 1),
        "gimbal_pitch_deg": float(pitch),
        "gimbal_yaw_deg": heading,
        "gimbal_roll_deg": 0.0,  # stabilised gimbal
        "battery_pct": battery,
        "in_mission": not done,
        "current_waypoint": leg.waypoint,
        "progress_pct": round(progress * 100.0, 1),
    }


# ---------------------------------------------------------------------------
# Edge results
# ---------------------------------------------------------------------------
def _unit(*parts: object) -> float:
    """A stable number in [0, 1) from the inputs (sha256, not Python's salted hash())."""
    digest = hashlib.sha256("|".join(map(str, parts)).encode()).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def _between(bounds: tuple[float, float], u: float) -> float:
    return bounds[0] + (bounds[1] - bounds[0]) * u


def edge_results(
    report_detections: list[dict],
    target: tuple[float, float],
    altitude_m: float | None = None,
    cfg: MockConfig = MOCK,
    uav: UavConfig = UAV,
) -> list[dict]:
    """Fake detections from the Jetson (INT8) after the survey. An empty list means "not confirmed".

    Deterministic from the target and the report's detections: about `cfg.edge_confirm_rate` of inputs
    confirm. A confirmed result has one detection per server detection not flagged wrong (at least one,
    at most `cfg.edge_max_detections`) with the same class. Each frame pose is within `cfg.edge_jitter_m`
    of the target at `altitude_m` (default `uav.default_altitude_m`; pass the plan's altitude). The box is
    where the target falls in a nadir image of `uav.camera_resolution` with `uav.camera_fov_deg`, sized
    from `cfg.edge_defect_size_m`. Each dict has the `schemas.EdgeDetectionIn` fields.
    """
    alt = float(altitude_m if altitude_m is not None else uav.default_altitude_m)
    kept = [d for d in report_detections if not d.get("flagged_wrong")]
    key = f"{target[0]:.6f},{target[1]:.6f};" + ";".join(f"{d.get('id')}:{d.get('cls')}" for d in report_detections)
    if _unit(key, "confirm") >= cfg.edge_confirm_rate:
        return []

    classes = [str(d["cls"]) for d in kept if d.get("cls")]
    if not classes:
        classes = [DATA.classes[int(_unit(key, "cls") * len(DATA.classes))]]
    count = max(1, min(len(classes), cfg.edge_max_detections))

    width, height = uav.camera_resolution
    ground_width_m = 2 * alt * math.tan(math.radians(uav.camera_fov_deg) / 2)
    px_per_m = width / ground_width_m if ground_width_m > 0 else 0.0
    frame_tag = hashlib.sha256(key.encode()).hexdigest()[:6]

    results = []
    for i in range(count):
        u = [_unit(key, i, n) for n in range(6)]
        pose_lat, pose_lon = destination(target, 360.0 * u[0], cfg.edge_jitter_m * u[1])
        heading = 360.0 * u[2]

        # Target position relative to the UAV, rotated into the image (image "up" = UAV heading).
        dist = haversine_m((pose_lat, pose_lon), target)
        brg = math.radians(bearing_deg((pose_lat, pose_lon), target) - heading)
        right_m, up_m = dist * math.sin(brg), dist * math.cos(brg)
        cx, cy = width / 2 + right_m * px_per_m, height / 2 - up_m * px_per_m
        half_w = _between(cfg.edge_defect_size_m, u[3]) * px_per_m / 2
        half_h = _between(cfg.edge_defect_size_m, u[4]) * px_per_m / 2
        box = [
            round(min(max(cx - half_w, 0.0), width), 1),
            round(min(max(cy - half_h, 0.0), height), 1),
            round(min(max(cx + half_w, 0.0), width), 1),
            round(min(max(cy + half_h, 0.0), height), 1),
        ]

        results.append(
            {
                "frame_id": f"edge-{frame_tag}-{i + 1:03d}",
                "cls": classes[i % len(classes)],
                "confidence": round(_between(cfg.edge_confidence_range, u[5]), 3),
                "box_xyxy": box,
                "model_version": cfg.model_version,
                "deployment": cfg.edge_deployment,
                "pose": {
                    "lat": round(pose_lat, 7),
                    "lon": round(pose_lon, 7),
                    "altitude_m": round(alt, 2),
                    "heading_deg": round(heading, 1),
                },
                "image_size": [width, height],
            }
        )
    return results
