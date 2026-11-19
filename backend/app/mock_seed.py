"""Demo data for the mock prototype: wipe the database and load backend/mock/seed.json.

Called by POST /dev/reset, and from the API lifespan through `seed_on_start`: it seeds when the database
is missing, empty or on an old schema (MOCK.seed_if_empty), or when the seed changed since the database was
seeded (MOCK.reseed_on_seed_change: MOCK.seed_version plus a hash of seed.json and mock/media, stored in the
app_meta table). Otherwise a start or --reload keeps the demo data. Times in the seed file are relative to
the seeding, so the "in flight" mission is mid-flight right after every reset.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy import func, inspect, select
from sqlalchemy.orm import Session

from app import models  # noqa: F401  (registers every table on Base.metadata)
from app.db import Base
from app.models import AppMeta, Detection, FlightPlan, Mission, MissionState, PlanStatus, Report, ReportStatus
from app.routers.common import edge_detection_row, now_utc
from app.services.flight_planner import FlightPlanner
from app.services.mock_detector import image_size
from app.services.simclock import sim_delta
from config import INFER, MOCK, PATHS, MockConfig
from sim.mock_flight import flight_duration_s

log = logging.getLogger(__name__)

_SEED_KEY = "seed_fingerprint"


@dataclass
class SeedCounts:
    reports: int
    flight_plans: int
    missions: int
    reset_at: datetime


def _clear_subdir(name: str) -> Path:
    """Empty PATHS.media_dir / name (only a real sub-folder, never media_dir itself)."""
    folder = (PATHS.media_dir / name).resolve()
    if not name or folder == PATHS.media_dir.resolve() or PATHS.media_dir.resolve() not in folder.parents:
        raise ValueError(f"Refusing to clear media folder {folder}")
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _copy_seed_media(cfg: MockConfig) -> None:
    seed_dir = _clear_subdir(cfg.seed_media_subdir)
    _clear_subdir(cfg.upload_subdir)
    for src in sorted(cfg.media_seed_dir.glob("*")):
        if src.is_file():
            shutil.copy2(src, seed_dir / src.name)


def _ensure_seed_media(cfg: MockConfig) -> None:
    """Copy seed photos that are missing from PATHS.media_dir / seed (nothing is deleted)."""
    seed_dir = PATHS.media_dir / cfg.seed_media_subdir
    seed_dir.mkdir(parents=True, exist_ok=True)
    for src in sorted(cfg.media_seed_dir.glob("*")):
        if src.is_file() and not (seed_dir / src.name).exists():
            shutil.copy2(src, seed_dir / src.name)


def seed_fingerprint(cfg: MockConfig = MOCK) -> str:
    """cfg.seed_version plus a hash of seed.json and every file in cfg.media_seed_dir."""
    digest = hashlib.sha256(cfg.seed_file.read_bytes())
    for src in sorted(cfg.media_seed_dir.glob("*")):
        if src.is_file():
            digest.update(src.name.encode())
            digest.update(src.read_bytes())
    return f"{cfg.seed_version}:{digest.hexdigest()[:16]}"


def _check_photo(spec: dict, cfg: MockConfig) -> None:
    """The photo exists; image_size matches its JPEG/PNG header; every box lies inside the image."""
    path = cfg.media_seed_dir / spec["photo"]
    if not path.is_file():
        raise ValueError(f"Seed photo {path} not found")
    if "image_size" not in spec:
        if spec.get("detections"):
            raise ValueError(f"Seed photo {spec['photo']} has detections but no image_size")
        return
    width, height = spec["image_size"]
    actual = image_size(path.read_bytes())
    if actual is not None and actual != (width, height):
        raise ValueError(f"Seed photo {spec['photo']} is {actual[0]}x{actual[1]}, seed.json says {width}x{height}")
    for d in spec.get("detections", []):
        x1, y1, x2, y2 = d["box_xyxy"]
        if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height):
            raise ValueError(f"Seed box {d['box_xyxy']} is outside {spec['photo']} ({width}x{height})")


def _ago(now: datetime, minutes: float = 0.0, seconds: float = 0.0) -> datetime:
    return now - timedelta(minutes=minutes, seconds=seconds)


def _seed_report(db: Session, spec: dict, now: datetime, planner: FlightPlanner, cfg: MockConfig) -> tuple[int, int]:
    """One report with its detections, plan versions and mission. Returns (plans, missions) added."""
    _check_photo(spec, cfg)
    created = _ago(now, spec.get("created_min_ago", 0))
    report = Report(
        lat=spec["lat"],
        lon=spec["lon"],
        photo_path=f"{cfg.seed_media_subdir}/{spec['photo']}",
        status=ReportStatus(spec["status"]),
        review_note=spec.get("review_note"),
        created_at=created,
        updated_at=created,
    )
    db.add(report)
    db.flush()

    for d in spec.get("detections", []):
        db.add(
            Detection(
                report_id=report.id,
                source="server",
                deployment=f"server-{INFER.server_precision}",
                cls=d["cls"],
                confidence=d["confidence"],
                box_xyxy=[float(v) for v in d["box_xyxy"]],
                frame_id=d.get("frame_id", f"report-{report.id}"),
                model_version=d.get("model_version", cfg.model_version),
                flagged_wrong=d.get("flagged_wrong", False),
                flag_note=d.get("flag_note"),
                created_at=created,
            )
        )

    plans = missions = 0
    updated = created
    previous_reason = None
    for p in spec.get("plans", []):
        proposal = planner.propose(report.lat, report.lon, previous_reason=previous_reason)
        decided = _ago(now, p["decided_min_ago"]) if "decided_min_ago" in p else None
        plan = FlightPlan(
            report_id=report.id,
            drone_id=proposal.drone_id,
            altitude_m=proposal.altitude_m,
            survey_radius_m=proposal.survey_radius_m,
            route=proposal.route,
            status=PlanStatus(p["status"]),
            decision_reason=p.get("reason"),
            decided_at=decided,
            created_at=_ago(now, p.get("created_min_ago", 0)),
        )
        db.add(plan)
        db.flush()
        plans += 1
        updated = max(updated, decided or plan.created_at)
        previous_reason = p.get("reason") if plan.status == PlanStatus.changes_needed else None

        m = p.get("mission")
        if m is None:
            continue
        # started_s_ago is simulated seconds in flight, so it is converted with the time scale
        started = now - sim_delta(m["started_s_ago"]) if "started_s_ago" in m else None
        mission = Mission(flight_plan_id=plan.id, report_id=report.id, state=MissionState.pending, started_at=started)
        if started is not None:
            duration = flight_duration_s(plan.route, cfg)
            if m["started_s_ago"] < duration:
                mission.state = MissionState.takeoff  # in flight: advanced on read
                updated = max(updated, started)
            else:
                mission.state = MissionState.done
                mission.finished_at = started + sim_delta(duration)
                updated = max(updated, mission.finished_at)
        db.add(mission)
        db.flush()
        missions += 1
        for e in m.get("edge_detections", []):
            row = edge_detection_row(
                mission.id, {"deployment": cfg.edge_deployment, "model_version": cfg.model_version, **e}
            )
            row.created_at = mission.finished_at or now
            db.add(row)

    report.updated_at = updated
    return plans, missions


def reset_and_seed(db: Session, cfg: MockConfig = MOCK) -> SeedCounts:
    """Drop and recreate every table, copy the seed photos to PATHS.media_dir / seed (uploads are
    cleared), and load cfg.seed_file."""
    db.rollback()
    engine = db.get_bind()
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    _copy_seed_media(cfg)

    spec = json.loads(cfg.seed_file.read_text())
    now = now_utc()
    planner = FlightPlanner()
    plans = missions = 0
    for report_spec in spec.get("reports", []):
        p, m = _seed_report(db, report_spec, now, planner, cfg)
        plans += p
        missions += m
    db.add(AppMeta(key=_SEED_KEY, value=seed_fingerprint(cfg)))
    db.commit()
    return SeedCounts(reports=len(spec.get("reports", [])), flight_plans=plans, missions=missions, reset_at=now)


def _schema_is_current(db: Session) -> bool:
    """Every table and column of the models exists in the database (create_all never adds columns)."""
    insp = inspect(db.get_bind())
    for table in Base.metadata.sorted_tables:
        if not insp.has_table(table.name):
            return False
        existing = {c["name"] for c in insp.get_columns(table.name)}
        if not {c.name for c in table.columns} <= existing:
            return False
    return True


def seed_on_start(db: Session, cfg: MockConfig = MOCK) -> SeedCounts | None:
    """Startup seeding. cfg.reset_on_start: always reseed. Otherwise reseed only when the database has an old
    schema or no reports (cfg.seed_if_empty), or was seeded from another seed (cfg.reseed_on_seed_change);
    existing demo data and uploads are kept. Missing seed photos are copied back either way.
    Returns the counts when it seeded, else None."""
    if cfg.reset_on_start:
        return reset_and_seed(db, cfg)
    if cfg.seed_if_empty:
        if not _schema_is_current(db):
            log.warning("Mock database has an old schema: reseeding demo data")
            return reset_and_seed(db, cfg)
        if not db.scalar(select(func.count(Report.id))):
            log.warning("Mock database is empty: seeding demo data")
            return reset_and_seed(db, cfg)
    if cfg.reseed_on_seed_change:
        stored = db.get(AppMeta, _SEED_KEY)
        current = seed_fingerprint(cfg)
        if stored is None or stored.value != current:
            log.warning("Seed changed (%s -> %s): reseeding demo data", stored.value if stored else None, current)
            return reset_and_seed(db, cfg)
    _ensure_seed_media(cfg)
    return None
