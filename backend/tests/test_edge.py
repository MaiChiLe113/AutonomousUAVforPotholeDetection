import logging
from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.models import Detection, FlightPlan, Mission, MissionState, PlanStatus, Report, ReportStatus
from app.routers.common import complete_mission
from config import EDGE_WORKER, EXPORT, FLEET
from edge.benchmark import benchmark, format_benchmark_table, stability_test
from edge.worker import EdgeWorkerClient, create_worker_app
from ml.export import Exporter

_MEDIA = Path(__file__).resolve().parents[1] / "mock" / "media"


class _FakeYolo:
    def __init__(self, weights: Path, val_map: float = 0.745) -> None:
        self.weights = weights
        self.val_map = val_map
        self.export_calls: list[dict] = []

    def export(self, **kwargs):
        self.export_calls.append(kwargs)
        fmt = kwargs["format"]
        if fmt == "ncnn":
            return self.weights.with_name(f"{self.weights.stem}_ncnn_model")
        return self.weights.with_suffix(".engine")

    def val(self, **kwargs):
        del kwargs
        return {"metrics/mAP50-95(B)": self.val_map}


def test_exporter_pi_and_jetson_packages_and_accuracy_check(tmp_path: Path):
    weights = tmp_path / "best.pt"
    weights.write_bytes(b"weights")
    data_yaml = tmp_path / "data.yaml"
    data_yaml.write_text("path: .\n")

    models: dict[Path, _FakeYolo] = {}

    def loader(path: Path) -> _FakeYolo:
        if path not in models:
            models[path] = _FakeYolo(path, val_map=0.745)
        return models[path]

    pi_exp = Exporter("pi", model_loader=loader)
    pi_no_calib = pi_exp(weights, data_yaml=None, model_version="v1")
    assert pi_no_calib.target == "pi"
    assert pi_no_calib.path.name == "best_ncnn_model"
    assert pi_no_calib.settings["format"] == "ncnn"
    assert pi_no_calib.settings["int8"] is False
    assert pi_no_calib.settings["deployment"] == "pi-ncnn"

    pi_with_calib = pi_exp(weights, data_yaml=data_yaml, model_version="v1")
    assert pi_with_calib.settings["int8"] is True
    assert pi_with_calib.settings["deployment"] == "pi-int8"
    assert pi_exp.check_accuracy(pi_with_calib, fp32_map=0.750, data_yaml=data_yaml) is True
    assert pi_exp.check_accuracy(pi_with_calib, fp32_map=0.800, data_yaml=data_yaml) is False

    jetson_exp = Exporter("jetson", model_loader=loader)
    jetson_pkg = jetson_exp(weights, data_yaml=data_yaml, model_version="v1")
    assert jetson_pkg.path.name == "best.engine"
    assert jetson_pkg.settings["deployment"] == "jetson-int8"


def test_benchmark_and_stability_test_on_seed_frames(tmp_path: Path):
    cfg = replace(EXPORT, warmup_runs=2, benchmark_runs=20)
    calls = 0

    def fake_infer(frame: Path):
        nonlocal calls
        calls += 1
        assert frame.is_file()
        return [{"cls": "D40"}]

    result = benchmark(tmp_path / "yolov8n_ncnn_model", _MEDIA, device="pi3b+-ncnn", cfg=cfg, infer_fn=fake_infer)
    assert calls == 22
    assert result.device == "pi3b+-ncnn"
    assert result.median_latency_ms >= 0.0
    assert result.p95_latency_ms >= result.median_latency_ms
    assert result.crashes == 0
    assert "pi3b+-ncnn" in format_benchmark_table([result])

    assert (
        stability_test(tmp_path / "yolov8n_ncnn_model", _MEDIA, cfg=cfg, infer_fn=fake_infer, duration_s=0.02)
        is True
    )

    def crashing_infer(_frame: Path):
        raise RuntimeError("boom")

    assert (
        stability_test(tmp_path / "yolov8n_ncnn_model", _MEDIA, cfg=cfg, infer_fn=crashing_infer, duration_s=0.02)
        is False
    )


def test_edge_worker_hil_mission_and_logged_fallback_when_pi_unreachable(caplog, tmp_path: Path):
    from datetime import UTC, datetime

    def fake_pi_infer(_frame: Path):
        return [
            {
                "cls": "D40",
                "confidence": 0.91,
                "box_xyxy": [100.0, 200.0, 320.0, 410.0],
            }
        ]

    app = create_worker_app(infer_fn=fake_pi_infer, deployment="pi-ncnn", model_version="v0.1")
    hil = EdgeWorkerClient(cfg=replace(EDGE_WORKER, worker_url="http://pi.local:8001"))

    with TestClient(app) as client:
        assert client.get("/health").json()["deployment"] == "pi-ncnn"
        dets, lat_ms = hil.infer_mission(
            "sim-uav-1",
            [{"id": 1, "cls": "D40"}],
            (10.7800, 106.7030),
            frame_path=_MEDIA / "pothole-1.jpg",
            client=client,
        )
    assert len(dets) == 1
    assert dets[0]["deployment"] == "pi-ncnn"
    assert dets[0]["cls"] == "D40"
    assert lat_ms == hil.measured_latency_ms
    assert hil.survey_dwell_s() == round(lat_ms / 1000.0, 3)

    # Persist detections from the Pi worker onto a simulated Mission and verify DB state.
    engine = create_engine(f"sqlite:///{tmp_path / 'hil_test.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    local = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with local() as db:
        r = Report(lat=10.7800, lon=106.7030, photo_path="seed/pothole-1.jpg", status=ReportStatus.uav_dispatched)
        db.add(r)
        db.flush()
        fp = FlightPlan(
            report_id=r.id,
            drone_id="sim-uav-1",
            altitude_m=30.0,
            survey_radius_m=25.0,
            route=[{"lat": FLEET.base_lat, "lon": FLEET.base_lon, "alt": 30.0, "action": "takeoff"}],
            status=PlanStatus.approved,
        )
        db.add(fp)
        db.flush()
        m = Mission(flight_plan_id=fp.id, report_id=r.id, state=MissionState.surveying)
        db.add(m)
        db.commit()
        db.refresh(m)

        assert complete_mission(db, m, datetime(2026, 11, 16, 10, 5, tzinfo=UTC), dets) is True
        db.refresh(r)
        assert r.status == ReportStatus.confirmed
        stored_dets = list(db.scalars(select(Detection).where(Detection.mission_id == m.id)).all())
        assert len(stored_dets) == 1
        assert stored_dets[0].deployment == "pi-ncnn"
        assert stored_dets[0].cls == "D40"

    # Drones 2 and 3 use mock edge with processing delay sampled from Pi's measured latency.
    d2_dets, d2_lat = hil.infer_mission("sim-uav-2", [{"id": 1, "cls": "D40"}], (10.7800, 106.7030))
    assert isinstance(d2_dets, list)
    assert abs(d2_lat - hil.measured_latency_ms) <= EDGE_WORKER.latency_jitter_ms + 0.01

    # Unreachable Pi worker for drone 1 logs a warning (never silent) and falls back to mock edge.
    class _BrokenClient:
        def post(self, *_args, **_kwargs):
            raise RuntimeError("connection timed out")

    with caplog.at_level(logging.WARNING):
        fb_dets, _ = hil.infer_mission(
            "sim-uav-1",
            [{"id": 1, "cls": "D40"}],
            (10.7800, 106.7030),
            client=_BrokenClient(),
        )
    assert isinstance(fb_dets, list)
    assert any("falling back to mock edge" in rec.message for rec in caplog.records)
