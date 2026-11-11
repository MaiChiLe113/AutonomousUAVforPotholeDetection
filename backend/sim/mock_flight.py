"""Time-based mock flight for the prototype: telemetry and edge results computed on read (SCRUM-33).

Pure functions only: no I/O, no threads, no database, no randomness. The same inputs always give the
same output, so the API can recompute the UAV state from the mission start time on every request.

Route format (same as `schemas.Waypoint` and `FlightPlanner.propose`): a list of
`{"lat", "lon", "alt", "action"}` with action "takeoff" | "fly" | "survey" | "land". `alt` is the height
in metres above home. The planner builds: takeoff at home -> fly to target -> survey circle -> fly home -> land.

Target: the centre of the "survey" waypoints (mean lat/lon). If the route has no survey waypoints, the
first "fly" waypoint; if it has none either, the last waypoint. See `route_target`.

Timeline of one flight (`flight_duration_s` = `MOCK.mission_duration_s`). The route is split into legs:
the first leg climbs from the ground at waypoint 0 to waypoint 0's altitude, then each leg flies to the next
waypoint (and, if the route does not end on the ground, a last leg descends there). Each leg belongs to one
phase, and each phase gets a share of the duration from `MOCK.flight_phase_shares`:

    phase      legs                                state        gimbal pitch
    climb      first leg (vertical, at takeoff)    "takeoff"    MOCK.gimbal_transit_pitch_deg
    outbound   "fly" legs before the first survey  "takeoff"    MOCK.gimbal_transit_pitch_deg
    survey     legs that end on a survey waypoint  "surveying"  MOCK.gimbal_survey_pitch_deg
    return     "fly" legs after the last survey    "landing"    MOCK.gimbal_transit_pitch_deg
    descent    the "land" leg                      "landing"    MOCK.gimbal_transit_pitch_deg

So "takeoff" covers the climb (first 10% with the default shares) and the transit to the target; "landing"
covers the return transit and the descent (last 10%). With this mapping the camera points straight down
exactly when the state is "surveying". A phase the route does not have gives its share to the others.
Inside a phase, time is split between legs by leg length. After the duration the state is "done".
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass

from config import DATA, MOCK, UAV, MockConfig, UavConfig

EARTH_RADIUS_M = 6_371_000.0

_PHASES = ("climb", "outbound", "survey", "return", "descent")
_PHASE_STATE = {
    "climb": "takeoff",
    "outbound": "takeoff",
    "survey": "surveying",
    "return": "landing",
    "descent": "landing",
}


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
# Timeline
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class _Leg:
    start: tuple[float, float, float]  # lat, lon, alt above home
    end: tuple[float, float, float]
    waypoint: int  # route index the leg flies to
    phase: str
    length_m: float  # 3D length
    heading: float
    t0: float = 0.0
    t1: float = 0.0


def _phase_of(index: int, action: str, first_survey: int | None) -> str:
    if index == 0 or action == "takeoff":
        return "climb"
    if action == "land":
        return "descent"
    if action == "survey":
        return "survey"
    return "outbound" if first_survey is None or index < first_survey else "return"


def _legs(route: list[dict], duration_s: float, cfg: MockConfig) -> list[_Leg]:
    """Split the route into timed legs (see the module docstring)."""
    if not route:
        raise ValueError("route is empty")
    first_survey = next((i for i, wp in enumerate(route) if wp.get("action") == "survey"), None)

    raw: list[tuple[tuple[float, float, float], tuple[float, float, float], int, str]] = []
    prev = (route[0]["lat"], route[0]["lon"], 0.0)  # on the ground at the takeoff point
    for i, wp in enumerate(route):
        point = (wp["lat"], wp["lon"], float(wp["alt"]))
        raw.append((prev, point, i, _phase_of(i, wp.get("action", "fly"), first_survey)))
        prev = point
    if prev[2] > 0:  # route ends in the air: descend where it ends
        raw.append((prev, (prev[0], prev[1], 0.0), len(route) - 1, "descent"))

    # Heading per leg; vertical legs keep the previous heading (legs before the first move take the first one).
    horiz = [haversine_m(s[:2], e[:2]) for s, e, _, _ in raw]
    moving = [bearing_deg(s[:2], e[:2]) for (s, e, _, _), h in zip(raw, horiz, strict=True) if h > 0]
    heading = moving[0] if moving else 0.0
    headings = []
    for (s, e, _, _), h in zip(raw, horiz, strict=True):
        heading = bearing_deg(s[:2], e[:2]) if h > 0 else heading
        headings.append(heading)

    # Time: each phase gets its share (re-normalised over the phases present), split by leg length.
    lengths = [math.hypot(h, e[2] - s[2]) for (s, e, _, _), h in zip(raw, horiz, strict=True)]
    phases = [phase for _, _, _, phase in raw]
    shares = dict(zip(_PHASES, cfg.flight_phase_shares, strict=True))
    share_total = sum(shares[p] for p in set(phases)) or 1.0
    phase_len = {p: sum(n for n, q in zip(lengths, phases, strict=True) if q == p) for p in set(phases)}

    legs: list[_Leg] = []
    t = 0.0
    for (start, end, index, phase), length, heading in zip(raw, lengths, headings, strict=True):
        part = length / phase_len[phase] if phase_len[phase] > 0 else 1 / phases.count(phase)
        dt = duration_s * shares[phase] / share_total * part
        legs.append(_Leg(start, end, index, phase, length, heading, t, t + dt))
        t += dt
    return legs


def flight_duration_s(route: list[dict], cfg: MockConfig = MOCK) -> float:
    """Seconds from dispatch to touchdown. Fixed by `cfg.mission_duration_s` (time-compressed demo flight);
    `route` is accepted so a distance-based duration can replace it later without changing callers."""
    return float(cfg.mission_duration_s)


def telemetry_at(
    route: list[dict],
    elapsed_s: float,
    drone_id: str,
    home: tuple[float, float, float],
    cfg: MockConfig = MOCK,
) -> dict:
    """UAV telemetry `elapsed_s` seconds after dispatch, using the internal snake_case field names.

    `home` is (lat, lon, alt_m). `elapsed_s` is clamped to [0, duration]. State and gimbal follow the phase
    table in the module docstring. `altitude_m` is height above home. `current_waypoint` is the 0-based route
    index the UAV is flying to (the last index once done). Distances are horizontal (haversine) metres.
    Battery drains linearly from `cfg.battery_start_pct` to `cfg.battery_end_pct` over the flight.
    """
    duration = flight_duration_s(route, cfg)
    t = min(max(float(elapsed_s), 0.0), duration)
    done = t >= duration
    legs = _legs(route, duration, cfg)

    if done:
        leg, frac = legs[-1], 1.0
    else:
        leg = next((lg for lg in legs if t < lg.t1), legs[-1])
        span = leg.t1 - leg.t0
        frac = (t - leg.t0) / span if span > 0 else 1.0
    lat = leg.start[0] + (leg.end[0] - leg.start[0]) * frac
    lon = leg.start[1] + (leg.end[1] - leg.start[1]) * frac
    alt = leg.start[2] + (leg.end[2] - leg.start[2]) * frac

    progress = t / duration if duration > 0 else 1.0
    pitch = cfg.gimbal_survey_pitch_deg if leg.phase == "survey" and not done else cfg.gimbal_transit_pitch_deg
    heading = round(leg.heading % 360.0, 1)
    battery = cfg.battery_start_pct + (cfg.battery_end_pct - cfg.battery_start_pct) * progress

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
        "battery_pct": round(battery, 1),
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
