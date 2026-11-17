# Fleet plan: drone, simulation and hardware (Hoan)

Draft 1, 2026-11-15. Scope: the drone, simulation and edge-hardware part of the project. Everything is
simulated; the only real hardware is one Raspberry Pi 3 Model B+ (no camera).

## 1. Decisions already made

| Topic | Decision |
|---|---|
| Multi-agent | Each drone is a bidding agent; a coordinator awards tasks to the best bid. No LLM agents. |
| Approval | The system plans and dispatches automatically. The UAV monitor can override (cancel, recall, reassign). |
| Service area | One district: 2 km radius around `UAV.home_lat/lon` (10.7769, 106.7009). 1 base, 3 drones. |
| Weather and wind | Out of scope. |
| Digital twin | Not ours. We publish confirmed detections (class, lat, lon, size, mission id); the twin owner reads them. |

## 2. Workflow

1. Resident submits a photo and a location.
2. Verification: AI pre-check, then the UAV monitor confirms the report is a legitimate pothole.
3. The confirmed report becomes an inspection task in a queue.
4. The dispatcher collects bids from the drones, awards the task, and creates a plan with an estimated
   flight time and battery use. The plan is approved by the system and the mission is dispatched.
5. The drone flies, surveys, and the edge device returns detections.
6. Report becomes `confirmed` or `not_confirmed`. Confirmed detections are available to the digital twin.
7. The drone returns to base, swaps its battery, and is available again.

The monitor can step in at 4 to 5: cancel a queued task, recall a flying drone, or force a re-plan.

## 3. What has to change in the current code

| Today | Problem | Change |
|---|---|---|
| `sim/mock_flight.py`: every flight lasts `MOCK.mission_duration_s` (45 s), split by phase shares | Time does not depend on distance, so no estimate is meaningful | Leg time = leg length / speed. Keep the pure "state at elapsed time" design (no background thread). |
| Battery is a ramp from 95% to 60% | Not tied to the flight, restarts every mission | Battery drains by phase rate x time, starts from the drone's stored level |
| `FlightPlanner.propose` always returns `drone_ids[0]` | No fleet | Planner takes a drone and returns route + estimate |
| Monitor approves each plan, then presses Launch | Not autonomous | Dispatcher approves and dispatches; monitor endpoints become overrides |
| Report : plan : mission is 1 : 1 : 1 | Blocks multi-stop flights and re-tasking | Left as is until Phase 5 |

## 4. Reference drone and battery model (recommendation)

Model the simulated drones on the **DJI Mavic 3 Enterprise**. Reasons: the telemetry dataset we were given
uses a DJI-style message format, and it is a common inspection drone with published endurance figures.

The figures below come from retailer and DJI listings found by search. Confirm them once on DJI's own
spec page before they go in the report.

| Spec (published, to confirm) | Value | Used for |
|---|---|---|
| Battery | 77 Wh, 5000 mAh, LiPo 4S | Device list |
| Max flight time, no wind | 45 min (at 32.4 km/h = 9 m/s, to 0%) | Cruise drain rate |
| Max hover time | 38 min | Hover drain rate |
| Max speed, normal mode | 15 m/s | Upper bound for `speed_mps` |

Battery model (time-proportional, per phase):

| Phase | Speed | Drain |
|---|---|---|
| Cruise (transit to target and back) | 9 m/s | 100 / 45 = 2.22 %/min |
| Hover, survey circle, climb, descent | survey 5 m/s, climb/descent 3 m/s (assumed) | 100 / 38 = 2.63 %/min |

- Multiply every estimate by a safety factor of 1.25 (the published figures are best-case: no wind, to 0%).
- Reserve: a task is feasible for a drone only if it can fly from where it will be, survey, and still
  get home with at least 25%.
- Chaining: a mission is "fly to target and survey". The return to base is a separate leg owned by the
  fleet state. When a survey ends, the drone takes the next feasible task from its current position;
  it flies home only when no task is feasible or the queue is empty.
