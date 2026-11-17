from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db import Base, SessionLocal
from app.main import create_app
from app.models import FlightPlan, Mission, MissionState, PlanStatus, Report, ReportStatus
from app.routers.missions import _mission_sample
from app.services.fleet import (
    DroneStatus,
    MissionStart,
    get_drone_state,
    get_fleet_state,
    get_mission_start,
    record_mission_start,
    select_drone_for_target,
    set_drone_offline,
)
from app.services.flight_planner import FlightPlanner, OutOfServiceAreaError
from config import ENERGY, FLEET
from sim.energy import estimate

_MEDIA = Path(__file__).resolve().parents[1] / "mock" / "media"


@pytest.fixture()
def db_session(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'fleet_test.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    local = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with local() as db:
        yield db


def _make_mission(
    db: Session,
    *,
    lat: float,
    lon: float,
    drone_id: str,
    start_battery_pct: float = 100.0,
    started_at: datetime | None = None,
    return_to_home: bool = True,
) -> tuple[Mission, float, float]:
    report = Report(lat=lat, lon=lon, photo_path="seed/pothole-1.jpg", status=ReportStatus.uav_dispatched)
    db.add(report)
    db.flush()

    proposal = FlightPlanner().propose(
        lat,
        lon,
        drone_id=drone_id,
        start_pos=(FLEET.base_lat, FLEET.base_lon, FLEET.base_alt_m),
        start_battery_pct=start_battery_pct,
        return_to_home=return_to_home,
    )
    plan = FlightPlan(
        report_id=report.id,
        drone_id=proposal.drone_id,
        altitude_m=proposal.altitude_m,
        survey_radius_m=proposal.survey_radius_m,
        route=proposal.route,
        status=PlanStatus.approved,
    )
    db.add(plan)
    db.flush()

    mission = Mission(
        flight_plan_id=plan.id,
        report_id=report.id,
        state=MissionState.takeoff if started_at else MissionState.pending,
        started_at=started_at,
    )
    db.add(mission)
    db.flush()

    est = estimate(
        plan.route,
        start_battery_pct=start_battery_pct,
        start_pos=(FLEET.base_lat, FLEET.base_lon, FLEET.base_alt_m),
    )
    if started_at is not None:
        record_mission_start(
            db,
            mission,
            MissionStart(FLEET.base_lat, FLEET.base_lon, FLEET.base_alt_m, start_battery_pct),
        )
    db.commit()
    db.refresh(mission)
    return mission, est.duration_s, est.end_battery_pct


def test_fleet_config_has_three_drones_and_2km_radius():
    assert len(FLEET.drone_ids) == 3
    assert FLEET.service_radius_m == 2000.0


def test_planner_and_api_refuse_target_outside_service_area():
    with pytest.raises(OutOfServiceAreaError, match="service area"):
        FlightPlanner().propose(10.8000, 106.7300)

    with TestClient(create_app()) as client:
        assert client.post("/dev/reset").status_code == 200
        with (_MEDIA / "pothole-1.jpg").open("rb") as photo:
            created = client.post(
                "/reports",
                data={"lat": "10.8000", "lon": "106.7300"},
                files={"photo": ("pothole-1.jpg", photo, "image/jpeg")},
            )
        assert created.status_code == 201
        report = created.json()
        assert report["status"] == "under_review"

        res = client.post(f"/reports/{report['id']}/flight-plan")
        assert res.status_code == 422
        assert "service area" in res.json()["detail"].lower()

        plans = client.get(f"/reports/{report['id']}/flight-plans")
        assert plans.status_code == 200
        assert plans.json() == []


def test_two_missions_fly_at_once_on_different_drones():
    with TestClient(create_app()) as client:
        assert client.post("/dev/reset").status_code == 200

        dispatched_drones = []
        mission_ids = []
        for report_id in (1, 2):
            plan_res = client.post(f"/reports/{report_id}/flight-plan")
            assert plan_res.status_code == 201
            plan = plan_res.json()
            dispatched_drones.append(plan["drone_id"])

            app_res = client.post(f"/flight-plans/{plan['id']}/approve")
            assert app_res.status_code == 200
            mission_id = app_res.json()["mission_id"]
            mission_ids.append(mission_id)

            disp_res = client.post(f"/missions/{mission_id}/dispatch")
            assert disp_res.status_code == 200
            assert disp_res.json()["state"] == "takeoff"

        assert len(set(dispatched_drones)) == 2
        assert dispatched_drones[0] != "sim-uav-1"  # sim-uav-1 is already flying seed mission 1

        with SessionLocal() as db:
            by_id = {d.drone_id: d for d in get_fleet_state(db)}
        for d_id, m_id in zip(dispatched_drones, mission_ids, strict=True):
            assert by_id[d_id].status == DroneStatus.flying
            assert by_id[d_id].active_mission_id == m_id


def test_second_flight_starts_from_landed_battery_when_above_swap_threshold(db_session: Session):
    t0 = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
    m1, dur1, end_bat1 = _make_mission(
        db_session,
        lat=10.7800,
        lon=106.7030,
        drone_id="sim-uav-2",
        start_battery_pct=100.0,
        started_at=t0,
    )
    assert end_bat1 >= ENERGY.swap_below_pct
    assert end_bat1 < 100.0

    t_after = t0 + timedelta(seconds=dur1 + 5.0)
    state_before_m2 = get_drone_state(db_session, "sim-uav-2", t_after)
    assert state_before_m2.status == DroneStatus.idle
    assert state_before_m2.battery_pct == end_bat1

    m2, dur2, end_bat2 = _make_mission(
        db_session,
        lat=10.7800,
        lon=106.7030,
        drone_id="sim-uav-2",
        start_battery_pct=state_before_m2.battery_pct,
        started_at=t_after,
    )
    assert get_mission_start(db_session, m2).battery_pct == end_bat1
    assert end_bat2 < end_bat1

    # Recomputing telemetry on either mission uses its own stored start battery.
    assert _mission_sample(db_session, m1, 0.0)["battery_pct"] == 100.0
    assert _mission_sample(db_session, m1, dur1)["battery_pct"] == end_bat1
    assert _mission_sample(db_session, m2, 0.0)["battery_pct"] == end_bat1
    assert _mission_sample(db_session, m2, dur2)["battery_pct"] == end_bat2


def test_battery_swap_below_threshold_takes_swap_duration_then_resets_to_100(db_session: Session):
    t0 = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
    m1, dur1, end_bat1 = _make_mission(
        db_session,
        lat=10.7880,
        lon=106.7120,
        drone_id="sim-uav-2",
        start_battery_pct=70.0,
        started_at=t0,
    )
    assert end_bat1 < ENERGY.swap_below_pct
    landed_at = t0 + timedelta(seconds=dur1)

    swapping = get_drone_state(db_session, "sim-uav-2", landed_at + timedelta(seconds=10.0))
    assert swapping.status == DroneStatus.swapping
    assert swapping.battery_pct == end_bat1
    assert swapping.available_sim_s == pytest.approx(ENERGY.swap_duration_s - 10.0)

    after_swap = get_drone_state(
        db_session,
        "sim-uav-2",
        landed_at + timedelta(seconds=ENERGY.swap_duration_s + 5.0),
    )
    assert after_swap.status == DroneStatus.idle
    assert after_swap.battery_pct == ENERGY.full_battery_pct
    assert after_swap.available_sim_s == 0.0

    m2, _, _ = _make_mission(
        db_session,
        lat=10.7800,
        lon=106.7030,
        drone_id="sim-uav-2",
        start_battery_pct=after_swap.battery_pct,
        started_at=landed_at + timedelta(seconds=ENERGY.swap_duration_s + 5.0),
    )
    assert get_mission_start(db_session, m2).battery_pct == 100.0
    assert m1.id != m2.id


def test_returning_and_offline_statuses(db_session: Session):
    t0 = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
    _, dur1, _ = _make_mission(
        db_session,
        lat=10.7820,
        lon=106.7050,
        drone_id="sim-uav-2",
        start_battery_pct=100.0,
        started_at=t0,
        return_to_home=False,
    )

    returning = get_drone_state(db_session, "sim-uav-2", t0 + timedelta(seconds=dur1 + 5.0))
    assert returning.status == DroneStatus.returning
    assert returning.altitude_m > 0.0
    assert (returning.lat, returning.lon) != (FLEET.base_lat, FLEET.base_lon)

    back_home = get_drone_state(db_session, "sim-uav-2", t0 + timedelta(seconds=dur1 + 500.0))
    assert back_home.status == DroneStatus.idle
    assert back_home.altitude_m == 0.0

    set_drone_offline(db_session, "sim-uav-1", True)
    set_drone_offline(db_session, "sim-uav-3", True)
    assert get_drone_state(db_session, "sim-uav-3", back_home.available_at).status == DroneStatus.offline

    chosen = select_drone_for_target(db_session, 10.7800, 106.7030, now=t0 + timedelta(seconds=dur1 + 500.0))
    assert chosen is not None
    assert chosen.drone_id == "sim-uav-2"
