# Prototype plan: requirements, use cases, mock API + clean map UI (agent team)

## Context
The Task 1 report (COS40007 Team Docs PDF) defines the system: a resident pins a pothole and sends a
photo, an AI pre-check runs, the UAV monitor reviews the report, approves a flight plan, the UAV flies and
confirms the damage, and the dashboard shows the result. The repo is still a skeleton (every endpoint
returns 501, every page is a `Todo` box).

For now the user wants **only a working prototype** of the two main use cases (resident and UAV monitor),
plus a written **requirements and use case analysis**. Constraints from the user:
- No tests (do not write tests; do not run pytest). Compile checks only: `ruff check .`, `npm run lint && npm run build`.
- **Mock FastAPI backend**: real endpoints, structured mock/seed data, **no real model** (fake detector, simulated flight).
- Frontend: clean like Google Maps (full-screen map, floating panel), **light theme only**, no dark mode.
- Easy login (pick a role + name, no password), quick role switch, **no** settings/profile/extra menus.
- Focus on functionality and the use cases.

The team runs from the user's **main folder** `/Users/quang/code/SmartCityUAVforPotholeDetection copy`
(it has `frontend/node_modules` and `backend/.venv`; agent teams are already enabled there). No git.

## Step 0 (already done, do not redo)
These files already exist in the main folder:
- `docs/prototype-plan.md`: this plan.
- `.claude/agents/analyst.md`: new role (tools Read, Grep, Glob, Write, Edit; only writes `docs/`).
- `docs/team-kickoff.md`: the prompt the user pastes into `claude` (section "Kickoff prompt" below).
- `.claude/launch.json`: add a `backend` entry (`backend/.venv/bin/python -m run.serve --reload`, port 8000).

## Shared API contract (fixed up front so teammates work in parallel)
Keep every existing endpoint and schema in `backend/app/schemas.py` / `frontend/lib/types.ts`. Additions only:
- `MissionOut.report_id: int` (and `Mission.report_id` in types.ts).
- `GET /reports/{report_id}/flight-plans` → `list[FlightPlanOut]`, newest first (decision history).
- `GET /missions/{mission_id}` → `MissionOut`.
- `GET /missions/{mission_id}/detections` → `list[DetectionOut]` (edge results).
- `POST /dev/reset` → reseed the demo data (used by a small "Reset demo" link on the login screen).

Status flow (from the activity diagram): `submitted → no_damage` (closed) or `under_review`;
`under_review → rejected` or (confirm) plan `proposed`; plan `approved | changes_needed (new plan proposed) | rejected`;
approve creates mission `pending`; dispatch → report `uav_dispatched`, mission `takeoff → surveying → landing → done`;
done → report `confirmed | not_confirmed`.

## Drone telemetry and live camera (added from the drone telemetry sample)
The real drone app sends one JSON message like this (sample from the user):
```json
{"droneID": "drone1", "aircraftLongitude": -4.526, "aircraftLatitude": 55.788, "aircraftAltitude": 1.0,
 "distanceToHome": 0, "homeAltitude": 0, "homeLatitude": 4.58, "homeLongitude": 4.58,
 "gimbal_PITCH": 7.6, "gimbal_YAW": -71.9, "gimbal_ROLL": 0.0, "headingDroneDegress": -92.0,
 "isInMission": false, "missionPlan": null, "currentWaypointMissionPlanner": null, "batteryPercentage": 44.98}
```
Keep this wire format at the edge of the system only. Inside, use clean snake_case names.