- Battery swap: only at base, only when the drone lands below 60% (assumed), fixed 120 s, back to 100%.
  All three numbers are config values.
- Why this matters: with one base, drones that always return home are identical (same position, same
  battery), so there is nothing to bid on. Chaining and the swap rule make position and battery differ
  between drones, which is what the allocator has to reason about.
- Sanity check: a target at the 2 km edge is about 7.5 min of transit plus survey, roughly 25% with the
  safety factor. So a full battery covers about two to three edge-of-area missions before the reserve.
- All values go in a new `EnergyConfig` in `backend/config.py`.

Limits to state in the report: this is a spec-derived model, not measured. The telemetry dataset cannot
validate it: its drain is exactly constant (0.05 and 0.07 %/s), so it is simulator output. It is still useful as
a message-format sample for `/telemetry/ingest`.

## 5. Raspberry Pi 3 B+ role (recommendation)

**Hardware-in-the-loop edge device for one drone.** It is the only real measurement in the simulation.

- The Pi runs a small edge worker: it receives a frame over the LAN, runs the exported YOLO nano model
  (NCNN, CPU only), and returns detections plus its own timing.
- It has no camera, so frames are recorded aerial images sent by the simulator at each survey waypoint.
- Drone 1 uses the Pi. Drones 2 and 3 use the mock edge, with processing delay sampled from the Pi's
  measured latency. If the Pi is unreachable, drone 1 falls back to the mock (logged, not silent).
- The measured per-frame time sets how long a drone waits at each survey point, so Pi speed feeds
  directly into the time and battery estimate. That link is the point of having the hardware.
- Do it in two steps: offline benchmark first (required), networked edge worker second (stretch).

Setup notes: 64-bit Raspberry Pi OS Lite (1 GB RAM, no desktop), swap enabled for the install only.
Benchmark at 640 px and 320 px and pick from the numbers. No published Pi 3 B+ figure was found; Pi 5
results are about 70 to 95 ms per frame with NCNN, so expect several hundred ms. Measure, do not quote.
Check at execution time which quantisation the Ultralytics NCNN export supports and label the
deployment accordingly (`pi-int8` only if it really is INT8).

## 6. UAV device list (for the report)

| Item | Choice | Note |
|---|---|---|
| Airframe (reference) | DJI Mavic 3 Enterprise x 3 | Simulated; source of speed and endurance figures |
| Flight battery | 77 Wh intelligent battery, 2 per drone | Swap model in section 4 |
| Charging | Battery charging hub at the base | Supports the swap assumption |
| Camera | Wide camera of the reference airframe | Confirm FOV and resolution against `UAV.camera_fov_deg` (84) and `camera_resolution` on DJI's spec page |
| Edge computer | Raspberry Pi 3 Model B+ (1.4 GHz quad A53, 1 GB RAM) | Real, one unit, hardware in the loop |
| Ground station | PC running the API, simulator and dashboard | |
| Link | Wi-Fi / LAN between PC and Pi | |

Honest caveat for the report: a Mavic 3 Enterprise cannot carry a Pi as a payload. An airframe that can
is the Holybro X500 V2 (about 1 kg payload, about 18 min hover on a 4S 5000 mAh pack, companion-computer
mounts). Choose one story: either "edge computer at the ground station receiving the video link" (keeps the
Mavic figures) or "open airframe carrying the Pi" (use the X500 figures, shorter endurance). Recommended:
the first, because it matches the telemetry format and gives a workable range.

## 7. Phases

Each phase is its own branch and ends with `ruff check . && pytest` plus the listed check. Add unit tests
in `backend/tests` for the new pure functions (estimator, allocators).

### Phase 0: baseline and Pi spike
- Install backend (`pip install -e ".[dev]"`) and frontend (`npm install`); run both.
- Click through: report, confirm, plan, approve, launch, result.
- Pi spike (the biggest unknown, so do it first): flash the OS, export stock `yolov8n` to NCNN on the PC,
  copy it over, run one image on the Pi. Ultralytics pulls in PyTorch, which may not install or fit in
  1 GB; if it does not, use the bare `ncnn` Python runtime. Record which one works.
