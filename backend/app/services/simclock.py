"""Simulated-clock helpers: stored datetimes are wall-clock, every duration is simulated seconds.

`sim_elapsed_s` turns a wall-clock interval into simulated seconds and `sim_delta` turns simulated
seconds into the wall-clock timedelta to add to a stored datetime (`EnergyConfig.time_scale`).
With time_scale 1 both are the identity.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from config import ENERGY, EnergyConfig
from sim.energy import sim_seconds, wall_seconds


def sim_elapsed_s(start: datetime, end: datetime, cfg: EnergyConfig = ENERGY) -> float:
    """Simulated seconds between two wall-clock datetimes (negative when `end` is earlier)."""
    return sim_seconds((end - start).total_seconds(), cfg)


def sim_delta(sim_s: float, cfg: EnergyConfig = ENERGY) -> timedelta:
    """The wall-clock timedelta that covers `sim_s` simulated seconds."""
    return timedelta(seconds=wall_seconds(sim_s, cfg))
