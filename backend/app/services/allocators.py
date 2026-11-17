"""Task allocators (baseline vs lowest-arrival-time auction) and seeded scenario runner (docs/fleet-plan.md §7)."""

from __future__ import annotations

import random
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Protocol

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.db import Base
from app.models import FLYING_STATES, Mission, Report, ReportStatus
from app.services.fleet import (
    DroneState,
    DroneStatus,
    get_mission_start,
)
from app.services.flight_planner import FlightPlanner, OutOfServiceAreaError
from config import ENERGY, FLEET, SCENARIOS, EnergyConfig, FleetConfig, ScenarioConfig
from sim.energy import destination, estimate, haversine_m

if TYPE_CHECKING:
    from app.services.dispatcher import InspectionTask

_BASE_EPS_M = 1.0
_GROUND_ALT_EPS_M = 0.1


def _utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


def _at_base_ground(pt: tuple[float, float, float], base: tuple[float, float, float]) -> bool:
    return haversine_m(pt[:2], base[:2]) <= _BASE_EPS_M and pt[2] <= _GROUND_ALT_EPS_M


def _return_route(pos: tuple[float, float, float], base: tuple[float, float, float]) -> list[dict]:
    cruise_alt = max(pos[2], 30.0)
    return [
        {"lat": base[0], "lon": base[1], "alt": cruise_alt, "action": "fly"},
        {"lat": base[0], "lon": base[1], "alt": base[2], "action": "land"},
    ]


def transit_to_target_s(
    route: list[dict],
    *,
    start_pos: tuple[float, float, float],
    start_battery_pct: float,
    energy_cfg: EnergyConfig = ENERGY,
) -> float:
    """Simulated seconds from route start until the drone reaches the first survey waypoint."""
    est = estimate(route, start_battery_pct=start_battery_pct, start_pos=start_pos, cfg=energy_cfg)
    total = 0.0
    for leg in est.legs:
        if leg.phase == "survey":
            break
        total += leg.duration_s
    return round(total, 4)


@dataclass(frozen=True)
class Bid:
    task_id: int
    drone_id: str
    arrival_s: float
    free_in_s: float
    start_pos: tuple[float, float, float]
    start_battery_pct: float
    insertion_cost_s: float = 0.0
    insert_into_mission_id: int | None = None
    grouped_task_ids: tuple[int, ...] = ()
    ordered_targets: tuple[tuple[float, float], ...] = ()


class Allocator(Protocol):
    name: str

    def allocate(
        self,
        db: Session,
        tasks: list[InspectionTask],
        fleet: list[DroneState],
        now: datetime,
        *,
        fleet_cfg: FleetConfig = FLEET,
        energy_cfg: EnergyConfig = ENERGY,
    ) -> list[Bid]: ...


class BaselineAllocator:
    """Oldest task first, nearest available idle drone that passes the battery reserve check."""

    name = "baseline"

    def allocate(
        self,
        db: Session,
        tasks: list[InspectionTask],
        fleet: list[DroneState],
        now: datetime,
        *,
        fleet_cfg: FleetConfig = FLEET,
        energy_cfg: EnergyConfig = ENERGY,
    ) -> list[Bid]:
        del db, now
        planner = FlightPlanner(energy=energy_cfg, fleet=fleet_cfg)
        ordered = sorted(tasks, key=lambda t: (_utc(t.created_at), t.task_id))
        available = [(order, d) for order, d in enumerate(fleet) if d.status == DroneStatus.idle]
        bids: list[Bid] = []

        for task in ordered:
            best: tuple[tuple[float, float, int], int, Bid] | None = None
            for idx, (order, drone) in enumerate(available):
                try:
                    rth = planner.propose(
                        task.lat,
                        task.lon,
                        drone_id=drone.drone_id,
                        start_pos=drone.position,
                        start_battery_pct=drone.battery_pct,
                        return_to_home=True,
                    )
                except OutOfServiceAreaError:
                    best = None
                    break
                if drone.battery_pct - rth.estimated_battery_pct < energy_cfg.reserve_pct:
                    continue
                dist_m = haversine_m(drone.position[:2], (task.lat, task.lon))
                transit_s = transit_to_target_s(
                    rth.route,
                    start_pos=drone.position,
                    start_battery_pct=drone.battery_pct,
                    energy_cfg=energy_cfg,
                )
                bid = Bid(
                    task_id=task.task_id,
                    drone_id=drone.drone_id,
                    arrival_s=transit_s,
                    free_in_s=0.0,
                    start_pos=drone.position,
                    start_battery_pct=drone.battery_pct,
                )
                score = (dist_m, -drone.battery_pct, order)
                if best is None or score < best[0]:
                    best = (score, idx, bid)

            if best is not None:
                _, used_idx, win_bid = best
                bids.append(win_bid)
                available.pop(used_idx)

        return bids