- Done when: the existing flow works on this machine, and one image has been run on the Pi.

### Phase 1: real timing and battery
- New `sim/energy.py`: `estimate(route, start_battery_pct) -> {duration_s, battery_used_pct, legs}`.
- `sim/mock_flight.py`: `_legs` and `flight_duration_s` use the same function; `telemetry_at` reads
  battery from it. Routes may start in the air (chained missions), not only on the ground at home.
- One simulated clock: `sim_seconds = wall_seconds x time_scale`, used by flights, swaps, the queue and
  the dispatcher. All estimates are in simulated seconds. A 10 min flight then plays in under a minute.
- `FlightPlanner.propose` takes a start position and battery and returns the estimate with the plan.
- Done when: estimate equals the simulated flight end time and battery at any `time_scale`; a farther
  target costs more.

### Phase 2: fleet state
- New `app/services/fleet.py`: per-drone base, status (`idle`, `flying`, `returning`, `swapping`,
  `offline`), position, battery level, available-at time. Status is derived on read, like missions.
- Each mission stores its own start position and start battery. The flight is recomputed on every
  read, so it cannot take these from the live drone record.
- `FleetConfig`: 3 drone ids, base position, service radius 2 km.
- Planner refuses targets outside the service area with a clear reason.
- Done when: two missions fly at once on different drones; a drone's second flight starts from the
  battery it landed with, or from 100% after the swap time.

### Phase 3: queue, dispatcher, auto-dispatch
- Confirmed report becomes a queued task. Reports within a new `report_merge_radius_m` (about 15 m,
  assumed) of an open task join it. Do not reuse `UAV.merge_radius_m` (2 m, meant for detections).
- New `app/services/dispatcher.py`: `dispatch_tick(db, now)` runs when a report is confirmed and inside
  `sync_active_missions`. It assigns queued tasks, creates the plan as approved by `system`, and
  dispatches the mission.
- Baseline allocator: oldest task first, nearest available drone that passes the battery check.
- All busy: task stays queued. It goes to the first drone that finishes its survey and can afford it
  from there (chaining, section 4), or to a drone at base after its swap.
- Overrides: cancel a queued task; recall a flying mission (drone returns, task goes back to the queue).
- Done when: section 8 scenarios marked Phase 3 pass.

### Phase 4: bidding allocator and comparison
- New `app/services/allocators.py`: common interface, two implementations.
- Auction: every drone bids on every open task. A bid is the estimated arrival time at the target,
  computed from where the drone will be when it is next free and its projected battery; no bid if the
  battery check fails. The lowest bid over all task-drone pairs wins; repeat until no task or no bid.
  Unlike the baseline it looks at the whole queue and at busy drones, not only the oldest task.
- New `run/scenarios.py`: seeded report arrivals over the service area, run without the API, fast clock.
  Metrics: mean and worst wait from confirmation to arrival, battery used, tasks served, tasks left.
- Done when: a results table compares both allocators on the same seeds. Report whatever it shows; the
  auction is expected to help most in bursts, and may tie on light load.

### Phase 5: scale up
- A plan can hold several reports (needs a plan-to-reports link).
- A drone can be re-tasked in the middle of a leg, including while returning to base.
- Bids become "extra cost of inserting this task into my current route".
- Done when: nearby reports are served in one flight; a new report is inserted into a flying or
  returning drone's route when battery allows.

### Phase 6: Pi 3 B+
- `ml/export.py` (Pi target) and `edge/benchmark.py`: median and p95 latency, memory, temperature,
  stability run. Needs trained weights from Hai; use stock `yolov8n` weights until then.
- `edge/worker.py`: the networked edge worker from section 5. Guard Pi-only imports.
- Done when: benchmark table from the real Pi; one simulated mission gets its detections from the Pi.

Order: 0, 1, 2, 3 are the core. 4 gives the AI comparison. 6 can run in parallel from Phase 1 on.
5 is last and optional.

## 8. Scenarios

