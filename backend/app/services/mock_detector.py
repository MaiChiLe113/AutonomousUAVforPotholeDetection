"""Fake server pre-check for the prototype (no real model). Same predict() shape as services.detector.Detector.

Deterministic from the file hash: the same photo always gives the same answer. About MOCK.no_damage_rate of
photos give no boxes; the rest give 1..MOCK.max_boxes boxes inside the image.
"""

from __future__ import annotations

import hashlib
import random
import struct
from pathlib import Path

from app.services.detector import DetectionResult
from config import DATA, INFER, MOCK, MockConfig

_JPEG_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def image_size(data: bytes) -> tuple[int, int] | None:
    """(width, height) from a PNG or JPEG header, or None if it cannot be read."""
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        width, height = struct.unpack(">II", data[16:24])
        return int(width), int(height)
    if data[:2] != b"\xff\xd8":
        return None
    i = 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            return None
        marker = data[i + 1]
        if marker == 0xFF:  # fill byte
            i += 1
            continue
        if marker in (0x01, *range(0xD0, 0xDA)):  # markers without a length
            i += 2
            continue
        (seg_len,) = struct.unpack(">H", data[i + 2 : i + 4])
        if marker in _JPEG_SOF and i + 9 <= len(data):
            height, width = struct.unpack(">HH", data[i + 5 : i + 9])
            return int(width), int(height)
        i += 2 + seg_len
    return None


class MockDetector:
    """Stands in for Detector while MOCK.enabled. deployment matches the real server model."""

    def __init__(self, cfg: MockConfig = MOCK) -> None:
        self.cfg = cfg
        self.model_version: str | None = cfg.model_version
        self.deployment = f"server-{INFER.server_precision}"

    def load(self) -> None:
        """Nothing to load."""

    def predict(self, image_path: Path, frame_id: str) -> list[DetectionResult]:
        data = Path(image_path).read_bytes()
        rng = random.Random(hashlib.sha256(data).digest())
        if rng.random() < self.cfg.no_damage_rate:
            return []

        width, height = image_size(data) or self.cfg.fallback_image_size
        results = []
        for _ in range(rng.randint(1, self.cfg.max_boxes)):
            bw = rng.uniform(*self.cfg.box_size_range) * width
            bh = rng.uniform(*self.cfg.box_size_range) * height
            x1 = rng.uniform(0, width - bw)
            y1 = rng.uniform(0, height - bh)
            results.append(
                DetectionResult(
                    cls=rng.choice(DATA.classes),
                    confidence=round(rng.uniform(*self.cfg.confidence_range), 2),
                    box_xyxy=[round(x1, 1), round(y1, 1), round(x1 + bw, 1), round(y1 + bh, 1)],
                    frame_id=frame_id,
                    model_version=self.cfg.model_version,
                )
            )
        return sorted(results, key=lambda r: r.confidence, reverse=True)
