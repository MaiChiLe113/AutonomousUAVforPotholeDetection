"""Every changeable value in the backend lives here.

Build functions (ml/build.py) read these settings, and run scripts (run/*.py) only call
build functions. To change an experiment, a threshold or a path, edit this file only.

Machine-specific values and secrets come from backend/.env (template: backend/.env.example).
Section references (§3.x) point to the Task 1 report.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")


def _env(name: str, default: str) -> str:
    value = os.getenv(name)
    return value if value else default


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class PathsConfig:
    data_dir: Path = ROOT / "data"
    raw_dir: Path = ROOT / "data" / "raw"  # Hugging Face download
    processed_dir: Path = ROOT / "data" / "processed"  # deduped, YOLO format
    splits_dir: Path = ROOT / "data" / "splits"  # train/val/test lists + frozen test hash
    field_dir: Path = ROOT / "data" / "field"  # checked resident/UAV images (field set)
    runs_dir: Path = ROOT / "runs"  # Ultralytics training output
    weights_dir: Path = ROOT / "weights"  # exported/served weights
    reports_dir: Path = ROOT / "runs" / "reports"  # comparison tables, drift HTML
    media_dir: Path = Path(_env("MEDIA_DIR", str(ROOT / "data" / "media")))


# ---------------------------------------------------------------------------
# Data (§3.1a, §3.1b) - SCRUM-18
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class DataConfig:
    hf_dataset_id: str = "TODO/unified-road-defect-dataset"  # TODO(SCRUM-18, Chi): real HF repo id
    hf_revision: str = "main"
    hf_repo_type: str = "dataset"
    hf_token: str | None = os.getenv("HF_TOKEN") or None
    classes: tuple[str, ...] = ("D00", "D10", "D20", "D40")
    class_names: tuple[str, ...] = (
        "longitudinal crack",
        "transverse crack",
        "alligator crack",
        "pothole",
    )
    split: tuple[float, float, float] = (0.70, 0.15, 0.15)  # train, val, test
    stratify_by: str = "view"  # "ground" vs "aerial" ratio kept in every subset
    views: tuple[str, ...] = ("ground", "aerial")
    dedupe_hash_threshold: int = 4  # max perceptual-hash distance counted as duplicate
    seed: int = 42
    oversample_classes: tuple[str, ...] = ("D20", "D40")  # only if their AP falls behind
    oversample_factor: int = 1  # 1 = off


# ---------------------------------------------------------------------------
# Augmentation, training images only (§3.1 Table 3.2)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class AugmentConfig:
    hsv_v: float = 0.4  # brightness
    hsv_s: float = 0.5  # saturation/contrast
    blur_p: float = 0.01
    noise_p: float = 0.01
    fliplr: float = 0.5
    degrees: float = 5.0  # small rotations
    scale: float = 0.5
    crop_fraction: float = 1.0
    mosaic: float = 1.0


# ---------------------------------------------------------------------------
# Training (§3.1d) - SCRUM-19, SCRUM-25
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class TrainConfig:
    candidates: tuple[str, ...] = ("yolov8n.pt", "yolo11n.pt", "yolo26n.pt")
    baseline: str = "yolov8n.pt"
    imgsz: int = 640
    epochs: int = 100
    patience: int = 20  # early stopping
    batch: int = 32
    device: str = _env("DEVICE", "0")
    workers: int = 8
    optimizer: str = "auto"
    lr0: float = 0.01
    seed: int = 42
    smoke_fraction: float = 0.05  # share of data for quick "smoke" runs on a local GPU
    smoke_epochs: int = 3


# ---------------------------------------------------------------------------
# Inference on the server (§3.1d Table 3.4) - SCRUM-26, SCRUM-29
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class InferConfig:
    # Per-class confidence thresholds, set on validation data by run/tune_thresholds.py.
    conf_thresholds: dict[str, float] = field(
        default_factory=lambda: {"D00": 0.25, "D10": 0.25, "D20": 0.25, "D40": 0.25}
    )
    iou: float = 0.7
    max_det: int = 100
    imgsz: int = 640
    server_precision: str = "fp32"
    server_weights: str = os.getenv("SERVER_WEIGHTS", "")  # empty = MLflow champion


# ---------------------------------------------------------------------------
# Edge export (§3.4) - SCRUM-35
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class ExportConfig:
    formats: dict[str, str] = field(default_factory=lambda: {"jetson": "engine", "pi": "ncnn"})
    int8: bool = True
    calib_split: str = "val"  # includes aerial views
    batch: int = 1
    imgsz: int = 640
    max_map_drop: float = 0.01  # vs FP32 on the frozen test set
    stability_minutes: int = 30
    warmup_runs: int = 10
    benchmark_runs: int = 100


# ---------------------------------------------------------------------------
# Champion vs challenger promotion (§3.2)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class PromotionConfig:
    max_class_ap_drop: float = 0.01
    require_aerial_gain: bool = True
    require_field_no_worse: bool = True
    require_edge_checks: bool = True


# ---------------------------------------------------------------------------
# MLOps tooling (§3.5) - SCRUM-21, SCRUM-28
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class MlopsConfig:
    mlflow_uri: str = _env("MLFLOW_TRACKING_URI", "http://localhost:5000")
    experiment_name: str = "pothole-yolo"
    registry_model_name: str = "pothole-detector"
    champion_alias: str = "champion"
    challenger_alias: str = "challenger"


# ---------------------------------------------------------------------------
# Monitoring, drift and retraining triggers (§3.2 Table 3.5, §3.3) - SCRUM-36, SCRUM-46
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class MonitorConfig:
    drift_features: tuple[str, ...] = (
        "brightness",
        "contrast",
        "blur",
        "resolution",
        "view",
        "predicted_class",
    )
    ks_pvalue: float = 0.05
    drift_feature_share: float = 1 / 3  # alert if more than this share of features drift
    corrections_window: int = 200
    corrections_rate: float = 0.15
    uav_window: int = 50
    uav_disagree_rate: float = 0.20
    min_new_images: int = 500
    scheduled_review_days: int = 30


# ---------------------------------------------------------------------------
# Single source of the fleet identity and the base location (FleetConfig and UavConfig both read these)
# ---------------------------------------------------------------------------
_DRONE_IDS: tuple[str, ...] = ("sim-uav-1", "sim-uav-2", "sim-uav-3")
_BASE_LAT = 10.7769
_BASE_LON = 106.7009


# ---------------------------------------------------------------------------
# UAV simulation and flight planning (§2.1) - SCRUM-22, SCRUM-27, SCRUM-33
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class UavConfig:
    home_lat: float = _BASE_LAT  # derived from the fleet base (one source)
    home_lon: float = _BASE_LON
    default_altitude_m: float = 30.0
    survey_radius_m: float = 25.0
    speed_mps: float = 5.0
    camera_fov_deg: float = 84.0
    camera_resolution: tuple[int, int] = (1920, 1080)
    frame_interval_s: float = 1.0
    telemetry_interval_s: float = 1.0
    drone_ids: tuple[str, ...] = _DRONE_IDS  # derived from the fleet (one source)
    merge_radius_m: float = 2.0  # detections closer than this are one defect


# ---------------------------------------------------------------------------
# Energy, battery and simulated clock (docs/fleet-plan.md §4)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class EnergyConfig:
    """Reference drone: DJI Mavic 3 Enterprise (docs/fleet-plan.md §4)."""

    battery_capacity_wh: float = 77.0
    cruise_speed_mps: float = 9.0  # 32.4 km/h transit speed
    survey_speed_mps: float = 5.0  # survey circle speed
    climb_speed_mps: float = 3.0  # vertical climb speed
    descent_speed_mps: float = 3.0  # vertical descent speed
    max_speed_mps: float = 15.0  # normal-mode upper bound
    cruise_endurance_min: float = 45.0  # 100 / 45 = 2.222... %/min before safety factor
    hover_endurance_min: float = 38.0  # 100 / 38 = 2.631... %/min (hover, survey, climb, descent)
    safety_factor: float = 1.25  # multiplies every battery drain estimate
    reserve_pct: float = 25.0  # minimum battery required upon landing at base
    swap_below_pct: float = 60.0  # swap battery at base only when landing below this level
    swap_duration_s: float = 120.0  # simulated seconds for a battery swap at base
    full_battery_pct: float = 100.0
    survey_dwell_s: float = 0.0  # extra simulated seconds per survey waypoint (for edge inference)
    time_scale: float = float(_env("SIM_TIME_SCALE", "15"))  # sim_seconds = wall_seconds * time_scale (tests: 1)
    time_epsilon_s: float = 1e-3  # simulated seconds of tolerance when comparing elapsed time with a duration
    wind_mps: float = 0.0  # headwind-equivalent wind used for drain estimates (0 = calm, existing behaviour)
    wind_drain_per_mps: float = 0.03  # extra drain fraction per m/s of wind: drain *= 1 + k * wind_mps


# ---------------------------------------------------------------------------
# Fleet state and service area (docs/fleet-plan.md §1, §7 Phase 2)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class FleetConfig:
    """District fleet parameters (docs/fleet-plan.md §1, §7 Phase 2-3)."""

    drone_ids: tuple[str, ...] = _DRONE_IDS
    district_name: str = "District 1, Ho Chi Minh City"
    base_lat: float = _BASE_LAT
    base_lon: float = _BASE_LON
    base_alt_m: float = 0.0
    service_radius_m: float = 2_000.0
    area_epsilon_m: float = 1e-3  # tolerance when testing a target against the service radius
    report_merge_radius_m: float = 15.0  # reports closer than this join an open task
    max_task_retries: int = 1  # requeue once on edge failure, then flag for monitor
    allocator: str = "baseline"  # "baseline" | "auction" | "insertion"
    multi_stop_radius_m: float = 400.0  # nearby tasks within this radius can share one multi-stop plan
    max_stops_per_plan: int = 3  # maximum targets visited in a single flight plan
    re_tasking: bool = False  # enable mid-leg / mid-return insertion when using auction/insertion
    auto_tick: bool = _env("AUTO_TICK", "1") != "0"  # background dispatcher loop in the API (tests set AUTO_TICK=0)
    tick_interval_s: float = 2.0  # wall seconds between background dispatch ticks


# ---------------------------------------------------------------------------
# Flight safety: go / no-go gate, priority, decision log (docs/fleet-plan.md, district plan)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class SafetyConfig:
    """Thresholds the drones use to decide whether to fly. Demo values (a Mavic 3 resists about 12 m/s)."""

    enabled: bool = True
    max_wind_mps: float = 8.0  # no launch above this mean wind
    max_gust_mps: float = 12.0  # no launch above this gust
    rain_blocks_flight: bool = True
    min_launch_battery_pct: float = 30.0  # a drone below this stays on the ground
    mid_flight_recall: bool = True  # recall flying drones when the weather turns bad
    recall_wind_margin_mps: float = 2.0  # recall only above the launch limit plus this margin (hysteresis)
    priority_by_severity: dict[str, int] = field(
        default_factory=lambda: {"D40": 3, "D20": 2, "D10": 1, "D00": 1}  # pothole > alligator > cracks
    )
    priority_default: int = 1  # report without server detections
    priority_confidence_min: float = 0.8  # a detection at or above this confidence raises the priority
    priority_confidence_bonus: int = 1
    decision_log_max: int = 50  # newest decisions kept in AppMeta and returned by GET /fleet
    queue_recent_closed: int = 5  # closed tasks (completed / cancelled) still listed by GET /fleet


# ---------------------------------------------------------------------------
# Simulated weather (clearly labelled simulated; the same interface can take a real feed later)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class WeatherConfig:
    enabled: bool = _env("SIM_WEATHER", "1") != "0"  # False: always calm (tests set SIM_WEATHER=0)
    seed: int = 7
    period_s: float = 240.0  # wall seconds per weather cycle
    step_s: float = 20.0  # wall seconds between calm-weather changes
    calm_wind_mps: tuple[float, float] = (1.0, 5.0)
    gust_extra_mps: tuple[float, float] = (1.0, 4.0)  # gust = wind + a value in this range
    storm_windows: tuple[tuple[float, float], ...] = ((0.0, 0.25),)  # (start, end) as fractions of the period
    storm_wind_mps: tuple[float, float] = (9.5, 13.0)
    rain_windows: tuple[tuple[float, float], ...] = ((0.55, 0.70),)


# ---------------------------------------------------------------------------
# Seeded scenario benchmarks (docs/fleet-plan.md §7 Phase 4, §9)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class ScenarioConfig:
    """Seeded simulation workloads for allocator and scale-out evaluation."""

    seeds: tuple[int, ...] = (42, 43, 44)
    burst_reports: int = 10
    burst_span_s: float = 60.0  # 10 reports arrive within 60 simulated seconds (Scenario S6)
    light_reports: int = 10
    light_interval_s: float = 240.0  # 1 report every 4 simulated minutes
    scale_out_drones: tuple[int, ...] = (3, 5, 10)
    scale_out_reports: int = 15
    scale_out_span_s: float = 90.0
    horizon_s: float = 14_400.0  # 4 simulated hours max horizon to drain the queue
    step_s: float = 5.0  # simulation clock step when advancing between arrivals
    min_target_dist_m: float = 150.0
    max_target_dist_m: float = 1_900.0


# ---------------------------------------------------------------------------
# Edge worker / Raspberry Pi 3 B+ HIL (docs/fleet-plan.md §5, §7 Phase 6)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class EdgeWorkerConfig:
    """Raspberry Pi 3 B+ hardware-in-the-loop edge worker settings."""

    pi_drone_id: str = "sim-uav-1"
    worker_url: str = _env("PI_WORKER_URL", "")  # e.g. "http://192.168.1.50:8001"; empty = fallback
    host: str = "0.0.0.0"
    port: int = 8001
    timeout_s: float = 5.0
    fallback_latency_ms: float = 350.0  # used by mock edge when Pi is unreachable or for drones 2 & 3
    latency_jitter_ms: float = 25.0
    pi_deployment: str = "pi-ncnn"  # "pi-int8" only when verified INT8 quantisation is active


# ---------------------------------------------------------------------------
# API server - SCRUM-23
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class ApiConfig:
    database_url: str = _env("DATABASE_URL", f"sqlite:///{ROOT / 'data' / 'app.db'}")
    cors_origins: tuple[str, ...] = tuple(_env("CORS_ORIGINS", "http://localhost:3000").split(","))
    host: str = "0.0.0.0"
    port: int = 8000
    max_upload_mb: int = 10
    allowed_types: tuple[str, ...] = ("image/jpeg", "image/png")
    role_header: str = "X-Role"  # demo-grade role check, NOT real authentication
    monitor_role: str = "monitor"  # only this role may dispatch, recall, cancel, review and reset


# ---------------------------------------------------------------------------
# Mock prototype (seed data, fake detector, simulated flight) - no real model
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class MockConfig:
    enabled: bool = True
    reset_on_start: bool = False  # True: wipe and reseed on every start (and every --reload)
    seed_if_empty: bool = True  # seed on start only when the database is missing, empty or has an old schema
    reseed_on_seed_change: bool = True  # also reseed on start when seed_version or the seed files changed
    seed_version: str = "2"  # bump to force a reseed on the next start (2 = real pothole photos)
    seed_file: Path = ROOT / "mock" / "seed.json"
    media_seed_dir: Path = ROOT / "mock" / "media"  # copied to PATHS.media_dir / "seed"
    mission_duration_s: float = 45.0
    model_version: str = "mock-0.1"
    battery_start_pct: float = 95.0
    battery_end_pct: float = 60.0
    gimbal_survey_pitch_deg: float = -90.0
    gimbal_transit_pitch_deg: float = -30.0
    camera_live_delay_s: float = 2.0  # "requested" becomes "live" after this delay
    edge_confirm_rate: float = 0.8  # share of missions where the edge model confirms damage
    no_damage_rate: float = 0.25  # share of uploads the mock detector finds nothing in
    # Flight planner + simulated flight (app/services/flight_planner.py, sim/mock_flight.py)
    survey_points: int = 8  # waypoints on the survey circle around the target
    replan_step_pct: float = 0.10  # altitude/radius change per step when the monitor requests changes (1-2 steps)
    flight_phase_shares: tuple[float, float, float, float, float] = (0.10, 0.20, 0.40, 0.20, 0.10)
    # ^ share of mission_duration_s for: takeoff climb, outbound leg, survey circle, return leg, landing descent
    edge_max_detections: int = 3  # most fake edge detections per confirmed mission
    edge_confidence_range: tuple[float, float] = (0.55, 0.95)
    edge_jitter_m: float = 3.0  # fake edge detections are placed within this distance of the target
    edge_deployment: str = "jetson-int8"  # deployment label of the fake edge (UAV) detections
    edge_defect_size_m: tuple[float, float] = (0.5, 1.5)  # fake defect size range; sets the box size in pixels
    # Mock detector boxes (deterministic from the file hash)
    max_boxes: int = 3
    confidence_range: tuple[float, float] = (0.45, 0.95)
    box_size_range: tuple[float, float] = (0.12, 0.35)  # box side as a share of the image side
    fallback_image_size: tuple[int, int] = (1280, 960)  # only if an upload's JPEG/PNG header cannot be read
    # Media sub-folders under PATHS.media_dir (both are wiped by a reset)
    seed_media_subdir: str = "seed"
    upload_subdir: str = "uploads"
    home_alt_m: float = 0.0  # simulated home altitude (UAV.home_lat/lon is the home position)
    ingest_hold_s: float = 5.0  # a drone message from /telemetry/ingest overrides the simulation this long


PATHS = PathsConfig()
DATA = DataConfig()
AUGMENT = AugmentConfig()
TRAIN = TrainConfig()
INFER = InferConfig()
EXPORT = ExportConfig()
PROMOTION = PromotionConfig()
MLOPS = MlopsConfig()
MONITOR = MonitorConfig()
UAV = UavConfig()
ENERGY = EnergyConfig()
FLEET = FleetConfig()
SAFETY = SafetyConfig()
WEATHER = WeatherConfig()
SCENARIOS = ScenarioConfig()
EDGE_WORKER = EdgeWorkerConfig()
API = ApiConfig()
MOCK = MockConfig()
