"""Go / no-go gate, simulated weather, hold and release, mid-flight recall, priority and the decision log."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db import Base
from app.models import Detection, Mission, MissionState, Report, ReportStatus
from app.services import safety
from app.services.dispatcher import TaskStatus, dispatch_tick, enqueue_report, get_task
from app.services.fleet import DroneStatus, get_drone_state
from app.services.flight_planner import FlightPlanner
from app.services.safety import (
    LaunchPoint,
    can_fly,
    clear_weather_override,
    list_decisions,
    log_decision,
    mid_flight_check,
    report_priority,
    set_weather_override,
    weather_at,
)
from config import ENERGY, FLEET, SAFETY, WEATHER
from sim.energy import estimate, phase_drain_pct_per_s

T0 = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
TARGET = (10.7800, 106.7030)  # about 450 m from base
BASE_POS = (FLEET.base_lat, FLEET.base_lon, FLEET.base_alt_m)


@pytest.fixture()
def db_session(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'safety_test.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    local = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with local() as db:
        yield db


def _report(db: Session, lat: float, lon: float, *, created_at: datetime = T0, cls: str | None = None, conf=0.5):
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
    if cls is not None:
        db.add(
            Detection(
                report_id=report.id,
                source="server",
                deployment="server-fp32",
                cls=cls,
                confidence=conf,
                box_xyxy=[0, 0, 10, 10],
                frame_id=f"f{report.id}",
                model_version="t",
            )
        )
        db.commit()
        db.refresh(report)
    return report


# ---------------------------------------------------------------------------
# Weather
# ---------------------------------------------------------------------------
def test_weather_timeline_is_seeded_and_has_a_storm_window():
    cfg = replace(WEATHER, enabled=True)
    storm = datetime.fromtimestamp(240 * 1_000_000 + 10, UTC)  # 10 s into a cycle: inside the storm window
    calm = datetime.fromtimestamp(240 * 1_000_000 + 120, UTC)  # half way: calm, no rain

    a, b = weather_at(storm, weather_cfg=cfg), weather_at(storm, weather_cfg=cfg)
    assert a == b and a.simulated
    assert a.wind_mps > SAFETY.max_wind_mps and not a.flyable

    c = weather_at(calm, weather_cfg=cfg)
    assert cfg.calm_wind_mps[0] <= c.wind_mps <= cfg.calm_wind_mps[1]
    assert c.gust_mps >= c.wind_mps and not c.rain and c.flyable


def test_weather_disabled_is_calm():
    wx = weather_at(T0, weather_cfg=replace(WEATHER, enabled=False))
    assert (wx.wind_mps, wx.gust_mps, wx.rain, wx.flyable) == (0.0, 0.0, False, True)


def test_wind_costs_battery_but_not_time():
    route = FlightPlanner().propose(*TARGET, return_to_home=True).route
    calm = estimate(route)
    windy = estimate(route, cfg=replace(ENERGY, wind_mps=8.0))
    assert windy.duration_s == calm.duration_s
    factor = 1 + ENERGY.wind_drain_per_mps * 8.0
    assert windy.battery_used_pct == pytest.approx(calm.battery_used_pct * factor, rel=0.02)
    assert ENERGY.wind_mps == 0.0
    assert phase_drain_pct_per_s("outbound") < phase_drain_pct_per_s("outbound", replace(ENERGY, wind_mps=5.0))


# ---------------------------------------------------------------------------
# can_fly
# ---------------------------------------------------------------------------
class _Target:
    lat, lon = TARGET


def _wx(db: Session, wind: float, gust: float | None = None, rain: bool = False):
    set_weather_override(db, wind, gust, rain)
    return safety.current_weather(db, T0)


def test_can_fly_go_when_calm(db_session: Session):
    res = can_fly(LaunchPoint("sim-uav-1", BASE_POS, 100.0), _Target, T0, weather=_wx(db_session, 2.0))
    assert res.go and res.code == "go" and res.reasons == []


def test_can_fly_reports_wind_with_human_reason(db_session: Session):
    res = can_fly(LaunchPoint("sim-uav-1", BASE_POS, 100.0), _Target, T0, weather=_wx(db_session, 11.2, 11.5))
    assert not res.go and res.hold and res.code == "wind"
    assert res.reasons == ["Wind 11.2 m/s exceeds 8.0 m/s limit"]


def test_can_fly_rain_gust_low_battery_offline_out_of_area(db_session: Session):
    pad = LaunchPoint("sim-uav-1", BASE_POS, 100.0)
    assert can_fly(pad, _Target, T0, weather=_wx(db_session, 2.0, 2.0, rain=True)).code == "rain"
    assert can_fly(pad, _Target, T0, weather=_wx(db_session, 2.0, 14.0)).code == "gust"

    low = can_fly(LaunchPoint("sim-uav-1", BASE_POS, 20.0), _Target, T0, weather=_wx(db_session, 1.0))
    assert not low.go and low.code == "low_battery" and low.hold

    off = LaunchPoint("sim-uav-1", BASE_POS, 100.0, DroneStatus.offline)
    assert can_fly(off, _Target, T0, weather=_wx(db_session, 1.0)).code == "offline"

    class Far:
        lat, lon = 10.8000, 106.7300

    far = can_fly(pad, Far, T0, weather=_wx(db_session, 1.0))
    assert far.code == "out_of_area" and not far.hold


def test_wind_adjusted_round_trip_can_flip_a_feasible_trip(db_session: Session):
    """Enough battery in calm air, not enough at 7.9 m/s (still under the wind limit): wait for the wind."""
    calm_used = FlightPlanner().propose(*TARGET, start_pos=BASE_POS, start_battery_pct=100.0).estimated_battery_pct
    battery = ENERGY.reserve_pct + calm_used + 1.0  # one percent of slack in calm air
    pad = LaunchPoint("sim-uav-1", BASE_POS, battery)

    assert can_fly(pad, _Target, T0, weather=_wx(db_session, 0.0)).go
    windy = can_fly(pad, _Target, T0, weather=_wx(db_session, 7.9, 7.9))
    assert not windy.go and windy.code == "wind_range" and windy.hold

    short = can_fly(LaunchPoint("sim-uav-1", BASE_POS, ENERGY.reserve_pct + calm_used - 1.0), _Target, T0)
    assert short.code == "insufficient_battery" and not short.hold  # too far even in calm air: not a weather hold


# ---------------------------------------------------------------------------
# Hold, release, decision log
# ---------------------------------------------------------------------------
def test_wind_holds_the_task_then_it_launches_when_the_wind_drops(db_session: Session):
    set_weather_override(db_session, 11.2, 12.0)
    report = _report(db_session, *TARGET)

    task = enqueue_report(db_session, report, now=T0)
    assert task.status == TaskStatus.held and task.mission_id is None
    assert task.hold_reason == "Wind 11.2 m/s exceeds 8.0 m/s limit"
    assert report.status == ReportStatus.under_review

    holds = [d for d in list_decisions(db_session) if d.action == "hold"]
    assert len(holds) == 1 and holds[0].code == "wind" and holds[0].report_id == report.id

    dispatch_tick(db_session, T0 + timedelta(seconds=5))  # still windy: still held, not logged again
    assert get_task(db_session, task.task_id).status == TaskStatus.held
    assert len([d for d in list_decisions(db_session) if d.action == "hold"]) == 1

    clear_weather_override(db_session)
    launched = dispatch_tick(db_session, T0 + timedelta(seconds=10))
    assert len(launched) == 1
    after = get_task(db_session, task.task_id)
    assert after.status == TaskStatus.dispatched and after.hold_reason is None and after.drone_id is not None
    log = list_decisions(db_session)
    assert log[0].action == "launch" and log[0].drone_id == after.drone_id and log[0].report_id == report.id


def test_rain_holds_the_task(db_session: Session):
    set_weather_override(db_session, 1.0, 1.0, rain=True)
    task = enqueue_report(db_session, _report(db_session, *TARGET), now=T0)
    assert task.status == TaskStatus.held and task.hold_reason == "Rain in the area"


def test_low_battery_holds_the_task(db_session: Session, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(safety, "SAFETY", replace(SAFETY, min_launch_battery_pct=101.0))
    task = enqueue_report(db_session, _report(db_session, *TARGET), now=T0)
    assert task.status == TaskStatus.held and task.hold_code == "low_battery"
    assert "launch minimum" in (task.hold_reason or "")


def test_task_that_only_waits_for_a_free_drone_is_queued_not_held(db_session: Session):
    one = replace(FLEET, drone_ids=("sim-uav-1",))
    first = enqueue_report(db_session, _report(db_session, *TARGET), now=T0, fleet_cfg=one)
    second = enqueue_report(db_session, _report(db_session, 10.7880, 106.7120), now=T0, fleet_cfg=one)
    assert first.status == TaskStatus.dispatched
    assert second.status == TaskStatus.queued and second.hold_reason is None


def test_cancel_works_on_a_held_task(db_session: Session):
    from app.services.dispatcher import cancel_task

    set_weather_override(db_session, 12.0)
    task = enqueue_report(db_session, _report(db_session, *TARGET), now=T0)
    assert task.status == TaskStatus.held
    assert cancel_task(db_session, task.task_id).status == TaskStatus.cancelled


def test_decision_log_is_capped_and_newest_first(db_session: Session, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(safety, "SAFETY", replace(SAFETY, decision_log_max=3))
    for i in range(5):
        log_decision(db_session, "hold", "wind", f"reason {i}", at=T0 + timedelta(seconds=i), report_id=i)
    log = list_decisions(db_session)
    assert [d.reason for d in log] == ["reason 4", "reason 3", "reason 2"]
    assert len({d.id for d in log}) == 3


# ---------------------------------------------------------------------------
# Mid-flight
# ---------------------------------------------------------------------------
def _launch_calm(db: Session):
    task = enqueue_report(db, _report(db, *TARGET), now=T0)
    assert task.status == TaskStatus.dispatched and task.mission_id is not None
    return task


def test_bad_weather_recalls_a_flying_drone_and_holds_its_task(db_session: Session):
    task = _launch_calm(db_session)

    set_weather_override(db_session, 12.5, 13.0)  # above the 8 m/s limit plus the 2 m/s margin
    t_check = T0 + timedelta(seconds=20)
    dispatch_tick(db_session, t_check)

    mission = db_session.get(Mission, task.mission_id)
    assert mission.state == MissionState.failed
    held = get_task(db_session, task.task_id)
    assert held.status == TaskStatus.held and held.hold_code == "wind"
    assert get_drone_state(db_session, task.drone_id, t_check).status == DroneStatus.returning

    log = list_decisions(db_session)
    recall = next(d for d in log if d.action == "recall")
    assert recall.code == "wind" and recall.drone_id == task.drone_id
    assert any(d.action == "hold" for d in log)


def test_wind_between_launch_limit_and_recall_limit_does_not_recall(db_session: Session):
    task = _launch_calm(db_session)
    set_weather_override(db_session, 9.0, 9.5)  # above the launch limit, inside the recall margin
    assert mid_flight_check(db_session, T0 + timedelta(seconds=20)) == []
    assert db_session.get(Mission, task.mission_id).state != MissionState.failed


def test_rain_recalls_and_mid_flight_check_is_a_noop_when_disabled(db_session: Session, monkeypatch):
    task = _launch_calm(db_session)
    set_weather_override(db_session, 1.0, 1.0, rain=True)
    monkeypatch.setattr(safety, "SAFETY", replace(SAFETY, mid_flight_recall=False))
    assert mid_flight_check(db_session, T0 + timedelta(seconds=20)) == []
    monkeypatch.setattr(safety, "SAFETY", SAFETY)
    recalled = mid_flight_check(db_session, T0 + timedelta(seconds=20))
    assert [m.id for m in recalled] == [task.mission_id]


# ---------------------------------------------------------------------------
# Priority
# ---------------------------------------------------------------------------
def test_report_priority_from_severity_and_confidence(db_session: Session):
    none = _report(db_session, *TARGET)
    crack = _report(db_session, *TARGET, cls="D00", conf=0.5)
    pothole = _report(db_session, *TARGET, cls="D40", conf=0.5)
    sure_pothole = _report(db_session, *TARGET, cls="D40", conf=0.95)
    assert report_priority(none) == SAFETY.priority_default
    assert report_priority(crack) < report_priority(pothole) < report_priority(sure_pothole)


def test_higher_priority_task_flies_first_even_when_newer(db_session: Session):
    one = replace(FLEET, drone_ids=("sim-uav-1",))
    set_weather_override(db_session, 12.0)  # both tasks wait on the ground
    low = _report(db_session, *TARGET, created_at=T0, cls="D00", conf=0.5)
    high = _report(db_session, 10.7810, 106.7040, created_at=T0 + timedelta(seconds=1), cls="D40", conf=0.9)
    t_low = enqueue_report(db_session, low, now=T0, fleet_cfg=one)
    t_high = enqueue_report(db_session, high, now=T0 + timedelta(seconds=1), fleet_cfg=one)
    assert t_low.status == t_high.status == TaskStatus.held
    assert t_high.priority > t_low.priority

    clear_weather_override(db_session)
    dispatch_tick(db_session, T0 + timedelta(seconds=5), fleet_cfg=one)
    assert get_task(db_session, t_high.task_id).status == TaskStatus.dispatched
    assert get_task(db_session, t_low.task_id).status in (TaskStatus.queued, TaskStatus.held)


def test_equal_priority_keeps_oldest_first(db_session: Session):
    one = replace(FLEET, drone_ids=("sim-uav-1",))
    set_weather_override(db_session, 12.0)
    old = _report(db_session, *TARGET, created_at=T0)
    new = _report(db_session, 10.7810, 106.7040, created_at=T0 + timedelta(seconds=1))
    t_old = enqueue_report(db_session, old, now=T0, fleet_cfg=one)
    t_new = enqueue_report(db_session, new, now=T0 + timedelta(seconds=1), fleet_cfg=one)
    clear_weather_override(db_session)
    dispatch_tick(db_session, T0 + timedelta(seconds=5), fleet_cfg=one)
    assert get_task(db_session, t_old.task_id).status == TaskStatus.dispatched
    assert get_task(db_session, t_new.task_id).status != TaskStatus.dispatched


# ---------------------------------------------------------------------------
# Time scale
# ---------------------------------------------------------------------------
def test_time_scale_compresses_flights_for_the_dispatcher_and_the_mission_clock(db_session: Session, monkeypatch):
    from app.routers import common
    from app.services.fleet import get_mission_start

    fast = replace(ENERGY, time_scale=15.0)
    monkeypatch.setattr(common, "ENERGY", fast)
    task = enqueue_report(db_session, _report(db_session, *TARGET), now=T0, energy_cfg=fast)
    mission = db_session.get(Mission, task.mission_id)
    start = get_mission_start(db_session, mission)
    duration = estimate(mission.flight_plan.route, start_battery_pct=start.battery_pct, start_pos=start.pos).duration_s

    halfway = T0 + timedelta(seconds=duration / 15 / 2)
    assert common.mission_elapsed_s(mission, halfway) == pytest.approx(duration / 2, rel=1e-3)
    assert get_drone_state(db_session, task.drone_id, halfway, energy_cfg=fast).status == DroneStatus.flying

    done = T0 + timedelta(seconds=duration / 15 + 0.5)
    dispatch_tick(db_session, done, energy_cfg=fast)
    assert get_task(db_session, task.task_id).status == TaskStatus.completed
    assert db_session.get(Mission, task.mission_id).state == MissionState.done
    assert get_drone_state(db_session, task.drone_id, done, energy_cfg=fast).status != DroneStatus.flying


# ---------------------------------------------------------------------------
# Hold release and lock-related behaviour
# ---------------------------------------------------------------------------
def test_held_task_is_released_when_the_gate_no_longer_blocks_it(db_session: Session):
    """Weather cleared but no drone was checked this pass (all busy): it waits as queued, not held."""
    from app.services.dispatcher import _update_holds
    from app.services.safety import SafetyGate

    set_weather_override(db_session, 12.0)
    task = enqueue_report(db_session, _report(db_session, *TARGET), now=T0)
    assert task.status == TaskStatus.held
    clear_weather_override(db_session)

    gate = SafetyGate(db_session, T0 + timedelta(seconds=5))  # no drone checked: blocked() is None, passed is empty
    assert gate.blocked(task.task_id) is None and task.task_id not in gate.passed
    _update_holds(db_session, [task], set(), gate, T0 + timedelta(seconds=5))
    released = get_task(db_session, task.task_id)
    assert released.status == TaskStatus.queued and released.hold_reason is None and released.hold_code is None


def test_recall_does_not_run_the_weather_check_again(db_session: Session, monkeypatch):
    from app.services import dispatcher

    task = _launch_calm(db_session)
    calls = []
    real = dispatcher.mid_flight_check
    monkeypatch.setattr(dispatcher, "mid_flight_check", lambda *a, **k: calls.append(1) or real(*a, **k))
    dispatcher.recall_mission(db_session, task.mission_id, now=T0 + timedelta(seconds=10))
    assert calls == []  # the tick nested inside the recall skips it
    dispatch_tick(db_session, T0 + timedelta(seconds=11))
    assert calls == [1]  # a normal tick still runs it


def test_service_area_tolerance_comes_from_the_fleet_config():
    from sim.energy import destination

    lat, lon = destination((FLEET.base_lat, FLEET.base_lon), 90.0, FLEET.service_radius_m + 0.5)  # 0.5 m too far

    class Spot:
        pass

    Spot.lat, Spot.lon = lat, lon
    pad = LaunchPoint("sim-uav-1", BASE_POS, 100.0)
    assert FLEET.area_epsilon_m == 1e-3
    assert can_fly(pad, Spot, T0).code == "out_of_area"
    lenient = replace(FLEET, area_epsilon_m=1.0)
    assert can_fly(pad, Spot, T0, fleet_cfg=lenient).code != "out_of_area"
