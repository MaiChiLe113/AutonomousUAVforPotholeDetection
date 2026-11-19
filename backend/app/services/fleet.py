"""Fleet state, mission start tracking, battery swaps, and drone selection (docs/fleet-plan.md §7 Phase 2)."""

from __future__ import annotations

import enum
import json
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AppMeta, FlightPlan, Mission, MissionState
from app.services.flight_planner import FlightPlanner, OutOfServiceAreaError
from app.services.simclock import sim_delta, sim_elapsed_s
from config import ENERGY, FLEET, UAV, EnergyConfig, FleetConfig
from sim.energy import estimate, haversine_m
from sim.mock_flight import telemetry_at

_MISSION_START_PREFIX = "fleet:mission:"
_MISSION_END_PREFIX = "fleet:mission_end:"
_OFFLINE_PREFIX = "fleet:offline:"
_BASE_EPS_M = 1.0
_GROUND_ALT_EPS_M = 0.1


class DroneStatus(enum.StrEnum):
    idle = "idle"
    flying = "flying"
    returning = "returning"
    swapping = "swapping"
    offline = "offline"


@dataclass(frozen=True)
class MissionStart:
    lat: float
    lon: float
    alt_m: float
    battery_pct: float

    @property
    def pos(self) -> tuple[float, float, float]:
        return (self.lat, self.lon, self.alt_m)


@dataclass(frozen=True)
class MissionEnd:
    lat: float
    lon: float
    alt_m: float
    battery_pct: float
    recalled: bool = False

    @property
    def pos(self) -> tuple[float, float, float]:
        return (self.lat, self.lon, self.alt_m)


@dataclass(frozen=True)
class DroneState:
    drone_id: str
    status: DroneStatus
    lat: float
    lon: float
    altitude_m: float
    battery_pct: float
    base_lat: float
    base_lon: float
    base_alt_m: float
    available_at: datetime
    available_sim_s: float
    active_mission_id: int | None = None
    last_mission_id: int | None = None

    @property
    def position(self) -> tuple[float, float, float]:
        return (self.lat, self.lon, self.altitude_m)


def _utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


def _now_utc() -> datetime:
    return datetime.now(UTC)


def _mission_key(mission_id: int) -> str:
    return f"{_MISSION_START_PREFIX}{mission_id}"


def _mission_end_key(mission_id: int) -> str:
    return f"{_MISSION_END_PREFIX}{mission_id}"


def _offline_key(drone_id: str) -> str:
    return f"{_OFFLINE_PREFIX}{drone_id}"


def _upsert_meta(db: Session, key: str, value: str) -> None:
    row = db.get(AppMeta, key)
    if row is None:
        db.add(AppMeta(key=key, value=value))
    else:
        row.value = value


def record_mission_start(db: Session, mission: Mission, start: MissionStart, *, commit: bool = False) -> MissionStart:
    """Persist a mission's start position and battery so telemetry always recomputes deterministically."""
    payload = json.dumps(
        {
            "lat": float(start.lat),
            "lon": float(start.lon),
            "alt_m": float(start.alt_m),
            "battery_pct": float(start.battery_pct),
        }
    )
    _upsert_meta(db, _mission_key(mission.id), payload)
    if hasattr(mission, "start_lat"):
        mission.start_lat = start.lat
    if hasattr(mission, "start_lon"):
        mission.start_lon = start.lon
    if hasattr(mission, "start_battery_pct"):
        mission.start_battery_pct = start.battery_pct
    if commit:
        db.commit()
    else:
        db.flush()
    return start


def _read_stored_start(db: Session, mission: Mission) -> MissionStart | None:
    s_lat = getattr(mission, "start_lat", None)
    s_lon = getattr(mission, "start_lon", None)
    s_bat = getattr(mission, "start_battery_pct", None)
    if s_lat is not None and s_lon is not None and s_bat is not None:
        s_alt = float(getattr(mission, "start_alt_m", 0.0) or 0.0)
        return MissionStart(float(s_lat), float(s_lon), s_alt, float(s_bat))
    row = db.get(AppMeta, _mission_key(mission.id))
    if row is None:
        return None
    data = json.loads(row.value)
    return MissionStart(
        lat=float(data["lat"]),
        lon=float(data["lon"]),
        alt_m=float(data["alt_m"]),
        battery_pct=float(data["battery_pct"]),
    )