| # | Scenario | Expected behaviour | Phase |
|---|---|---|---|
| S1 | One report, all drones idle | Best bid flies; others stay | 3 |
| S2 | Report arrives while all 3 drones are flying | Queued; taken by the first drone that ends its survey and can afford it, without going home first | 3 |
| S3 | Same, a drone is mid-leg or returning nearby | Stop inserted into its route | 5 |
| S4 | A drone on its second or third chained task lacks battery for the next one + reserve | It makes no bid and flies home to swap; another drone takes the task or it waits | 3 |
| S5 | Two reports within the report merge radius | One task, one flight | 3 |
| S6 | Burst of 10 reports | All served; mean and worst wait reported for both allocators | 4 |
| S7 | Monitor recalls a flying drone | Drone returns; task requeued and reassigned | 3 |
| S8 | Edge processing fails or times out | Mission `failed`; task requeued once, then flagged for the monitor | 3 |
| S9 | Target outside the service area | Refused with a reason; no plan | 2 |
| S10 | Drone goes offline | Excluded from bidding; its task requeued | 3 |

## 9. Scale out and scale up

- Scale out: more drones, bases and districts by config. Each district has its own base, queue and
  dispatcher, so districts do not affect each other. `run/scenarios.py` shows how wait time changes with
  3, 5 and 10 drones.
- Scale up: more per drone and per plan (Phase 5), and a better allocator (Phase 4).
- Not planned: message queues, microservices, a background simulator process. State-on-read is enough at
  this size. Say so in the report as a known limit.

## 10. Requests to teammates

These files are Chi's (`app/models.py`, `app/schemas.py`, `frontend/lib/types.ts`) or frontend:

| Phase | Request |
|---|---|
| 1 | `FlightPlanOut`: `estimated_duration_s` from the estimator, new `estimated_battery_pct` (**done on `fleet-phase-1`**; `app/routers/common.py` `sim_seconds` wiring still pending teammate approval) |
| 2 | New `Drone` table and `GET /drones`; `start_lat`, `start_lon`, `start_battery_pct` on missions (Hoan's `fleet.py` stores mission starts in `AppMeta` until teammate schema/endpoint changes are approved) |
| 3 | Queue status on reports (for example `queued`); `decided_by` on flight plans; mission state for a recall; override endpoints (Hoan's `dispatcher.py` stores queue/task/override state in `AppMeta` and exposes `/reports/{id}/enqueue`, `/reports/{id}/cancel`, `/missions/{id}/recall`, `/dispatcher/tick` on Hoan's routers until schema/common changes are approved) |
| 3 | A call to `dispatch_tick` inside `sync_active_missions` (`app/routers/common.py`) and where a report is confirmed (currently wired inside `missions.py`; `common.py` and `reports.py` hooks still pending approval) |
| 3 | Missions now end after the survey; the return to base shows as drone status `returning`, not as mission state `landing` |
| 3 | Dashboard: all drones on one map, queue list, override buttons |
| 5 | Plan-to-reports link (many reports per plan) (Hoan's `dispatcher.py` stores `dispatcher:plan_reports:{plan_id}` in `AppMeta` until schema link is added) |
| 6 | Hai: trained weights for export; `edge/runner.py` is his and overlaps with the edge worker (`edge/worker.py`, `ml/export.py`, and `edge/benchmark.py` PC-side ready on `fleet-phase-6`; physical Pi 3 B+ run & trained weights pending) |

No Jira keys exist for the fleet work; create them before branching.

## 11. Sources

- DJI Mavic 3 Enterprise specs: https://www.dji.com/ae/support/product/mavic-3-enterprise ,
  https://www.cliftoncameras.co.uk/uploads/specifications/DJI%20Mavic%203%20Enterprise%20Specifications.pdf
- Holybro X500 V2: https://holybro.com/products/px4-development-kit-x500-v2 ,
  https://docs.holybro.com/drone-development-kit/px4-development-kit-x500v2
- Ultralytics on Raspberry Pi (NCNN): https://docs.ultralytics.com/guides/raspberry-pi
