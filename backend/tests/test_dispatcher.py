from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.db import Base
from app.main import create_app
from app.models import FlightPlan, Mission, MissionState, PlanStatus, Report, ReportStatus
from app.services.dispatcher import (
    TaskStatus,
    cancel_task,
    dispatch_tick,
    enqueue_report,
    get_task,
    recall_mission,
    set_mission_edge_failure,
)
from app.services.fleet import (
    DroneStatus,
    MissionStart,
    get_drone_state,
    get_fleet_state,
    get_mission_start,
    record_mission_start,
    set_drone_offline,
)
from app.services.flight_planner import FlightPlanner
from config import ENERGY, FLEET
from sim.energy import estimate

_MEDIA = Path(__file__).resolve().parents[1] / "mock" / "media"


@pytest.fixture()
def db_session(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'dispatcher_test.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    local = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with local() as db:
        yield db


def _add_report(
    db: Session,
    lat: float,
    lon: float,
    *,
    created_at: datetime | None = None,
    status: ReportStatus = ReportStatus.under_review,
) -> Report:
    ts = created_at or datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
    report = Report(
        lat=lat,
        lon=lon,
        photo_path="seed/pothole-1.jpg",
        status=status,
        created_at=ts,
        updated_at=ts,
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


def test_s1_one_report_all_drones_idle(db_session: Session):
    t0 = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
    r = _add_report(db_session, 10.7800, 106.7030, created_at=t0)

    task = enqueue_report(db_session, r, now=t0)
    assert task.status == TaskStatus.dispatched
    assert task.drone_id == "sim-uav-1"
    assert task.decided_by == "system"
    assert task.mission_id is not None

    plan = db_session.get(FlightPlan, task.plan_id)
    assert plan is not None
    assert plan.status == PlanStatus.approved

    mission = db_session.get(Mission, task.mission_id)
    assert mission is not None
    assert mission.state == MissionState.takeoff

    by_id = {d.drone_id: d for d in get_fleet_state(db_session, t0 + timedelta(seconds=1.0))}
    assert by_id["sim-uav-1"].status == DroneStatus.flying
    assert by_id["sim-uav-2"].status == DroneStatus.idle
    assert by_id["sim-uav-3"].status == DroneStatus.idle


def test_s2_report_queued_when_all_busy_then_chained_from_survey_end(db_session: Session):
    t0 = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
    r1 = _add_report(db_session, 10.7790, 106.7020, created_at=t0)  # closest -> finishes first
    r2 = _add_report(db_session, 10.7880, 106.7120, created_at=t0)
    r3 = _add_report(db_session, 10.7880, 106.6900, created_at=t0)

    t1 = enqueue_report(db_session, r1, now=t0)
    t2 = enqueue_report(db_session, r2, now=t0)
    t3 = enqueue_report(db_session, r3, now=t0)
    assert {t1.drone_id, t2.drone_id, t3.drone_id} == set(FLEET.drone_ids)

    r4 = _add_report(db_session, 10.7805, 106.7035, created_at=t0 + timedelta(seconds=10.0))
    t4 = enqueue_report(db_session, r4, now=t0 + timedelta(seconds=10.0))
    assert t4.status == TaskStatus.queued
    assert t4.mission_id is None

    m1 = db_session.get(Mission, t1.mission_id)
    assert m1 is not None
    m1_start = get_mission_start(db_session, m1)
    est1 = estimate(m1.flight_plan.route, start_battery_pct=m1_start.battery_pct, start_pos=m1_start.pos)
    m1_end = t0 + timedelta(seconds=est1.duration_s)

    dispatched = dispatch_tick(db_session, now=m1_end + timedelta(seconds=5.0))
    t4_after = get_task(db_session, t4.task_id)
    assert t4_after is not None
    assert t4_after.status == TaskStatus.dispatched
    assert t4_after.drone_id == t1.drone_id
    assert len(dispatched) == 1

    m4 = db_session.get(Mission, t4_after.mission_id)
    assert m4 is not None
    assert m4.started_at == m1_end
    m4_start = get_mission_start(db_session, m4)
    assert m4_start.alt_m == pytest.approx(30.0)
    assert (m4_start.lat, m4_start.lon) != (FLEET.base_lat, FLEET.base_lon)


def test_s4_chained_drone_lacking_battery_plus_reserve_returns_home_to_swap(db_session: Session):
    t0 = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)

    # Launch sim-uav-1 with 36% battery so it finishes its survey (~31%) without enough reserve for another edge task.
    r1 = _add_report(db_session, 10.7800, 106.7030, created_at=t0)
    p1_prop = FlightPlanner().propose(
        r1.lat, r1.lon, drone_id="sim-uav-1", start_battery_pct=36.0, return_to_home=False
    )
    p1 = FlightPlan(
        report_id=r1.id,
        drone_id="sim-uav-1",
        altitude_m=p1_prop.altitude_m,
        survey_radius_m=p1_prop.survey_radius_m,
        route=p1_prop.route,
        status=PlanStatus.approved,
    )
    db_session.add(p1)
    db_session.flush()
    m1 = Mission(flight_plan_id=p1.id, report_id=r1.id, state=MissionState.takeoff, started_at=t0)
    db_session.add(m1)
    db_session.flush()
    record_mission_start(db_session, m1, MissionStart(FLEET.base_lat, FLEET.base_lon, 0.0, 36.0))
    db_session.commit()

    # Keep sim-uav-2 and sim-uav-3 offline so only sim-uav-1 can serve the queued task after swapping.
    set_drone_offline(db_session, "sim-uav-2", True)
    set_drone_offline(db_session, "sim-uav-3", True)

    r4 = _add_report(db_session, 10.7880, 106.7120, created_at=t0 + timedelta(seconds=10.0))
    t4 = enqueue_report(db_session, r4, now=t0 + timedelta(seconds=10.0))
    assert t4.status == TaskStatus.queued

    m1_end = t0 + timedelta(seconds=p1_prop.estimated_duration_s)
    dispatch_tick(db_session, now=m1_end + timedelta(seconds=5.0))

    uav1_mid = get_drone_state(db_session, "sim-uav-1", m1_end + timedelta(seconds=5.0))
    assert uav1_mid.status == DroneStatus.returning
    t4_waiting = get_task(db_session, t4.task_id)
    assert t4_waiting is not None and t4_waiting.status == TaskStatus.queued

    # After returning to base + 120 s swap, battery resets to 100% and sim-uav-1 picks up the queued task.
    after_swap = uav1_mid.available_at + timedelta(seconds=ENERGY.swap_duration_s + 5.0)
    dispatched = dispatch_tick(db_session, now=after_swap)
    t4_done_dispatch = get_task(db_session, t4.task_id)
    assert t4_done_dispatch is not None and t4_done_dispatch.status == TaskStatus.dispatched
    assert t4_done_dispatch.drone_id == "sim-uav-1"
    assert len(dispatched) == 1
    assert get_mission_start(db_session, dispatched[0]).battery_pct == ENERGY.full_battery_pct


def test_s5_two_reports_within_merge_radius_share_one_task_and_flight(db_session: Session):
    t0 = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
    r1 = _add_report(db_session, 10.78000, 106.70300, created_at=t0)
    r2 = _add_report(db_session, 10.78005, 106.70305, created_at=t0 + timedelta(seconds=2.0))  # ~7.8 m apart

    task1 = enqueue_report(db_session, r1, now=t0)
    task2 = enqueue_report(db_session, r2, now=t0 + timedelta(seconds=2.0))

    assert task1.task_id == task2.task_id
    assert task2.report_ids == [r1.id, r2.id]
    assert len(list(db_session.scalars(select(Mission)).all())) == 1
    assert len(list(db_session.scalars(select(FlightPlan)).all())) == 1

    mission = db_session.get(Mission, task1.mission_id)
    assert mission is not None
    est = estimate(mission.flight_plan.route)
    dispatch_tick(db_session, now=t0 + timedelta(seconds=est.duration_s + 5.0))

    db_session.refresh(r1)
    db_session.refresh(r2)
    assert r1.status in (ReportStatus.confirmed, ReportStatus.not_confirmed)
    assert r2.status == r1.status


def test_s7_monitor_recalls_flying_drone_and_requeues_task(db_session: Session):
    t0 = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
    r = _add_report(db_session, 10.7850, 106.7070, created_at=t0)
    task = enqueue_report(db_session, r, now=t0)
    assert task.mission_id is not None
    first_mission_id = task.mission_id

    t_recall = t0 + timedelta(seconds=20.0)
    recalled = recall_mission(db_session, first_mission_id, reason="Recall for urgent check", now=t_recall)
    assert recalled.state == MissionState.failed

    uav1 = get_drone_state(db_session, "sim-uav-1", t_recall)
    assert uav1.status == DroneStatus.returning

    reassigned = get_task(db_session, task.task_id)
    assert reassigned is not None
    assert reassigned.status == TaskStatus.dispatched
    assert reassigned.drone_id == "sim-uav-2"
    assert reassigned.mission_id is not None
    assert reassigned.mission_id != first_mission_id

    with pytest.raises(HTTPException) as exc_info:
        cancel_task(db_session, reassigned.task_id, reason="Too late")
    assert exc_info.value.status_code == 409


def test_s7_api_recall_and_cancel_endpoints():
    with TestClient(create_app()) as client:
        assert client.post("/dev/reset").status_code == 200

        created_ids = []
        for idx, (lat, lon) in enumerate(
            [
                ("10.7850", "106.7070"),
                ("10.7840", "106.6960"),
                ("10.7720", "106.7050"),
            ]
        ):
            with (_MEDIA / "pothole-1.jpg").open("rb") as photo:
                res = client.post(
                    "/reports",
                    data={"lat": lat, "lon": lon},
                    files={"photo": (f"p-{idx}.jpg", photo, "image/jpeg")},
                )
            assert res.status_code == 201
            created_ids.append(res.json()["id"])

        # Seed mission 1 already occupies sim-uav-1; enqueueing 2 fills sim-uav-2 & sim-uav-3, 3rd queues.
        enq1 = client.post(f"/reports/{created_ids[0]}/enqueue").json()
        enq2 = client.post(f"/reports/{created_ids[1]}/enqueue").json()
        enq3 = client.post(f"/reports/{created_ids[2]}/enqueue").json()
        assert enq1["status"] == "dispatched"
        assert enq2["status"] == "dispatched"
        assert enq3["status"] == "queued"

        # Cancel the queued 3rd report.
        cancel_res = client.post(
            f"/reports/{created_ids[2]}/cancel",
            json={"reason": "Duplicate citizen submission"},
        )
        assert cancel_res.status_code == 200
        assert cancel_res.json()["status"] == "rejected"
        assert cancel_res.json()["review_note"] == "Duplicate citizen submission"

        # Recall the 1st mission -> sim-uav-1 may finish seed flight or stay returning, task requeued cleanly.
        recall_res = client.post(
            f"/missions/{enq1['mission_id']}/recall",
            json={"reason": "Airspace conflict"},
        )
        assert recall_res.status_code == 200
        assert recall_res.json()["state"] == "failed"


def test_s8_edge_processing_failure_requeues_once_then_flags_for_monitor(db_session: Session):
    t0 = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
    r = _add_report(db_session, 10.7800, 106.7030, created_at=t0)

    t1 = enqueue_report(db_session, r, now=t0)
    assert t1.mission_id is not None
    m1_id = t1.mission_id
    m1 = db_session.get(Mission, m1_id)
    assert m1 is not None
    dur1 = estimate(m1.flight_plan.route).duration_s

    set_mission_edge_failure(db_session, m1_id, "Edge inference timeout")
    t_after_m1 = t0 + timedelta(seconds=dur1 + 1.0)
    dispatch_tick(db_session, now=t_after_m1)

    db_session.refresh(m1)
    assert m1.state == MissionState.failed
    task_retry = get_task(db_session, t1.task_id)
    assert task_retry is not None
    assert task_retry.retries == 1
    assert task_retry.status == TaskStatus.dispatched
    assert task_retry.mission_id is not None
    assert task_retry.mission_id != m1_id

    m2 = db_session.get(Mission, task_retry.mission_id)
    assert m2 is not None
    m2_start = get_mission_start(db_session, m2)
    dur2 = estimate(m2.flight_plan.route, start_battery_pct=m2_start.battery_pct, start_pos=m2_start.pos).duration_s

    set_mission_edge_failure(db_session, m2.id, "Edge inference timeout")
    dispatch_tick(db_session, now=_utc(m2.started_at) + timedelta(seconds=dur2 + 1.0))

    db_session.refresh(m2)
    db_session.refresh(r)
    assert m2.state == MissionState.failed
    task_flagged = get_task(db_session, t1.task_id)
    assert task_flagged is not None
    assert task_flagged.status == TaskStatus.flagged
    assert task_flagged.retries == 1
    assert r.status == ReportStatus.under_review
    assert "Flagged for monitor" in (r.review_note or "")
    assert len(list(db_session.scalars(select(Mission)).all())) == 2


def test_s10_drone_goes_offline_excluded_and_active_task_requeued(db_session: Session):
    t0 = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
    set_drone_offline(db_session, "sim-uav-1", True)

    r = _add_report(db_session, 10.7850, 106.7070, created_at=t0)
    task = enqueue_report(db_session, r, now=t0)
    assert task.drone_id == "sim-uav-2"
    first_mission_id = task.mission_id
    assert first_mission_id is not None

    t_off = t0 + timedelta(seconds=15.0)
    set_drone_offline(db_session, "sim-uav-2", True)
    dispatch_tick(db_session, now=t_off)

    m1 = db_session.get(Mission, first_mission_id)
    assert m1 is not None
    assert m1.state == MissionState.failed
    assert get_drone_state(db_session, "sim-uav-2", t_off).status == DroneStatus.offline

    reassigned = get_task(db_session, task.task_id)
    assert reassigned is not None
    assert reassigned.status == TaskStatus.dispatched
    assert reassigned.drone_id == "sim-uav-3"
    assert reassigned.mission_id != first_mission_id


def _utc(dt: datetime | None) -> datetime:
    assert dt is not None
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)