@dataclass
class _ProjectedDrone:
    drone_id: str
    order: int
    free_in_s: float
    pos: tuple[float, float, float]
    battery_pct: float
    base: tuple[float, float, float]
    at_base_after_s: float
    at_base_bat: float
    rem_to_base_s: float = 0.0
    active_mission_id: int | None = None
    live_pos: tuple[float, float, float] | None = None
    live_bat: float = 0.0
    rem_targets: tuple[tuple[float, float], ...] = ()
    cur_rem_route_s: float = 0.0
    can_mid_leg_insert: bool = False


def _base_recovery(
    free_t: float,
    pos: tuple[float, float, float],
    bat: float,
    base: tuple[float, float, float],
    energy_cfg: EnergyConfig,
) -> tuple[float, float]:
    if _at_base_ground(pos, base):
        if bat < energy_cfg.swap_below_pct:
            return free_t + energy_cfg.swap_duration_s, energy_cfg.full_battery_pct
        return free_t, bat
    ret_est = estimate(_return_route(pos, base), start_battery_pct=bat, start_pos=pos, cfg=energy_cfg)
    landed_t = free_t + ret_est.duration_s
    landed_bat = ret_est.end_battery_pct
    if landed_bat < energy_cfg.swap_below_pct:
        return landed_t + energy_cfg.swap_duration_s, energy_cfg.full_battery_pct
    return landed_t, landed_bat


def _project_drone(
    db: Session,
    d: DroneState,
    order: int,
    now: datetime,
    fleet_cfg: FleetConfig,
    energy_cfg: EnergyConfig,
) -> _ProjectedDrone | None:
    if d.status == DroneStatus.offline:
        return None
    base = (d.base_lat, d.base_lon, d.base_alt_m)
    t_now = _utc(now)

    if d.status == DroneStatus.idle:
        base_t, base_bat = _base_recovery(0.0, d.position, d.battery_pct, base, energy_cfg)
        rem_home = (
            0.0
            if _at_base_ground(d.position, base)
            else estimate(
                _return_route(d.position, base),
                start_battery_pct=d.battery_pct,
                start_pos=d.position,
                cfg=energy_cfg,
            ).duration_s
        )
        return _ProjectedDrone(d.drone_id, order, 0.0, d.position, d.battery_pct, base, base_t, base_bat, rem_home)

    if d.status == DroneStatus.swapping:
        return _ProjectedDrone(
            d.drone_id,
            order,
            d.available_sim_s,
            base,
            energy_cfg.full_battery_pct,
            base,
            d.available_sim_s,
            energy_cfg.full_battery_pct,
        )

    if d.status == DroneStatus.returning:
        ret_est = estimate(
            _return_route(d.position, base),
            start_battery_pct=d.battery_pct,
            start_pos=d.position,
            cfg=energy_cfg,
        )
        end_bat = (
            energy_cfg.full_battery_pct
            if ret_est.end_battery_pct < energy_cfg.swap_below_pct
            else ret_est.end_battery_pct
        )
        return _ProjectedDrone(
            d.drone_id,
            order,
            d.available_sim_s,
            base,
            end_bat,
            base,
            d.available_sim_s,
            end_bat,
        )

    # Flying: project from survey completion (and optional mid-leg splicing when re_tasking=True).
    mission = db.get(Mission, d.active_mission_id) if d.active_mission_id is not None else None
    if mission is None or mission.started_at is None:
        return _ProjectedDrone(
            d.drone_id,
            order,
            d.available_sim_s,
            base,
            energy_cfg.full_battery_pct,
            base,
            d.available_sim_s,
            energy_cfg.full_battery_pct,
        )
    m_start = get_mission_start(db, mission, fleet_cfg=fleet_cfg, energy_cfg=energy_cfg)
    est = estimate(
        mission.flight_plan.route,
        start_battery_pct=m_start.battery_pct,
        start_pos=m_start.pos,
        cfg=energy_cfg,
    )
    m_end = _utc(mission.started_at) + timedelta(seconds=est.duration_s)
    rem_s = max(0.0, (m_end - t_now).total_seconds())
    end_pt = est.legs[-1].end
    end_bat = est.end_battery_pct
    base_t, base_bat = _base_recovery(rem_s, end_pt, end_bat, base, energy_cfg)

    if _at_base_ground(end_pt, base) and end_bat < energy_cfg.swap_below_pct:
        return _ProjectedDrone(d.drone_id, order, base_t, base, base_bat, base, base_t, base_bat)

    rem_home_at_end = (
        0.0
        if _at_base_ground(end_pt, base)
        else estimate(
            _return_route(end_pt, base),
            start_battery_pct=end_bat,
            start_pos=end_pt,
            cfg=energy_cfg,
        ).duration_s
    )
    return _ProjectedDrone(d.drone_id, order, rem_s, end_pt, end_bat, base, base_t, base_bat, rem_home_at_end)


