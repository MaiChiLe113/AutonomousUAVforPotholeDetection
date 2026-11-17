"""Edge benchmark and deployment checks (§3.4 Table 3.8, docs/fleet-plan.md §7 Phase 6). Owner: Hoan."""

from __future__ import annotations

import math
import statistics
import time
import tracemalloc
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from config import EXPORT, ExportConfig

_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png"}


@dataclass
class BenchmarkResult:
    device: str
    median_latency_ms: float
    p95_latency_ms: float
    throughput_fps: float
    peak_memory_mb: float
    max_temperature_c: float | None
    crashes: int


def _collect_frames(frames_dir: Path) -> list[Path]:
    frames = sorted(
        p for p in Path(frames_dir).iterdir() if p.is_file() and p.suffix.lower() in _IMAGE_SUFFIXES
    )
    if not frames:
        raise ValueError(f"No image frames found in {frames_dir}")
    return frames


def _read_memory_mb() -> float:
    status_path = Path("/proc/self/status")
    if status_path.is_file():
        for line in status_path.read_text(errors="ignore").splitlines():
            if line.startswith(("VmHWM:", "VmRSS:")):
                parts = line.split()
                if len(parts) >= 2 and parts[1].isdigit():
                    return round(int(parts[1]) / 1024.0, 2)
    if tracemalloc.is_tracing():
        _, peak_bytes = tracemalloc.get_traced_memory()
        return round(peak_bytes / (1024.0 * 1024.0), 2)
    return 0.0


def _read_cpu_temp_c() -> float | None:
    thermal_path = Path("/sys/class/thermal/thermal_zone0/temp")
    if thermal_path.is_file():
        try:
            return round(float(thermal_path.read_text().strip()) / 1000.0, 1)
        except ValueError:
            return None
    return None


def _build_runner(package_path: Path, device: str, imgsz: int) -> Callable[[Path], Any]:
    """Build an inference callable, preferring Ultralytics and falling back to bare `ncnn` on Pi."""
    try:
        from ultralytics import YOLO

        model = YOLO(str(package_path))
        return lambda frame: model.predict(str(frame), imgsz=imgsz, device=device, verbose=False)
    except ImportError:
        pass

    try:
        import ncnn  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "Neither ultralytics nor ncnn Python runtime is installed; install '.[ml]' or 'ncnn'."
        ) from exc

    params = sorted(package_path.glob("*.param")) if package_path.is_dir() else [package_path.with_suffix(".param")]
    bins = sorted(package_path.glob("*.bin")) if package_path.is_dir() else [package_path.with_suffix(".bin")]
    if not params or not bins or not params[0].is_file() or not bins[0].is_file():
        raise FileNotFoundError(f"Expected .param and .bin NCNN files in {package_path}")

    net = ncnn.Net()
    net.opt.use_vulkan_compute = False
    net.load_param(str(params[0]))
    net.load_model(str(bins[0]))

    def _run_ncnn(frame: Path) -> list[dict]:
        raw = frame.read_bytes()
        mat = ncnn.Mat.from_pixels_resize(
            raw,
            ncnn.Mat.PixelType.PIXEL_RGB,
            imgsz,
            imgsz,
            imgsz,
            imgsz,
        )
        ex = net.create_extractor()
        ex.input("in0", mat)
        _, out = ex.extract("out0")
        return [{"shape": tuple(out.shape)}] if hasattr(out, "shape") else []

    return _run_ncnn


def benchmark(
    package_path: Path,
    frames_dir: Path,
    device: str = "cpu",
    cfg: ExportConfig = EXPORT,
    *,
    infer_fn: Callable[[Path], Any] | None = None,
) -> BenchmarkResult:
    """Warm up `cfg.warmup_runs`, then time `cfg.benchmark_runs` over the recorded frames."""
    frames = _collect_frames(frames_dir)
    runner = infer_fn or _build_runner(package_path, device, cfg.imgsz)

    started_trace = not tracemalloc.is_tracing()
    if started_trace:
        tracemalloc.start()
    try:
        for i in range(max(0, cfg.warmup_runs)):
            runner(frames[i % len(frames)])

        latencies_ms: list[float] = []
        crashes = 0
        max_temp = _read_cpu_temp_c()
        peak_mem = _read_memory_mb()

        for i in range(max(1, cfg.benchmark_runs)):
            frame = frames[i % len(frames)]
            t0 = time.perf_counter()
            try:
                runner(frame)
            except Exception:
                crashes += 1
            else:
                latencies_ms.append((time.perf_counter() - t0) * 1000.0)
            peak_mem = max(peak_mem, _read_memory_mb())
            temp = _read_cpu_temp_c()
            if temp is not None:
                max_temp = temp if max_temp is None else max(max_temp, temp)
    finally:
        if started_trace:
            tracemalloc.stop()

    if latencies_ms:
        ordered = sorted(latencies_ms)
        median_ms = round(statistics.median(ordered), 3)
        p95_idx = min(len(ordered) - 1, max(0, math.ceil(0.95 * len(ordered)) - 1))
        p95_ms = round(ordered[p95_idx], 3)
        fps = round(1000.0 / median_ms, 2) if median_ms > 0 else 0.0
    else:
        median_ms = p95_ms = fps = 0.0

    return BenchmarkResult(
        device=device,
        median_latency_ms=median_ms,
        p95_latency_ms=p95_ms,
        throughput_fps=fps,
        peak_memory_mb=round(peak_mem, 2),
        max_temperature_c=max_temp,
        crashes=crashes,
    )


def stability_test(
    package_path: Path,
    frames_dir: Path,
    cfg: ExportConfig = EXPORT,
    *,
    infer_fn: Callable[[Path], Any] | None = None,
    duration_s: float | None = None,
) -> bool:
    """Run continuous detection for `cfg.stability_minutes` (or `duration_s`); pass if no crash."""
    frames = _collect_frames(frames_dir)
    runner = infer_fn or _build_runner(package_path, "cpu", cfg.imgsz)
    span_s = float(cfg.stability_minutes * 60.0 if duration_s is None else duration_s)
    deadline = time.monotonic() + max(0.0, span_s)
    idx = 0

    while True:
        try:
            runner(frames[idx % len(frames)])
        except Exception:
            return False
        idx += 1
        if time.monotonic() >= deadline:
            break
    return True


def format_benchmark_table(results: list[BenchmarkResult]) -> str:
    """Format edge benchmark measurements as a markdown table."""
    header = (
        "| Device | Median (ms) | p95 (ms) | Throughput (FPS) | Peak memory (MB) | Max temp (°C) | Crashes |\n"
        "|---|---:|---:|---:|---:|---:|---:|"
    )
    rows = [
        f"| {r.device} | {r.median_latency_ms:.2f} | {r.p95_latency_ms:.2f} | {r.throughput_fps:.2f} "
        f"| {r.peak_memory_mb:.2f} | {'N/A' if r.max_temperature_c is None else f'{r.max_temperature_c:.1f}'} "
        f"| {r.crashes} |"
        for r in results
    ]
    return "\n".join([header, *rows])
