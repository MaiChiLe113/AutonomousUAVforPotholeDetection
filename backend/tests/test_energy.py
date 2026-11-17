from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.flight_planner import FlightPlanner
from config import ENERGY, UAV
from sim.energy import destination, estimate, sim_seconds, wall_seconds
from sim.mock_flight import flight_duration_s, telemetry_at


@pytest.mark.parametrize("scale", [1.0, 10.0, 15.0, 60.0])
@pytest.mark.parametrize("start_bat", [100.0, 78.5])
def test_estimate_matches_telemetry_end_at_any_time_scale(scale: float, start_bat: float):
    cfg = replace(ENERGY, time_scale=scale)
    plan = FlightPlanner(energy=cfg).propose(10.785, 106.710, start_battery_pct=start_bat)
    est = estimate(plan.route, start_battery_pct=start_bat, cfg=cfg)

    assert est["duration_s"] == est.duration_s == plan.estimated_duration_s
    assert est["battery_used_pct"] == est.battery_used_pct == plan.estimated_battery_pct
    assert est["legs"] is est.legs
    assert sim_seconds(wall_seconds(est.duration_s, cfg), cfg) == pytest.approx(est.duration_s)
    assert flight_duration_s(plan.route, energy_cfg=cfg) == est.duration_s

    home = (UAV.home_lat, UAV.home_lon, 0.0)
    end_sample = telemetry_at(
        plan.route,
        est.duration_s,
        plan.drone_id,
        home,
        start_battery_pct=start_bat,
        energy_cfg=cfg,
    )
    assert end_sample["state"] == "done"
    assert end_sample["progress_pct"] == 100.0
    assert end_sample["battery_pct"] == est.end_battery_pct == round(start_bat - est.battery_used_pct, 2)


def test_farther_target_costs_more_time_and_battery():
    planner = FlightPlanner()
    near_plan = planner.propose(10.7780, 106.7020)
    far_plan = planner.propose(10.7880, 106.7120)

    assert far_plan.estimated_duration_s > near_plan.estimated_duration_s
    assert far_plan.estimated_battery_pct > near_plan.estimated_battery_pct


def test_edge_of_service_area_sanity_check():
    edge_lat, edge_lon = destination((UAV.home_lat, UAV.home_lon), 45.0, 2000.0)
    plan = FlightPlanner().propose(edge_lat, edge_lon)

    assert 450.0 <= plan.estimated_duration_s <= 510.0
    assert 22.0 <= plan.estimated_battery_pct <= 26.0


def test_mid_air_route_skips_ground_climb():
    start_pos = (10.778, 106.702, 30.0)
    plan = FlightPlanner().propose(
        10.780,
        106.705,
        start_pos=start_pos,
        start_battery_pct=75.0,
        return_to_home=False,
    )
    est = estimate(plan.route, start_battery_pct=75.0, start_pos=start_pos)

    assert all(leg.phase not in ("climb", "descent") for leg in est.legs)

    home = (UAV.home_lat, UAV.home_lon, 0.0)
    start_sample = telemetry_at(
        plan.route,
        0.0,
        plan.drone_id,
        home,
        start_battery_pct=75.0,
        start_pos=start_pos,
    )
    assert start_sample["altitude_m"] == 30.0
    assert start_sample["battery_pct"] == 75.0

    end_sample = telemetry_at(
        plan.route,
        est.duration_s,
        plan.drone_id,
        home,
        start_battery_pct=75.0,
        start_pos=start_pos,
    )
    assert end_sample["altitude_m"] == 30.0
    assert end_sample["state"] == "done"
    assert end_sample["battery_pct"] == est.end_battery_pct


def test_flight_plan_api_returns_estimates():
    with TestClient(create_app()) as client:
        res = client.get("/flight-plans/1")
        assert res.status_code == 200
        plan = res.json()

    est = estimate(plan["route"])
    assert plan["estimated_duration_s"] > 0
    assert plan["estimated_battery_pct"] > 0
    assert plan["estimated_duration_s"] == est.duration_s
    assert plan["estimated_battery_pct"] == est.battery_used_pct
