from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db import Base
from app.models import FlightPlan, Mission, MissionState, PlanStatus, Report, ReportStatus
from app.services.allocators import (
    AuctionAllocator,
    BaselineAllocator,
    compare_allocators,
    run_scale_out,
)
from app.services.dispatcher import (
    TaskStatus,
    dispatch_tick,
    enqueue_report,
    get_task,
    list_tasks,
)
from app.services.fleet import (
    MissionStart,
    get_fleet_state,
    record_mission_start,
    set_drone_offline,
)
from app.services.flight_planner import FlightPlanner
from config import FLEET
from sim.energy import estimate


@pytest.fixture()
def db_session(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'allocators_test.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    local = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with local() as db:
        yield db


def _add_report(db: Session, lat: float, lon: float, created_at: datetime) -> Report:
    report = Report(
        lat=lat,
        lon=lon,
        photo_path="seed/pothole-1.jpg",
        status=ReportStatus.under_review,
        created_at=created_at,
        updated_at=created_at,
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


def _launch_mission(
    db: Session,
    *,
    lat: float,
    lon: float,
    drone_id: str,
    started_at: datetime,
    start_battery_pct: float = 100.0,
) -> tuple[Mission, float]:
    r = _add_report(db, lat, lon, started_at)
    r.status = ReportStatus.uav_dispatched
    prop = FlightPlanner().propose(
        lat,
        lon,
        drone_id=drone_id,
        start_pos=(FLEET.base_lat, FLEET.base_lon, FLEET.base_alt_m),
        start_battery_pct=start_battery_pct,
        return_to_home=False,
    )
    plan = FlightPlan(
        report_id=r.id,
        drone_id=drone_id,
        altitude_m=prop.altitude_m,
        survey_radius_m=prop.survey_radius_m,
        route=prop.route,
        status=PlanStatus.approved,
    )
    db.add(plan)
    db.flush()
    m = Mission(flight_plan_id=plan.id, report_id=r.id, state=MissionState.takeoff, started_at=started_at)
    db.add(m)
    db.flush()
    record_mission_start(db, m, MissionStart(FLEET.base_lat, FLEET.base_lon, FLEET.base_alt_m, start_battery_pct))
    db.commit()
    dur = estimate(
        plan.route,
        start_battery_pct=start_battery_pct,
        start_pos=(FLEET.base_lat, FLEET.base_lon, FLEET.base_alt_m),
    ).duration_s
    return m, dur


def test_auction_looks_beyond_oldest_task_when_airborne_drone_is_near_newer_task(db_session: Session):
    t0 = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
    _, dur1 = _launch_mission(db_session, lat=10.7875, lon=106.7115, drone_id="sim-uav-1", started_at=t0)
    set_drone_offline(db_session, "sim-uav-2", True)
    set_drone_offline(db_session, "sim-uav-3", True)

    r_old = _add_report(db_session, 10.7780, 106.7010, t0 + timedelta(seconds=1.0))
    r_near = _add_report(db_session, 10.7880, 106.7120, t0 + timedelta(seconds=2.0))
    t_old = enqueue_report(db_session, r_old, now=t0 + timedelta(seconds=1.0), auto_dispatch=False)
    t_near = enqueue_report(db_session, r_near, now=t0 + timedelta(seconds=2.0), auto_dispatch=False)

    m1_end = t0 + timedelta(seconds=dur1)
    fleet = get_fleet_state(db_session, m1_end)
    tasks = list_tasks(db_session)

    base_bids = BaselineAllocator().allocate(db_session, tasks, fleet, m1_end)
    auc_bids = AuctionAllocator().allocate(db_session, tasks, fleet, m1_end)

    assert len(base_bids) == 1
    assert base_bids[0].task_id == t_old.task_id
    assert len(auc_bids) == 1
    assert auc_bids[0].task_id == t_near.task_id


def test_auction_holds_task_for_nearby_finishing_busy_drone_instead_of_distant_idle_drone(db_session: Session):
    t0 = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
    _, dur1 = _launch_mission(db_session, lat=10.7880, lon=106.7120, drone_id="sim-uav-1", started_at=t0)
    set_drone_offline(db_session, "sim-uav-3", True)

    t_arrive = t0 + timedelta(seconds=dur1 - 10.0)
    r_target = _add_report(db_session, 10.7880, 106.7120, t_arrive)
    task = enqueue_report(db_session, r_target, now=t_arrive, allocator="auction")
    assert task.status == TaskStatus.queued  # held for sim-uav-1 instead of dispatching idle sim-uav-2 from base

    m1_end = t0 + timedelta(seconds=dur1)
    dispatch_tick(db_session, now=m1_end, allocator="auction")
    chained = get_task(db_session, task.task_id)
    assert chained is not None
    assert chained.status == TaskStatus.dispatched
    assert chained.drone_id == "sim-uav-1"


def test_s6_burst_of_10_reports_both_allocators_serve_all():
    results = compare_allocators(scenario="burst", seeds=(42,), n_reports=10)
    by_alloc = {r.allocator: r for r in results}

    for r in results:
        assert r.tasks_served == r.tasks_total
        assert r.tasks_left == 0
        assert r.mean_wait_s > 0.0
        assert r.worst_wait_s >= r.mean_wait_s
        assert r.battery_used_pct > 0.0

    assert (
        by_alloc["auction"].mean_wait_s <= by_alloc["baseline"].mean_wait_s
        or by_alloc["auction"].battery_used_pct <= by_alloc["baseline"].battery_used_pct
    )


def test_scale_out_3_5_10_drones_reduces_wait_time():
    results = run_scale_out(seeds=(42,), drone_counts=(3, 5, 10), n_reports=15)
    by_drones = {r.drones: r for r in results}

    for r in results:
        assert r.tasks_served == r.tasks_total
        assert r.tasks_left == 0

    assert by_drones[10].mean_wait_s <= by_drones[5].mean_wait_s <= by_drones[3].mean_wait_s
    assert by_drones[10].mean_wait_s < by_drones[3].mean_wait_s
