"""Run seeded allocator and scale-out benchmarks without starting the API (docs/fleet-plan.md §7 Phase 4).

python -m run.scenarios [--seeds 42 43 44] [--burst-reports 10] [--drones 3 5 10]
"""

from __future__ import annotations

import argparse

from app.services.allocators import compare_allocators, format_comparison_table, run_scale_out
from config import SCENARIOS


def main() -> None:
    p = argparse.ArgumentParser(description="Compare baseline vs auction allocators on seeded report traces.")
    p.add_argument("--seeds", type=int, nargs="+", default=list(SCENARIOS.seeds))
    p.add_argument("--burst-reports", type=int, default=SCENARIOS.burst_reports)
    p.add_argument("--drones", type=int, nargs="+", default=list(SCENARIOS.scale_out_drones))
    args = p.parse_args()

    seeds = tuple(args.seeds)
    burst = compare_allocators(scenario="burst", seeds=seeds, n_reports=args.burst_reports)
    light = compare_allocators(
        scenario="light",
        seeds=seeds,
        n_reports=SCENARIOS.light_reports,
        interval_s=SCENARIOS.light_interval_s,
    )
    scale = run_scale_out(seeds=seeds, drone_counts=tuple(args.drones))

    print("## Allocator comparison (burst + light load)\n")
    print(format_comparison_table([*burst, *light]))
    print("\n## Scale-out comparison (auction)\n")
    print(format_comparison_table(scale))


if __name__ == "__main__":
    main()