| Drone field | Internal field (`TelemetryIn/Out`, `Telemetry` in types.ts) | Shown on dashboard as |
|---|---|---|
| `droneID` | `drone_id: str` | Drone name in panel header |
| `aircraftLatitude/Longitude` | `lat`, `lon` (existing) | UAV marker + flown trail |
| `aircraftAltitude` | `altitude_m` (existing) | Altitude (m) |
| `headingDroneDegress` | `heading_deg` (existing), normalised to 0–360 | Marker rotation + compass |
| `homeLatitude/Longitude/Altitude` | `home_lat`, `home_lon`, `home_alt_m` | Home marker (H), dashed return line |
| `distanceToHome` | `distance_to_home_m` | Distance to home |
| `gimbal_PITCH/YAW/ROLL` | `gimbal_pitch_deg`, `gimbal_yaw_deg`, `gimbal_roll_deg` | Camera footprint cone on map + gimbal readout |
| `batteryPercentage` | `battery_pct` | Battery bar: green ≥ 40, amber < 40, red < 20 with "Return home" warning |
| `isInMission` | `in_mission: bool` | "In mission" / "Idle" chip |
| `currentWaypointMissionPlanner` | `current_waypoint: int \| None` | "Waypoint 3 / 12", next waypoint highlighted on route |
| `missionPlan` | ignored for now (route comes from our flight plan) | — |
| (computed) | `distance_to_target_m`, `progress_pct` | Distance to target, progress bar |
| (computed in UI) | age of `ts` | "Last update 1 s ago"; > 3 s shows "Signal lost" |

Contract additions for this:
- New optional fields above on `TelemetryIn` / `TelemetryOut` and the `UavTelemetry` table (all nullable).
- `POST /telemetry/ingest` accepts the raw drone JSON above (Pydantic aliases), finds the drone's active
  mission by `droneID`, and stores it as telemetry. Lets the real drone app plug in later without code changes.
- Live camera request (mocked; no real video yet). Mission-level object
  `CameraSession { mission_id, status: "idle" | "requested" | "live" | "denied" | "ended", stream_url: str | None,
  requested_at, started_at, ended_at }`:
  - `POST /missions/{id}/camera/request` → `requested`; only while the mission is `takeoff|surveying|landing`.
  - `GET /missions/{id}/camera` → current session. Mock rule: `requested` becomes `live` 2 s later
    (computed on read); when the mission is `done` it becomes `ended`.
  - `POST /missions/{id}/camera/stop` → `ended`.
  - `stream_url` is `null` in the mock (the UI shows a simulated feed); later it holds an HLS/WebRTC URL.
- Mock flight fills every field: battery drains from ~95% to ~60% over the flight, gimbal pitch −90° while
  surveying and −30° in transit, gimbal yaw follows heading, `current_waypoint` follows the route index,
  `distance_to_home_m` / `distance_to_target_m` from haversine, `in_mission` true until `done`.
- Data check on the sample: its home (4.58, 4.58) is about 5,700 km from the aircraft while
  `distanceToHome` is 0, so the sample is test data. The ingest endpoint must not trust `distanceToHome`
  alone: recompute it from the coordinates when home is set.

## Team, ownership and phases
Each teammate edits only its own files (no overlap). Lead = the user's `claude` session.

**Phase 1 (4 teammates in parallel)**

| Name | Agent type | Owns | Deliverable |
|---|---|---|---|
| `analyst` | analyst | `docs/requirements.md`, `docs/use-cases.md` | See "Documents" below |
| `api` | backend-api | `backend/app/routers/*` (incl. new `telemetry.py`), `app/models.py` (telemetry columns + `CameraSession` table), `app/schemas.py`, `app/main.py`, `app/db.py`, new `app/mock_seed.py`, new `app/services/mock_detector.py`, new `backend/mock/` (seed.json + SVG photos), MOCK section of `config.py` | All endpoints working on SQLite with seed data |
| `sim` | uav-sim | `app/services/flight_planner.py`, new `sim/mock_flight.py` | Plan geometry + time-based flight + fake edge results (pure functions) |
| `ui-core` | frontend | `app/layout.tsx`, `app/globals.css`, `app/page.tsx`, `lib/*`, new `lib/session.ts`, `components/MapView.tsx`, `components/StatusBadge.tsx`, new `components/ui/*`, new `components/AppShell.tsx`, new `components/RoleGate.tsx` | Shell, login, design primitives, map, updated api.ts/types.ts |

**Phase 2 (after `ui-core` and `api` finish; 2 frontend teammates in parallel)**

| Name | Agent type | Owns |
|---|---|---|
| `resident` | frontend | `app/report/**`, `components/PhotoUpload.tsx`, `components/DraggablePin.tsx`, new `components/resident/*` |
| `monitor` | frontend | `app/monitor/**`, `components/DetectionOverlay.tsx`, `components/FlightPlanRoute.tsx`, new `components/monitor/*` |