def _bid_from_state(
    task: InspectionTask,
    proj: _ProjectedDrone,
    use_t: float,
    use_pos: tuple[float, float, float],
    use_bat: float,
    planner: FlightPlanner,
    energy_cfg: EnergyConfig,
    *,
    rem_to_base_s: float = 0.0,
) -> Bid | None:
    try:
        rth = planner.propose(
            task.lat,
            task.lon,
            drone_id=proj.drone_id,
            start_pos=use_pos,
            start_battery_pct=use_bat,
            return_to_home=True,
        )
    except OutOfServiceAreaError:
        return None
    if use_bat - rth.estimated_battery_pct < energy_cfg.reserve_pct:
        return None
    transit_s = transit_to_target_s(
        rth.route,
        start_pos=use_pos,
        start_battery_pct=use_bat,
        energy_cfg=energy_cfg,
    )
    extra_s = max(0.0, rth.estimated_duration_s - rem_to_base_s)
    return Bid(
        task_id=task.task_id,
        drone_id=proj.drone_id,
        arrival_s=use_t + transit_s,
        free_in_s=use_t,
        start_pos=use_pos,
        start_battery_pct=use_bat,
        insertion_cost_s=use_t + extra_s,
        ordered_targets=((task.lat, task.lon),),
    )


def _candidate_bid(
    task: InspectionTask,
    proj: _ProjectedDrone,
    planner: FlightPlanner,
    fleet_cfg: FleetConfig,
    energy_cfg: EnergyConfig,
) -> Bid | None:
    direct = _bid_from_state(
        task,
        proj,
        proj.free_in_s,
        proj.pos,
        proj.battery_pct,
        planner,
        energy_cfg,
        rem_to_base_s=proj.rem_to_base_s,
    )
    if direct is not None:
        return direct
    if (proj.at_base_after_s, proj.base, proj.at_base_bat) != (proj.free_in_s, proj.pos, proj.battery_pct):
        return _bid_from_state(task, proj, proj.at_base_after_s, proj.base, proj.at_base_bat, planner, energy_cfg)
    return None