def get_mission_start(
    db: Session,
    mission: Mission,
    fleet_cfg: FleetConfig = FLEET,
    energy_cfg: EnergyConfig = ENERGY,
) -> MissionStart:
    """Return the stored start state of `mission`, falling back to route[0] and full battery."""
    stored = _read_stored_start(db, mission)
    if stored is not None:
        return stored
    route = mission.flight_plan.route if mission.flight_plan else []
    if route:
        wp0 = route[0]
        alt0 = 0.0 if wp0.get("action") == "takeoff" else float(wp0["alt"])
        return MissionStart(float(wp0["lat"]), float(wp0["lon"]), alt0, energy_cfg.full_battery_pct)
    return MissionStart(fleet_cfg.base_lat, fleet_cfg.base_lon, fleet_cfg.base_alt_m, energy_cfg.full_battery_pct)


def record_mission_end(db: Session, mission: Mission, end: MissionEnd, *, commit: bool = False) -> MissionEnd:
    """Persist an explicit end state (used when a mission is recalled or fails mid-flight)."""
    payload = json.dumps(
        {
            "lat": float(end.lat),
            "lon": float(end.lon),
            "alt_m": float(end.alt_m),
            "battery_pct": float(end.battery_pct),
            "recalled": bool(end.recalled),
        }
    )
    _upsert_meta(db, _mission_end_key(mission.id), payload)
    if commit:
        db.commit()
    else:
        db.flush()
    return end


def get_mission_end(db: Session, mission: Mission) -> MissionEnd | None:
    """Return the recorded end override for `mission`, if any."""
    row = db.get(AppMeta, _mission_end_key(mission.id))
    if row is None:
        return None
    data = json.loads(row.value)
    return MissionEnd(
        lat=float(data["lat"]),
        lon=float(data["lon"]),
        alt_m=float(data["alt_m"]),
        battery_pct=float(data["battery_pct"]),
        recalled=bool(data.get("recalled", False)),
    )


def set_drone_offline(db: Session, drone_id: str, offline: bool = True, *, commit: bool = True) -> None:
    """Mark a drone offline or online in AppMeta."""
    key = _offline_key(drone_id)
    row = db.get(AppMeta, key)
    if offline:
        _upsert_meta(db, key, "1")
    elif row is not None:
        db.delete(row)
    if commit:
        db.commit()
    else:
        db.flush()


def is_drone_offline(db: Session, drone_id: str) -> bool:
    row = db.get(AppMeta, _offline_key(drone_id))
    return row is not None and row.value == "1"


def _at_base_ground(pt: tuple[float, float, float], base: tuple[float, float, float]) -> bool:
    return haversine_m(pt[:2], base[:2]) <= _BASE_EPS_M and pt[2] <= _GROUND_ALT_EPS_M


def _return_route(pos: tuple[float, float, float], base: tuple[float, float, float]) -> list[dict]:
    cruise_alt = max(pos[2], UAV.default_altitude_m)
    return [
        {"lat": base[0], "lon": base[1], "alt": cruise_alt, "action": "fly"},
        {"lat": base[0], "lon": base[1], "alt": base[2], "action": "land"},
    ]


def _landed_from_mission_end(
    end_pt: tuple[float, float, float],
    end_bat: float,
    m_end_time: datetime,
    base: tuple[float, float, float],
    energy_cfg: EnergyConfig,
) -> tuple[datetime, float]:
    if _at_base_ground(end_pt, base):
        return m_end_time, end_bat
    ret_est = estimate(_return_route(end_pt, base), start_battery_pct=end_bat, start_pos=end_pt, cfg=energy_cfg)
    return m_end_time + sim_delta(ret_est.duration_s, energy_cfg), ret_est.end_battery_pct


def _available_after_landing(landed_at: datetime, landed_bat: float, energy_cfg: EnergyConfig) -> datetime:
    if landed_bat < energy_cfg.swap_below_pct:
        return landed_at + sim_delta(energy_cfg.swap_duration_s, energy_cfg)
    return landed_at


def _drone_missions(db: Session, drone_id: str, now: datetime) -> list[Mission]:
    query = (
        select(Mission)
        .join(FlightPlan, Mission.flight_plan_id == FlightPlan.id)
        .where(
            FlightPlan.drone_id == drone_id,
            Mission.started_at.is_not(None),
            Mission.state != MissionState.pending,
        )
        .order_by(Mission.started_at.asc(), Mission.id.asc())
    )
    return [m for m in db.scalars(query).all() if m.started_at is not None and _utc(m.started_at) <= now]