`api` stays up in Phase 2 to fix contract issues; shut down `analyst`, `sim`, `ui-core`.

**Phase 3**: `rev` (reviewer) walks every use case in `docs/use-cases.md` against the code, runs
`ruff check .` and `npm run lint && npm run build`, and reports gaps; lead sends fixes to the owner.
Lead deletes `components/Todo.tsx` once nothing imports it.

## Phase 1 details

### analyst: documents
- `docs/requirements.md`: scope (in: two use cases, mock API; out: real model, training, edge hardware,
  3D twin, MLOps, auth), functional requirements `FR-xx` each mapped to a Jira key (SCRUM-23, 24, 27, 29, 30,
  31, 33, 37, 39, 45) and acceptance criteria from the PDF user-story table, non-functional (light UI, works on
  phone width, status updates without reload, response feel), assumptions and constraints.
- `docs/use-cases.md`: actors (Resident, UAV Monitor, System/AI pre-check, Simulated UAV), use case list,
  a Mermaid flowchart of actors → use cases, and for each use case: goal, precondition, main flow,
  alternative flows, postcondition, screen + endpoints used. Use cases:
  - UC-01 Sign in and switch role
  - UC-R1 Report a pothole (pin + photo + submit + see pre-check result)
  - UC-R2 Track my reports (status timeline, auto-refresh)
  - UC-M1 Browse the report queue on the map
  - UC-M2 Review a report (boxes, flag wrong detection, confirm / reject with reason)
  - UC-M3 Review a flight plan (approve / request changes / reject with reason, decision history)
  - UC-M4 Dispatch and track the UAV live (position, route to target, battery, gimbal, waypoint, signal),
    see confirmed / not confirmed result
  - UC-M5 Request the UAV's live camera during a mission (request → live → stop; denied when not flying)
- Add a "Telemetry data" section to `docs/requirements.md` with the drone field mapping table from
  "Drone telemetry and live camera" above, and the low-battery / signal-lost rules.

### api: mock backend
- `config.py`: add `MockConfig` (`enabled=True`, `reset_on_start=True`, `seed_file=ROOT/"mock"/"seed.json"`,
  `media_seed_dir=ROOT/"mock"/"media"`, `mission_duration_s=45`, `model_version="mock-0.1"`) and `MOCK = MockConfig()`.
- `app/mock_seed.py`: `reset_and_seed(db)` drops/creates tables, loads `seed.json`, copies seed SVG photos into
  `PATHS.media_dir/seed/`. Called from `lifespan` in `main.py` when `MOCK.reset_on_start`, and by `POST /dev/reset`.
- `backend/mock/seed.json`: ~8 reports around `UAV.home_lat/lon` (10.7769, 106.7009) covering every status
  (2 under_review, 1 no_damage, 1 rejected, 1 with a proposed plan, 1 in flight, 1 confirmed, 1 not_confirmed),
  with server detections (D00/D10/D20/D40), plans and missions. `backend/mock/media/*.svg`: simple road photos.
- `app/services/mock_detector.py`: `MockDetector` with the same `predict()` shape as `Detector`; deterministic
  from the file hash: ~25% no damage, else 1–3 boxes, `deployment="server-fp32"`, `model_version=MOCK.model_version`.
- Routers: implement every endpoint in `reports.py`, `detections.py`, `flight_plans.py`, `missions.py`, plus the
  contract additions. Uploads validated with `config.API.allowed_types` / `max_upload_mb`, saved to `media_dir`.
  Telemetry and mission state are computed on read from `sim.mock_flight` (no background thread): when elapsed
  ≥ duration, set mission `done`, store edge detections, set report `confirmed`/`not_confirmed`.
  `monitoring.metrics` returns simple counts from the DB.
- Telemetry: add the new nullable columns, `routers/telemetry.py` with `POST /telemetry/ingest` (aliases for the
  raw drone JSON, heading normalised to 0–360, distance to home recomputed), and the three camera endpoints in
  `missions.py` backed by a `CameraSession` table. `latest_telemetry` returns every new field.