class AuctionAllocator:
    """Lowest arrival-time bidder over all open (task, drone) pairs; breaks ties FIFO then drone id."""

    name = "auction"

    def allocate(
        self,
        db: Session,
        tasks: list[InspectionTask],
        fleet: list[DroneState],
        now: datetime,
        *,
        fleet_cfg: FleetConfig = FLEET,
        energy_cfg: EnergyConfig = ENERGY,
    ) -> list[Bid]:
        from app.services.dispatcher import TaskStatus

        queued = [t for t in tasks if t.status == TaskStatus.queued]
        if not queued:
            return []

        projections = [
            p
            for order, d in enumerate(fleet)
            if (p := _project_drone(db, d, order, now, fleet_cfg, energy_cfg)) is not None
        ]
        if not projections:
            return []

        planner = FlightPlanner(energy=energy_cfg, fleet=fleet_cfg)
        unassigned = list(queued)
        immediate_bids: list[Bid] = []

        while unassigned:
            best_pair: tuple[tuple[float, float, int, int], InspectionTask, _ProjectedDrone, Bid] | None = None
            for task in unassigned:
                for proj in projections:
                    bid = _candidate_bid(task, proj, planner, fleet_cfg, energy_cfg)
                    if bid is None:
                        continue
                    key2 = (round(bid.arrival_s, 4), _utc(task.created_at).timestamp(), task.task_id, proj.order)
                    if best_pair is None or key2 < best_pair[0]:
                        best_pair = (key2, task, proj, bid)

            if best_pair is None:
                break

            _, win_task, win_proj, win_bid = best_pair
            unassigned.remove(win_task)
            if win_bid.free_in_s == 0.0:
                immediate_bids.append(win_bid)

            survey_prop = planner.propose(
                win_task.lat,
                win_task.lon,
                drone_id=win_proj.drone_id,
                start_pos=win_bid.start_pos,
                start_battery_pct=win_bid.start_battery_pct,
                return_to_home=False,
            )
            last_wp = survey_prop.route[-1]
            new_t = win_bid.free_in_s + survey_prop.estimated_duration_s
            new_pos = (float(last_wp["lat"]), float(last_wp["lon"]), float(last_wp["alt"]))
            new_bat = max(0.0, win_bid.start_battery_pct - survey_prop.estimated_battery_pct)
            win_proj.free_in_s = new_t
            win_proj.pos = new_pos
            win_proj.battery_pct = new_bat
            win_proj.rem_to_base_s = (
                0.0
                if _at_base_ground(new_pos, win_proj.base)
                else estimate(
                    _return_route(new_pos, win_proj.base),
                    start_battery_pct=new_bat,
                    start_pos=new_pos,
                    cfg=energy_cfg,
                ).duration_s
            )
            win_proj.at_base_after_s, win_proj.at_base_bat = _base_recovery(
                new_t, new_pos, new_bat, win_proj.base, energy_cfg
            )

        return immediate_bids


_ALLOCATORS: dict[str, type[BaselineAllocator] | type[AuctionAllocator]] = {
    "baseline": BaselineAllocator,
    "auction": AuctionAllocator,
}


def get_allocator(name: str) -> Allocator:
    cls = _ALLOCATORS.get(name)
    if cls is None:
        raise ValueError(f"unknown allocator {name!r}, expected one of {list(_ALLOCATORS)}")
    return cls()


# ---------------------------------------------------------------------------
# Seeded scenario runner and comparison tables
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class ScenarioResult:
    scenario: str
    allocator: str
    seed: int
    drones: int
    reports_total: int
    tasks_total: int
    tasks_served: int
    tasks_left: int
    mean_wait_s: float
    worst_wait_s: float
    battery_used_pct: float


def _generate_arrivals(
    *,
    seed: int,
    n_reports: int,
    span_s: float,
    interval_s: float | None,
    fleet_cfg: FleetConfig,
    sc_cfg: ScenarioConfig,
) -> list[tuple[float, float, float]]:
    rng = random.Random(seed)
    base = (fleet_cfg.base_lat, fleet_cfg.base_lon)
    if interval_s is None:
        offsets = sorted(rng.uniform(0.0, span_s) for _ in range(n_reports))
    else:
        offsets = [i * interval_s for i in range(n_reports)]

    arrivals: list[tuple[float, float, float]] = []
    for offset in offsets:
        dist = rng.uniform(sc_cfg.min_target_dist_m, sc_cfg.max_target_dist_m)
        brg = rng.uniform(0.0, 360.0)
        lat, lon = destination(base, brg, dist)
        arrivals.append((offset, round(lat, 6), round(lon, 6)))
    return arrivals


