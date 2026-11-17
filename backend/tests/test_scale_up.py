from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.db import Base
from app.models import FlightPlan, Mission, Report, ReportStatus
from app.services.allocators import compare_allocators
from app.services.dispatcher import (
    TaskStatus,
    dispatch_tick,
    enqueue_report,
    get_plan_reports,
    get_task,
)
from app.services.fleet import (
    DroneStatus,
    get_drone_state,
    get_mission_start,
    set_drone_offline,
)
from config import FLEET
from sim.energy import estimate
from sim.mock_flight import telemetry_at


@pytest.fixture()
def db_session(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'scale_up_test.db'}", connect_args={"check_same_thread": False})
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


def test_nearby_reports_served_in_one_multi_stop_flight(db_session: Session):
    t0 = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
    r1 = _add_report(db_session, 10.7800, 106.7030, t0)
    r2 = _add_report(db_session, 10.7808, 106.7038, t0 + timedelta(seconds=1.0))  # ~125 m apart

    t1 = enqueue_report(db_session, r1, now=t0, auto_dispatch=False)
    t2 = enqueue_report(db_session, r2, now=t0 + timedelta(seconds=1.0), auto_dispatch=False)

    missions = dispatch_tick(db_session, now=t0 + timedelta(seconds=2.0), allocator="insertion")
    assert len(missions) == 1
    assert len(list(db_session.scalars(select(FlightPlan)).all())) == 1
    assert len(list(db_session.scalars(select(Mission)).all())) == 1

    m = missions[0]
    assert len(m.flight_plan.route) == 19  # 1 takeoff + 2 * (1 fly + 8 survey)
    assert get_plan_reports(db_session, m.flight_plan_id) == [r1.id, r2.id]

    est = estimate(m.flight_plan.route)
    inter_stop_leg = next(lg for lg in est.legs if lg.waypoint == 10)
    assert inter_stop_leg.phase == "outbound"
    mid_hop = telemetry_at(
        m.flight_plan.route,
        (inter_stop_leg.t0 + inter_stop_leg.t1) / 2,
        m.flight_plan.drone_id,
        (FLEET.base_lat, FLEET.base_lon, 0.0),
    )
    assert mid_hop["state"] == "takeoff"

    dispatch_tick(db_session, now=t0 + timedelta(seconds=est.duration_s + 5.0), allocator="insertion")

    t1_done = get_task(db_session, t1.task_id)
    t2_done = get_task(db_session, t2.task_id)
    assert t1_done is not None and t1_done.status == TaskStatus.completed
    assert t2_done is not None and t2_done.status == TaskStatus.completed
    db_session.refresh(r1)
    db_session.refresh(r2)
    assert r1.status in (ReportStatus.confirmed, ReportStatus.not_confirmed)
    assert r2.status == r1.status


def test_s3_returning_drone_re_tasked_mid_return_when_battery_allows(db_session: Session):
    t0 = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
    set_drone_offline(db_session, "sim-uav-2", True)
    set_drone_offline(db_session, "sim-uav-3", True)

    r1 = _add_report(db_session, 10.7840, 106.7060, t0)
    t1 = enqueue_report(db_session, r1, now=t0, allocator="insertion")
    m1 = db_session.get(Mission, t1.mission_id)
    assert m1 is not None
    dur1 = estimate(m1.flight_plan.route).duration_s

    t_ret = t0 + timedelta(seconds=dur1 + 10.0)
    dispatch_tick(db_session, now=t_ret, allocator="insertion")
    uav1_ret = get_drone_state(db_session, "sim-uav-1", t_ret)
    assert uav1_ret.status == DroneStatus.returning

    r_new = _add_report(db_session, 10.7820, 106.7040, t_ret)
    t_new = enqueue_report(db_session, r_new, now=t_ret, allocator="insertion")
    assert t_new.status == TaskStatus.dispatched
    assert t_new.drone_id == "sim-uav-1"
    assert t_new.mission_id is not None

    m_new = db_session.get(Mission, t_new.mission_id)
    assert m_new is not None
    assert m_new.started_at == t_ret
    m_new_start = get_mission_start(db_session, m_new)
    assert m_new_start.alt_m == pytest.approx(30.0)
    assert (m_new_start.lat, m_new_start.lon) != (FLEET.base_lat, FLEET.base_lon)


def test_s3_flying_drone_inserts_stop_into_active_route_mid_leg(db_session: Session):
    t0 = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
    set_drone_offline(db_session, "sim-uav-3", True)

    r1 = _add_report(db_session, 10.7850, 106.7070, t0)
    t1 = enqueue_report(db_session, r1, now=t0, allocator="insertion")
    assert t1.drone_id == "sim-uav-1"
    assert t1.mission_id is not None

    t_ins = t0 + timedelta(seconds=15.0)
    r2 = _add_report(db_session, 10.7855, 106.7075, t_ins)  # ~78 m from r1 while sim-uav-1 is mid-leg
    t2 = enqueue_report(db_session, r2, now=t_ins, allocator="insertion")

    assert t2.status == TaskStatus.dispatched
    assert t2.drone_id == "sim-uav-1"
    assert t2.mission_id == t1.mission_id
    assert t2.plan_id == t1.plan_id
    assert get_plan_reports(db_session, t1.plan_id) == [r1.id, r2.id]
    assert get_drone_state(db_session, "sim-uav-2", t_ins).status == DroneStatus.idle

    m = db_session.get(Mission, t1.mission_id)
    assert m is not None
    m_start = get_mission_start(db_session, m)
    est_spliced = estimate(m.flight_plan.route, start_battery_pct=m_start.battery_pct, start_pos=m_start.pos)

    dispatch_tick(db_session, now=t_ins + timedelta(seconds=est_spliced.duration_s + 5.0), allocator="insertion")
    t1_done = get_task(db_session, t1.task_id)
    t2_done = get_task(db_session, t2.task_id)
    assert t1_done is not None and t1_done.status == TaskStatus.completed
    assert t2_done is not None and t2_done.status == TaskStatus.completed


def test_insertion_allocator_completes_burst_scenario():
    results = compare_allocators(scenario="burst", seeds=(42,), n_reports=10, allocators=("insertion",))
    res = results[0]
    assert res.tasks_served == res.tasks_total
    assert res.tasks_left == 0
    assert res.battery_used_pct > 0.0