- Delete the obsolete `test_unbuilt_endpoint_returns_501` in `tests/test_api.py` (no new tests).

### sim: plan geometry + flight
- `FlightPlanner.propose()`: takeoff at home → fly to target at `default_altitude_m` → 8-point survey circle of
  `survey_radius_m` → return → land. If `previous_reason` is set, vary altitude/radius slightly so a new version differs.
- `sim/mock_flight.py` (pure, used by `api`):
  - `flight_duration_s(route, cfg) -> float` (from `MOCK.mission_duration_s`)
  - `telemetry_at(route, elapsed_s, drone_id, home) -> dict`: interpolates along the route; state `takeoff`
    (first 10%), `surveying` (on survey waypoints), `landing` (last 10%), `done` after. Returns every internal
    telemetry field from the mapping table: lat, lon, altitude_m, heading_deg, state, drone_id, home_lat/lon/alt_m,
    distance_to_home_m, distance_to_target_m, gimbal pitch/yaw/roll, battery_pct, in_mission, current_waypoint,
    progress_pct (rules in "Drone telemetry and live camera").
  - `haversine_m(a, b)` helper shared with the ingest endpoint.
  - `edge_results(report_detections, target) -> list[dict]`: fake `jetson-int8` detections near the target;
    deterministic ~80% confirm.

### ui-core: shell, login, map, primitives
- Light only: `globals.css` sets `color-scheme: light`, white surfaces, slate text, one blue accent, no
  `prefers-color-scheme` rules. System font. Soft shadows and 12px radius on floating cards (Google Maps feel).
- `lib/session.ts`: `{ role: "resident" | "monitor", name }` in localStorage; `useSession()`, `signIn()`, `switchRole()`, `signOut()`.
- `app/page.tsx` = login: name field + two large role cards (Resident / UAV Monitor) + "Reset demo" link → `/dev/reset`.
- `AppShell` (in `layout.tsx`): slim top bar only: app name, Resident|Monitor segmented switch, Sign out. Nothing else.
- `RoleGate`: redirects to `/` when no session, or to the other home when the role does not match.
- `MapView`: full-bleed map; CARTO Voyager light tiles (`MAP.tileUrl` in `config.ts`, attribution
  "© OpenStreetMap contributors © CARTO"); custom `divIcon` dot markers coloured by status (no CDN images);
  props for markers, route, circle, UAV marker with heading, `onMapClick`, `flyTo`. Also: `trail` (solid line of
  flown positions), `plannedRoute` (dashed), `highlightWaypoint` index, `home` marker (H), and `cameraFootprint`
  (a small translucent cone from the UAV in the gimbal yaw direction).
- `components/ui/`: `FloatingPanel` (left card ≥768px, bottom sheet on phones), `Button`, `Chip`,
  `StatusTimeline`, `EmptyState`, `ReasonDialog` (required reason textbox).
- `lib/api.ts` + `lib/types.ts`: add the contract additions; add `resetDemo()`. `lib/config.ts`: tiles, status
  colours, `SIM` poll values. Keep existing function signatures.