def _total_battery_used(db: Session, fleet_cfg: FleetConfig, energy_cfg: EnergyConfig) -> float:
    from app.models import FlightPlan

    base = (fleet_cfg.base_lat, fleet_cfg.base_lon, fleet_cfg.base_alt_m)
    total = 0.0
    for drone_id in fleet_cfg.drone_ids:
        missions = list(
            db.scalars(
                select(Mission)
                .join(FlightPlan, Mission.flight_plan_id == FlightPlan.id)
                .where(FlightPlan.drone_id == drone_id, Mission.started_at.is_not(None))
                .order_by(Mission.started_at.asc(), Mission.id.asc())
            ).all()
        )
        for idx, m in enumerate(missions):
            assert m.started_at is not None
            m_start = get_mission_start(db, m, fleet_cfg=fleet_cfg, energy_cfg=energy_cfg)
            est = estimate(
                m.flight_plan.route,
                start_battery_pct=m_start.battery_pct,
                start_pos=m_start.pos,
                cfg=energy_cfg,
            )
            total += est.battery_used_pct
            end_pt = est.legs[-1].end
            if not _at_base_ground(end_pt, base):
                m_end = _utc(m.started_at) + timedelta(seconds=est.duration_s)
                chained = (
                    idx + 1 < len(missions)
                    and missions[idx + 1].started_at is not None
                    and abs((_utc(missions[idx + 1].started_at) - m_end).total_seconds()) <= 1e-6
                )
                if not chained:
                    ret_est = estimate(
                        _return_route(end_pt, base),
                        start_battery_pct=est.end_battery_pct,
                        start_pos=end_pt,
                        cfg=energy_cfg,
                    )
                    total += ret_est.battery_used_pct
    return round(total, 2)


def run_scenario(
    *,
    scenario: str,
    allocator: str,
    seed: int,
    n_reports: int,
    span_s: float = 60.0,
    interval_s: float | None = None,
    n_drones: int = 3,
    fleet_cfg: FleetConfig = FLEET,
    energy_cfg: EnergyConfig = ENERGY,
    sc_cfg: ScenarioConfig = SCENARIOS,
) -> ScenarioResult:
    """Run one seeded report arrival trace in memory with fast simulated clock."""
    from app.services.dispatcher import TaskStatus, dispatch_tick, enqueue_report, list_tasks

    drone_ids = tuple(f"sim-uav-{i + 1}" for i in range(n_drones))
    active_fleet = replace(fleet_cfg, drone_ids=drone_ids, allocator=allocator)
    arrivals = _generate_arrivals(
        seed=seed,
        n_reports=n_reports,
        span_s=span_s,
        interval_s=interval_s,
        fleet_cfg=active_fleet,
        sc_cfg=sc_cfg,
    )

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    local = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    t0 = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)

    with local() as db:
        arrival_idx = 0
        cursor_s = 0.0
        while cursor_s <= sc_cfg.horizon_s:
            while arrival_idx < len(arrivals) and arrivals[arrival_idx][0] <= cursor_s + 1e-9:
                off_s, lat, lon = arrivals[arrival_idx]
                t_arr = t0 + timedelta(seconds=off_s)
                report = Report(
                    lat=lat,
                    lon=lon,
                    photo_path="seed/pothole-1.jpg",
                    status=ReportStatus.under_review,
                    created_at=t_arr,
                    updated_at=t_arr,
                )
                db.add(report)
                db.commit()
                db.refresh(report)
                enqueue_report(
                    db,
                    report,
                    now=t_arr,
                    allocator=allocator,
                    fleet_cfg=active_fleet,
                    energy_cfg=energy_cfg,
                )
                arrival_idx += 1

            t_cur = t0 + timedelta(seconds=cursor_s)
            dispatch_tick(db, now=t_cur, allocator=allocator, fleet_cfg=active_fleet, energy_cfg=energy_cfg)

            if arrival_idx >= len(arrivals):
                tasks = list_tasks(db)
                flying = list(db.scalars(select(Mission).where(Mission.state.in_(FLYING_STATES))).all())
                if not flying and all(t.status != TaskStatus.queued for t in tasks):
                    break
            cursor_s += sc_cfg.step_s

        tasks = list_tasks(db)
        served = [t for t in tasks if t.status == TaskStatus.completed and t.mission_id is not None]
        left = [t for t in tasks if t.status in (TaskStatus.queued, TaskStatus.dispatched, TaskStatus.flagged)]
        waits: list[float] = []
        for task in served:
            m = db.get(Mission, task.mission_id)
            if m is None or m.started_at is None:
                continue
            m_start = get_mission_start(db, m, fleet_cfg=active_fleet, energy_cfg=energy_cfg)
            transit_s = transit_to_target_s(
                    m.flight_plan.route,
                    start_pos=m_start.pos,
                    start_battery_pct=m_start.battery_pct,
                    energy_cfg=energy_cfg,
                )
            arrival_t = _utc(m.started_at) + timedelta(seconds=transit_s)
            waits.append(max(0.0, (arrival_t - _utc(task.created_at)).total_seconds()))

        mean_wait = round(sum(waits) / len(waits), 2) if waits else 0.0
        worst_wait = round(max(waits), 2) if waits else 0.0
        bat_used = _total_battery_used(db, active_fleet, energy_cfg)

    return ScenarioResult(
        scenario=scenario,
        allocator=allocator,
        seed=seed,
        drones=n_drones,
        reports_total=n_reports,
        tasks_total=len(tasks),
        tasks_served=len(served),
        tasks_left=len(left),
        mean_wait_s=mean_wait,
        worst_wait_s=worst_wait,
        battery_used_pct=bat_used,
    )


