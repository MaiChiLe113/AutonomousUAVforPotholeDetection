"""Networked Raspberry Pi 3 B+ edge worker and simulator HIL client (docs/fleet-plan.md §5, §7 Phase 6)."""

from __future__ import annotations

import base64
import hashlib
import logging
import tempfile
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI
from pydantic import BaseModel

from config import EDGE_WORKER, MOCK, UAV, EdgeWorkerConfig, MockConfig, UavConfig
from edge.benchmark import _build_runner
from sim.mock_flight import edge_results

log = logging.getLogger(__name__)


class InferRequest(BaseModel):
    frame_id: str
    image_b64: str
    pose: dict[str, float]
    image_size: tuple[int, int] = UAV.camera_resolution
    imgsz: int = 640


def _normalize_detections(
    raw: Any,
    *,
    frame_id: str,
    pose: dict[str, float],
    image_size: tuple[int, int],
    deployment: str,
    model_version: str,
) -> list[dict]:
    if not raw:
        return []
    out: list[dict] = []
    for item in raw:
        if isinstance(item, dict) and {"cls", "confidence", "box_xyxy"} <= set(item):
            out.append(
                {
                    "frame_id": item.get("frame_id", frame_id),
                    "cls": str(item["cls"]),
                    "confidence": float(item["confidence"]),
                    "box_xyxy": [float(v) for v in item["box_xyxy"]],
                    "model_version": str(item.get("model_version", model_version)),
                    "deployment": str(item.get("deployment", deployment)),
                    "pose": item.get("pose", pose),
                    "image_size": list(item.get("image_size", image_size)),
                }
            )
    return out


def create_worker_app(
    *,
    package_path: Path | None = None,
    infer_fn: Callable[[Path], Any] | None = None,
    deployment: str = EDGE_WORKER.pi_deployment,
    model_version: str = MOCK.model_version,
    imgsz: int = 640,
) -> FastAPI:
    """Create the lightweight HTTP edge worker app meant to run on the Raspberry Pi 3 B+."""
    app = FastAPI(title="Pi Edge Worker", version="0.1.0")
    runner = infer_fn

    def _get_runner() -> Callable[[Path], Any]:
        nonlocal runner
        if runner is None:
            if package_path is None:
                raise RuntimeError("No model package_path or infer_fn configured for edge worker")
            runner = _build_runner(package_path, "cpu", imgsz)
        return runner

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "deployment": deployment, "model_version": model_version}

    @app.post("/infer")
    def infer(body: InferRequest) -> dict[str, Any]:
        image_bytes = base64.b64decode(body.image_b64)
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            tmp.write(image_bytes)
            tmp_path = Path(tmp.name)
        try:
            fn = _get_runner()
            t0 = time.perf_counter()
            raw = fn(tmp_path)
            latency_ms = round((time.perf_counter() - t0) * 1000.0, 3)
        finally:
            tmp_path.unlink(missing_ok=True)

        detections = _normalize_detections(
            raw,
            frame_id=body.frame_id,
            pose=body.pose,
            image_size=body.image_size,
            deployment=deployment,
            model_version=model_version,
        )
        return {
            "frame_id": body.frame_id,
            "latency_ms": latency_ms,
            "deployment": deployment,
            "model_version": model_version,
            "detections": detections,
        }

    return app


class EdgeWorkerClient:
    """Ground-station HIL client: routes drone 1 to the Pi worker and drones 2-3 to sampled mock delays."""

    def __init__(
        self,
        cfg: EdgeWorkerConfig = EDGE_WORKER,
        mock_cfg: MockConfig = MOCK,
        uav_cfg: UavConfig = UAV,
    ) -> None:
        self.cfg = cfg
        self.mock_cfg = mock_cfg
        self.uav_cfg = uav_cfg
        self.measured_latency_ms: float = float(cfg.fallback_latency_ms)

    def survey_dwell_s(self) -> float:
        """Per-waypoint survey dwell in simulated seconds derived from measured Pi latency."""
        return round(self.measured_latency_ms / 1000.0, 3)

    def _sampled_mock_latency_ms(self, key: str) -> float:
        digest = hashlib.sha256(key.encode()).digest()
        unit = int.from_bytes(digest[:8], "big") / 2**64
        offset = (unit * 2.0 - 1.0) * self.cfg.latency_jitter_ms
        return round(max(1.0, self.measured_latency_ms + offset), 2)

    def infer_mission(
        self,
        drone_id: str,
        report_detections: list[dict],
        target: tuple[float, float],
        altitude_m: float | None = None,
        *,
        frame_path: Path | None = None,
        client: Any | None = None,
    ) -> tuple[list[dict], float]:
        """Run mission edge detection; drone 1 queries the Pi worker and falls back with a warning on failure."""
        alt = float(altitude_m if altitude_m is not None else self.uav_cfg.default_altitude_m)
        pose = {"lat": target[0], "lon": target[1], "altitude_m": alt, "heading_deg": 0.0}
        key = f"{drone_id}:{target[0]:.6f},{target[1]:.6f}"

        use_pi = drone_id == self.cfg.pi_drone_id and (bool(self.cfg.worker_url) or client is not None)
        if use_pi:
            img_bytes = frame_path.read_bytes() if frame_path and frame_path.is_file() else b"\xff\xd8\xff\xd9"
            payload = {
                "frame_id": f"hil-{hashlib.sha256(key.encode()).hexdigest()[:8]}",
                "image_b64": base64.b64encode(img_bytes).decode("ascii"),
                "pose": pose,
                "image_size": list(self.uav_cfg.camera_resolution),
            }
            try:
                if client is not None:
                    res = client.post("/infer", json=payload)
                else:
                    url = f"{self.cfg.worker_url.rstrip('/')}/infer"
                    res = httpx.post(url, json=payload, timeout=self.cfg.timeout_s)
                res.raise_for_status()
                data = res.json()
                self.measured_latency_ms = float(data["latency_ms"])
                return list(data.get("detections", [])), self.measured_latency_ms
            except Exception as exc:
                log.warning("Pi edge worker unreachable for %s (%s); falling back to mock edge", drone_id, exc)

        fallback_dets = edge_results(
            report_detections,
            target,
            altitude_m=alt,
            cfg=self.mock_cfg,
            uav=self.uav_cfg,
        )
        return fallback_dets, self._sampled_mock_latency_ms(key)