def get_drone_state(
    db: Session,
    drone_id: str,
    now: datetime | None = None,
    *,
    fleet_cfg: FleetConfig = FLEET,
    energy_cfg: EnergyConfig = ENERGY,
) -> DroneState:
    """Derive a drone's status, position, battery, and next available time at `now`."""
    now = _utc(now or _now_utc())
    base = (fleet_cfg.base_lat, fleet_cfg.base_lon, fleet_cfg.base_alt_m)
    offline = is_drone_offline(db, drone_id)

    pos = base
    battery = energy_cfg.full_battery_pct
    last_mission_id: int | None = None
    missions = _drone_missions(db, drone_id, now)

    for idx, m in enumerate(missions):
        assert m.started_at is not None
        started_at = _utc(m.started_at)
        stored = _read_stored_start(db, m)
        m_start = stored if stored is not None else MissionStart(pos[0], pos[1], pos[2], battery)
        route = m.flight_plan.route
        est = estimate(route, start_battery_pct=m_start.battery_pct, start_pos=m_start.pos, cfg=energy_cfg)
        elapsed_s = max(0.0, sim_elapsed_s(started_at, now, energy_cfg))

        still_flying = elapsed_s < est.duration_s - energy_cfg.time_epsilon_s
        if m.state not in (MissionState.done, MissionState.failed) and still_flying:
            sample = telemetry_at(
                route,
                elapsed_s,
                drone_id,
                base,
                start_battery_pct=m_start.battery_pct,
                start_pos=m_start.pos,
                energy_cfg=energy_cfg,
            )
            m_end_time = started_at + sim_delta(est.duration_s, energy_cfg)
            landed_at, landed_bat = _landed_from_mission_end(
                est.legs[-1].end, est.end_battery_pct, m_end_time, base, energy_cfg
            )
            avail_at = _available_after_landing(landed_at, landed_bat, energy_cfg)
            return DroneState(
                drone_id=drone_id,
                status=DroneStatus.offline if offline else DroneStatus.flying,
                lat=sample["lat"],
                lon=sample["lon"],
                altitude_m=sample["altitude_m"],
                battery_pct=sample["battery_pct"],
                base_lat=base[0],
                base_lon=base[1],
                base_alt_m=base[2],
                available_at=avail_at,
                available_sim_s=max(0.0, sim_elapsed_s(now, avail_at, energy_cfg)),
                active_mission_id=m.id,
                last_mission_id=m.id,
            )

        stored_end = get_mission_end(db, m)
        if stored_end is not None:
            m_end_time = (
                _utc(m.finished_at)
                if m.finished_at is not None
                else started_at + sim_delta(est.duration_s, energy_cfg)
            )
            end_pt = stored_end.pos
            end_bat = stored_end.battery_pct
            must_return = stored_end.recalled
        elif m.state == MissionState.failed:
            m_end_time = _utc(m.finished_at) if m.finished_at is not None else started_at
            fail_elapsed = max(0.0, sim_elapsed_s(started_at, m_end_time, energy_cfg))
            sample = telemetry_at(
                route,
                fail_elapsed,
                drone_id,
                base,
                start_battery_pct=m_start.battery_pct,
                start_pos=m_start.pos,
                energy_cfg=energy_cfg,
            )
            end_pt = (sample["lat"], sample["lon"], sample["altitude_m"])
            end_bat = sample["battery_pct"]
            must_return = False
        else:
            m_end_time = started_at + sim_delta(est.duration_s, energy_cfg)
            end_pt = est.legs[-1].end
            end_bat = est.end_battery_pct
            must_return = False

        next_start = _utc(missions[idx + 1].started_at) if idx + 1 < len(missions) else None  # type: ignore[arg-type]

        if _at_base_ground(end_pt, base):
            landed_at, landed_bat = m_end_time, end_bat
        else:
            ret_route = _return_route(end_pt, base)
            ret_est = estimate(ret_route, start_battery_pct=end_bat, start_pos=end_pt, cfg=energy_cfg)
            ret_done_at = m_end_time + sim_delta(ret_est.duration_s, energy_cfg)

            if next_start is not None and next_start < ret_done_at:
                after_s = max(0.0, sim_elapsed_s(m_end_time, next_start, energy_cfg))
                if after_s <= 1e-6:
                    pos, battery = end_pt, end_bat
                else:
                    sample = telemetry_at(
                        ret_route,
                        after_s,
                        drone_id,
                        base,
                        start_battery_pct=end_bat,
                        start_pos=end_pt,
                        energy_cfg=energy_cfg,
                    )
                    pos = (sample["lat"], sample["lon"], sample["altitude_m"])
                    battery = sample["battery_pct"]
                last_mission_id = m.id
                continue

            if not must_return and abs((now - m_end_time).total_seconds()) <= 1e-6:
                pos, battery = end_pt, end_bat
                last_mission_id = m.id
                continue

            if now < ret_done_at:
                after_s = max(0.0, sim_elapsed_s(m_end_time, now, energy_cfg))
                sample = telemetry_at(
                    ret_route,
                    after_s,
                    drone_id,
                    base,
                    start_battery_pct=end_bat,
                    start_pos=end_pt,
                    energy_cfg=energy_cfg,
                )
                avail_at = _available_after_landing(ret_done_at, ret_est.end_battery_pct, energy_cfg)
                return DroneState(
                    drone_id=drone_id,
                    status=DroneStatus.offline if offline else DroneStatus.returning,
                    lat=sample["lat"],
                    lon=sample["lon"],
                    altitude_m=sample["altitude_m"],
                    battery_pct=sample["battery_pct"],
                    base_lat=base[0],
                    base_lon=base[1],
                    base_alt_m=base[2],
                    available_at=avail_at,
                    available_sim_s=max(0.0, sim_elapsed_s(now, avail_at, energy_cfg)),
                    active_mission_id=None,
                    last_mission_id=m.id,
                )
            landed_at, landed_bat = ret_done_at, ret_est.end_battery_pct

        if landed_bat < energy_cfg.swap_below_pct:
            swap_end = landed_at + sim_delta(energy_cfg.swap_duration_s, energy_cfg)
            if now < swap_end and (next_start is None or now < next_start):
                return DroneState(
                    drone_id=drone_id,
                    status=DroneStatus.offline if offline else DroneStatus.swapping,
                    lat=base[0],
                    lon=base[1],
                    altitude_m=base[2],
                    battery_pct=landed_bat,
                    base_lat=base[0],
                    base_lon=base[1],
                    base_alt_m=base[2],
                    available_at=swap_end,
                    available_sim_s=max(0.0, sim_elapsed_s(now, swap_end, energy_cfg)),
                    active_mission_id=None,
                    last_mission_id=m.id,
                )
            pos = base
            battery = energy_cfg.full_battery_pct if (next_start is None or next_start >= swap_end) else landed_bat
        else:
            pos = base
            battery = landed_bat
        last_mission_id = m.id

    return DroneState(
        drone_id=drone_id,
        status=DroneStatus.offline if offline else DroneStatus.idle,
        lat=pos[0],
        lon=pos[1],
        altitude_m=pos[2],
        battery_pct=battery,
        base_lat=base[0],
        base_lon=base[1],
        base_alt_m=base[2],
        available_at=now,
        available_sim_s=0.0,
        active_mission_id=None,
        last_mission_id=last_mission_id,
    )