def compare_allocators(
    *,
    scenario: str = "burst",
    seeds: tuple[int, ...] = SCENARIOS.seeds,
    n_reports: int = SCENARIOS.burst_reports,
    span_s: float = SCENARIOS.burst_span_s,
    interval_s: float | None = None,
    n_drones: int = 3,
    allocators: tuple[str, ...] = ("baseline", "auction"),
) -> list[ScenarioResult]:
    """Compare allocators side-by-side on identical seeded report traces."""
    results: list[ScenarioResult] = []
    for seed in seeds:
        for alloc_name in allocators:
            results.append(
                run_scenario(
                    scenario=scenario,
                    allocator=alloc_name,
                    seed=seed,
                    n_reports=n_reports,
                    span_s=span_s,
                    interval_s=interval_s,
                    n_drones=n_drones,
                )
            )
    return results


def run_scale_out(
    *,
    seeds: tuple[int, ...] = SCENARIOS.seeds,
    drone_counts: tuple[int, ...] = SCENARIOS.scale_out_drones,
    n_reports: int = SCENARIOS.scale_out_reports,
    span_s: float = SCENARIOS.scale_out_span_s,
    allocator: str = "auction",
) -> list[ScenarioResult]:
    """Measure how wait time changes with 3, 5, and 10 drones on the same burst seeds."""
    results: list[ScenarioResult] = []
    for seed in seeds:
        for count in drone_counts:
            results.append(
                run_scenario(
                    scenario="scale-out",
                    allocator=allocator,
                    seed=seed,
                    n_reports=n_reports,
                    span_s=span_s,
                    n_drones=count,
                )
            )
    return results


def format_comparison_table(results: list[ScenarioResult]) -> str:
    """Format scenario metrics as a markdown table."""
    header = (
        "| Scenario | Allocator | Seed | Drones | Tasks (served/total) | Left "
        "| Mean wait (s) | Worst wait (s) | Battery used (%) |\n"
        "|---|---|---:|---:|---:|---:|---:|---:|---:|"
    )
    rows = [
        f"| {r.scenario} | {r.allocator} | {r.seed} | {r.drones} "
        f"| {r.tasks_served}/{r.tasks_total} | {r.tasks_left} "
        f"| {r.mean_wait_s:.1f} | {r.worst_wait_s:.1f} | {r.battery_used_pct:.1f} |"
        for r in results
    ]
    return "\n".join([header, *rows])
