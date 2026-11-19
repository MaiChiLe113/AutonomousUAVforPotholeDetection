import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

# Tests use a throwaway database so they never touch data/app.db.
os.environ.setdefault("DATABASE_URL", f"sqlite:///{BACKEND / 'data' / 'test.db'}")
# Deterministic tests: real-time clock (the demo default is faster), calm weather, no background dispatch loop.
os.environ.setdefault("SIM_TIME_SCALE", "1")
os.environ.setdefault("SIM_WEATHER", "0")
os.environ.setdefault("AUTO_TICK", "0")
