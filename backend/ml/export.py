"""Edge export: FP32 -> ONNX -> TensorRT INT8 (Jetson) / NCNN (Pi) (§3.4). Owner: Hoan (SCRUM-35)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from config import EXPORT, ExportConfig


@dataclass
class ExportPackage:
    target: str  # "jetson" | "pi"
    path: Path
    model_version: str
    settings: dict  # export args + deployment/software settings


def _load_yolo(weights: Path) -> Any:
    try:
        from ultralytics import YOLO
    except ImportError as exc:
        raise RuntimeError(
            "ultralytics is required for model export; install with `pip install -e '.[ml]'`"
        ) from exc
    return YOLO(str(weights))


def _extract_map50_95(metrics: Any) -> float:
    if isinstance(metrics, (int, float)):
        return float(metrics)
    if isinstance(metrics, dict):
        for key in ("metrics/mAP50-95(B)", "map", "mAP50-95"):
            if key in metrics:
                return float(metrics[key])
    box = getattr(metrics, "box", None)
    if box is not None and getattr(box, "map", None) is not None:
        return float(box.map)
    results_dict = getattr(metrics, "results_dict", None)
    if isinstance(results_dict, dict) and "metrics/mAP50-95(B)" in results_dict:
        return float(results_dict["metrics/mAP50-95(B)"])
    raise ValueError(f"Could not read mAP50-95 from validation output: {metrics!r}")


class Exporter:
    def __init__(
        self,
        target: str,
        cfg: ExportConfig = EXPORT,
        *,
        model_loader: Callable[[Path], Any] | None = None,
    ) -> None:
        if target not in cfg.formats:
            raise ValueError(f"unknown export target {target!r}, expected one of {list(cfg.formats)}")
        self.target = target
        self.cfg = cfg
        self._model_loader = model_loader or _load_yolo

    def __call__(
        self,
        weights: Path,
        data_yaml: Path | None = None,
        model_version: str = "0.1",
    ) -> ExportPackage:
        """Export with `YOLO(weights).export(format=..., int8=..., data=data_yaml, imgsz=..., batch=1)`.

        The TensorRT engine must be built on the Jetson itself; NCNN packages for the Raspberry Pi
        can be exported on the PC and copied over. Only label the deployment `*-int8` when INT8
        quantisation is actually active for the target.
        """
        fmt = self.cfg.formats[self.target]
        int8_active = bool(self.cfg.int8 and (self.target == "jetson" or data_yaml is not None))
        kwargs: dict[str, Any] = {
            "format": fmt,
            "imgsz": self.cfg.imgsz,
            "batch": self.cfg.batch,
            "int8": int8_active,
        }
        if data_yaml is not None:
            kwargs["data"] = str(data_yaml)

        model = self._model_loader(weights)
        exported = model.export(**kwargs)
        out_path = Path(str(exported))
        deployment = f"{self.target}-int8" if int8_active else f"{self.target}-{fmt}"

        return ExportPackage(
            target=self.target,
            path=out_path,
            model_version=model_version,
            settings={
                "format": fmt,
                "imgsz": self.cfg.imgsz,
                "batch": self.cfg.batch,
                "int8": int8_active,
                "deployment": deployment,
                "data": str(data_yaml) if data_yaml is not None else None,
            },
        )

    def check_accuracy(self, package: ExportPackage, fp32_map: float, data_yaml: Path) -> bool:
        """Pass if exported mAP50-95 on the frozen test set is within `cfg.max_map_drop` of FP32."""
        model = self._model_loader(package.path)
        metrics = model.val(data=str(data_yaml), imgsz=self.cfg.imgsz, batch=self.cfg.batch)
        exported_map = _extract_map50_95(metrics)
        return (float(fp32_map) - exported_map) <= self.cfg.max_map_drop