def get_fleet_state(
    db: Session,
    now: datetime | None = None,
    *,
    fleet_cfg: FleetConfig = FLEET,
    energy_cfg: EnergyConfig = ENERGY,
) -> list[DroneState]:
    """Return derived state for every drone in `fleet_cfg.drone_ids`."""
    return [get_drone_state(db, d_id, now, fleet_cfg=fleet_cfg, energy_cfg=energy_cfg) for d_id in fleet_cfg.drone_ids]


def is_mission_feasible(
    target_lat: float,
    target_lon: float,
    *,
    start_pos: tuple[float, float, float],
    start_battery_pct: float,
    planner: FlightPlanner | None = None,
    fleet_cfg: FleetConfig = FLEET,
    energy_cfg: EnergyConfig = ENERGY,
) -> bool:
    """True when the target is in service range and the drone returns home with >= `reserve_pct`."""
    active_planner = planner or FlightPlanner(energy=energy_cfg, fleet=fleet_cfg)
    try:
        proposal = active_planner.propose(
            target_lat,
            target_lon,
            start_pos=start_pos,
            start_battery_pct=start_battery_pct,
            return_to_home=True,
        )
    except OutOfServiceAreaError:
        return False
    return start_battery_pct - proposal.estimated_battery_pct >= energy_cfg.reserve_pct


def select_drone_for_target(
    db: Session,
    target_lat: float,
    target_lon: float,
    now: datetime | None = None,
    *,
    fleet_cfg: FleetConfig = FLEET,
    energy_cfg: EnergyConfig = ENERGY,
) -> DroneState | None:
    """Pick the nearest currently idle, non-offline drone that passes the battery reserve check."""
    planner = FlightPlanner(energy=energy_cfg, fleet=fleet_cfg)
    fleet = get_fleet_state(db, now, fleet_cfg=fleet_cfg, energy_cfg=energy_cfg)
    best: tuple[tuple[float, float, float, int], DroneState] | None = None

    for order, drone in enumerate(fleet):
        if drone.status != DroneStatus.idle:
            continue
        try:
            proposal = planner.propose(
                target_lat,
                target_lon,
                drone_id=drone.drone_id,
                start_pos=drone.position,
                start_battery_pct=drone.battery_pct,
                return_to_home=True,
            )
        except OutOfServiceAreaError:
            return None
        if drone.battery_pct - proposal.estimated_battery_pct < energy_cfg.reserve_pct:
            continue
        dist_m = haversine_m(drone.position[:2], (target_lat, target_lon))
        score = (dist_m, proposal.estimated_duration_s, -drone.battery_pct, order)
        if best is None or score < best[0]:
            best = (score, drone)

    return best[1] if best is not None else None