## Phase 2 details (UX per use case)
**resident** (`/report`, `/report/[id]`), wrapped in `RoleGate role="resident"`:
- Map opens at browser geolocation (fallback `MAP.defaultCenter`); draggable pin, tap map to move it.
- Floating panel: "Pin the pothole" → photo picker with preview, JPEG/PNG and size check → "Send report".
- After submit: pre-check result card ("Pothole found 87% – sent to the UAV monitor" or "No damage found –
  report closed") + "Track this report". Report id saved in localStorage "my reports".
- Panel tab "My reports" lists them with status chips. `/report/[id]`: map on the pin + `StatusTimeline`
  (Submitted → AI check → Under review → UAV dispatched → Confirmed / Not confirmed), polls every 5 s.

**monitor** (`/monitor`, `/monitor/reports/[id]`, `/monitor/flight-plans/[id]`, `/monitor/dashboard`), `RoleGate role="monitor"`:
- `/monitor`: all report pins on the map coloured by status; panel with filter chips
  (Needs review / Flight plans / In flight / Done) and a list; selecting flies the map to the pin.
- `/monitor/reports/[id]`: photo with boxes (`DetectionOverlay`, scale `box_xyxy` by image natural size),
  rows with class name, confidence, model version, frame id, "Wrong detection" flag; actions
  "Confirm & propose flight plan" (→ plan page) and "Reject" (reason required).
- `/monitor/flight-plans/[id]`: route polyline, takeoff/landing icons, survey circle, target pin; panel with
  drone, altitude, radius, distance, estimated time; Approve / Request changes / Reject (reason required);
  decision history from `GET /reports/{id}/flight-plans`. After approve: "Launch UAV" → dispatch → dashboard.
- `/monitor/dashboard?mission=ID` (poll telemetry every 1 s, camera every 2 s while requested/live):
  - **Map**: UAV marker rotated by heading, flown trail, planned route dashed with the next waypoint
    highlighted, target pothole pin + survey circle, home marker, camera footprint cone. "Follow UAV" toggle
    (map keeps the UAV centred) and "Fit route" button, both floating on the map like Google Maps controls.
  - **Panel, top**: drone id, `in_mission` chip, mission stepper (takeoff / surveying / landing / done),
    progress bar, "Waypoint n / total", last-update age ("Signal lost" when > 3 s).
  - **Panel, flight data** (2-column grid): altitude, distance to target, distance to home, heading compass,
    battery bar (green / amber < 40 / red < 20 + "Return home" warning banner), gimbal pitch / yaw / roll.
  - **Panel, live camera card**: "Request live camera" button (disabled unless flying) → "Waiting for
    drone…" → simulated feed (seed road photo with a HUD: crosshair, altitude, gimbal pitch, time, "SIMULATED"
    label) + "Stop camera". Shows "Camera ended" when the mission finishes. If `stream_url` is set later,
    play it in a `<video>` instead.
  - **Done**: result badge (Confirmed / Not confirmed) + edge detections list; camera card hidden.
  - Without `?mission`: list active missions with drone id, state and battery; click to open.

## Kickoff prompt (goes in docs/team-kickoff.md)
```text
Read docs/prototype-plan.md and run it as an agent team. You are the lead: do not write code yourself.
Rules: no tests (skip pytest; only ruff check . and npm run lint && npm run build as compile checks),
light theme only, no settings/profile menus, each teammate edits only the files the plan gives it.
Phase 1: spawn analyst (analyst type), api (backend-api), sim (uav-sim), ui-core (frontend) with their plan sections.
Phase 2, when ui-core and api are done: spawn resident and monitor (frontend); keep api for contract fixes;
shut down the others. Phase 3: spawn rev (reviewer) to check every use case in docs/use-cases.md and the
compile checks; send fixes to the owners. Wait for teammates; report to me at the end of each phase.
```

## Verification (lead or Claude after Phase 3)
1. `cd backend && .venv/bin/pip install -e ".[dev]" && .venv/bin/ruff check .` ; `cd frontend && npm run lint && npm run build`.
2. Start both (`preview_start` "backend" and "frontend", or `python -m run.serve --reload` + `npm run dev`);
   open http://localhost:8000/docs: all endpoints answer (no 501).
3. Click-through in the browser at 1280px and 375px width:
   - Sign in as Resident → pin + photo → send → see pre-check result → My reports shows it.
   - Switch to Monitor → report in "Needs review" → flag a box → Confirm → plan page → Request changes
     (reason) → new plan → Approve → Launch UAV → UAV moves on dashboard → result Confirmed / Not confirmed.
   - Switch back to Resident → the report timeline shows the final status without reload.
   - Dashboard: battery drains, gimbal and waypoint change, trail grows; "Request live camera" goes
     requested → live → ended when the mission is done; camera button is disabled after landing.
   - `curl -X POST localhost:8000/telemetry/ingest -H 'Content-Type: application/json' -d '<drone sample JSON>'`
     is accepted (with `droneID` matching an active mission's drone) and shows on the dashboard.
   - Reject paths require a reason. No dark mode under OS dark setting. No settings/profile buttons anywhere.
