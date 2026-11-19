// Mirrors backend/app/schemas.py. Update both together.
// datetime fields arrive as ISO strings.

export type ReportStatus =
  | "submitted"
  | "no_damage"
  | "under_review"
  | "rejected"
  | "uav_dispatched"
  | "confirmed"
  | "not_confirmed";

export type PlanStatus = "proposed" | "approved" | "changes_needed" | "rejected";

export type MissionState = "pending" | "takeoff" | "surveying" | "landing" | "done" | "failed";

export type CameraStatus = "idle" | "requested" | "live" | "denied" | "ended";

export type WaypointAction = "takeoff" | "fly" | "survey" | "land";

export interface Detection {
  id: number;
  source: "server" | "edge";
  deployment: string;
  cls: string;
  confidence: number;
  box_xyxy: [number, number, number, number];
  frame_id: string;
  model_version: string;
  lat: number | null;
  lon: number | null;
  size_m: number | null;
  annotated_url: string | null;
  flagged_wrong: boolean;
}

export interface Report {
  id: number;
  lat: number;
  lon: number;
  photo_url: string; // path under /media, e.g. "/media/seed/pothole-1.jpg"; use mediaUrl() from lib/api
  status: ReportStatus;
  review_note: string | null;
  created_at: string;
  updated_at: string;
  detections: Detection[]; // server pre-check boxes only; edge boxes: listMissionDetections()
  latest_plan_id: number | null; // newest plan of the report
  latest_plan_status: PlanStatus | null;
  mission_id: number | null; // newest mission of the report
}

/** Reject (confirmed = false) requires a note. */
export interface ReportReview {
  confirmed: boolean;
  note?: string | null;
}

export interface FlagIn {
  note?: string | null;
}

export interface Waypoint {
  lat: number;
  lon: number;
  alt: number;
  action: WaypointAction;
}

export interface FlightPlan {
  id: number;
  report_id: number;
  drone_id: string;
  altitude_m: number;
  survey_radius_m: number;
  route: Waypoint[];
  status: PlanStatus;
  decision_reason: string | null;
  decided_at: string | null;
  created_at: string;
  mission_id: number | null; // set once the plan is approved ("Launch UAV" = dispatchMission(mission_id))
  distance_m: number; // horizontal route length (sum of haversine legs)
  estimated_duration_s: number; // simulated flight time (s)
  estimated_battery_pct: number; // estimated battery used (%)
}

export interface PlanDecision {
  reason: string; // min length 1
}

export interface Mission {
  id: number;
  flight_plan_id: number;
  report_id: number;
  drone_id: string;
  state: MissionState;
  started_at: string | null;
  finished_at: string | null;
  /** How a failed mission ended (go / no-go decision log): recalled (weather, monitor) or aborted (edge, offline). */
  end_action: "recall" | "abort" | null;
  end_reason: string | null; // e.g. "sim-uav-1 recalled: Recalled by the drone: Rain started"
}

/** Body of POST /missions/{id}/telemetry (internal snake_case names). */
export interface TelemetryIn {
  lat: number;
  lon: number;
  altitude_m: number;
  heading_deg: number; // 0-360
  state: MissionState;
  drone_id?: string | null;
  home_lat?: number | null;
  home_lon?: number | null;
  home_alt_m?: number | null;
  distance_to_home_m?: number | null;
  distance_to_target_m?: number | null;
  gimbal_pitch_deg?: number | null;
  gimbal_yaw_deg?: number | null;
  gimbal_roll_deg?: number | null;
  battery_pct?: number | null;
  in_mission?: boolean | null;
  current_waypoint?: number | null;
  progress_pct?: number | null;
}

/** TelemetryOut. */
export interface Telemetry {
  id: number;
  mission_id: number;
  lat: number;
  lon: number;
  altitude_m: number;
  heading_deg: number;
  state: MissionState;
  ts: string;
  drone_id: string | null;
  home_lat: number | null;
  home_lon: number | null;
  home_alt_m: number | null;
  distance_to_home_m: number | null;
  distance_to_target_m: number | null;
  gimbal_pitch_deg: number | null;
  gimbal_yaw_deg: number | null;
  gimbal_roll_deg: number | null;
  battery_pct: number | null;
  in_mission: boolean | null;
  current_waypoint: number | null; // 0-based index into FlightPlan.route of the waypoint flown TO
  progress_pct: number | null; // 0-100
}

/** Raw drone app message accepted by POST /telemetry/ingest (wire format, camelCase). */
export interface DroneTelemetryIn {
  droneID: string; // must match an active mission's drone_id
  aircraftLatitude: number;
  aircraftLongitude: number;
  aircraftAltitude: number;
  headingDroneDegress: number;
  distanceToHome?: number | null;
  homeLatitude?: number | null;
  homeLongitude?: number | null;
  homeAltitude?: number | null;
  gimbal_PITCH?: number | null;
  gimbal_YAW?: number | null;
  gimbal_ROLL?: number | null;
  isInMission?: boolean | null;
  missionPlan?: unknown;
  currentWaypointMissionPlanner?: number | null;
  batteryPercentage?: number | null;
}

/**
 * CameraSessionOut. "idle" = never requested (null times). "requested" turns "live" ~2 s later.
 * "denied" is returned by requestCamera when the UAV is not flying (not stored). "ended" when stopped or done.
 */
export interface CameraSession {
  mission_id: number;
  status: CameraStatus;
  stream_url: string | null; // null in the mock: the UI shows a simulated feed
  requested_at: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface EdgeDetectionIn {
  frame_id: string;
  cls: string;
  confidence: number;
  box_xyxy: number[];
  model_version: string;
  deployment: string;
  pose: Record<string, number>; // lat, lon, altitude_m, heading_deg
  image_size: [number, number];
}

export interface MissionResultsIn {
  detections: EdgeDetectionIn[];
}

export interface Metrics {
  reports_total: number;
  correction_rate: number | null;
  uav_agreement_rate: number | null;
  mean_confidence_by_class: Record<string, number>;
  model_version: string | null;
  retrain_triggers: string[];
}

/** POST /dev/reset: counts of the reseeded demo data. */
export interface ResetResult {
  reports: number;
  flight_plans: number;
  missions: number;
  reset_at: string;
}

// ---------------------------------------------------------------- fleet (GET /fleet)

export type DroneStatus = "idle" | "flying" | "returning" | "swapping" | "offline";

export type TaskStatus = "queued" | "held" | "dispatched" | "completed" | "cancelled" | "flagged";

export type DecisionAction = "launch" | "hold" | "recall" | "abort";

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface DronePosition extends GeoPoint {
  alt_m: number;
}

/** One go / no-go decision of the dispatcher (the decision log; `code` is a short machine code). */
export interface FlightDecision {
  id: string;
  at: string;
  drone_id: string | null;
  report_id: number | null;
  action: DecisionAction;
  code: string;
  reason: string; // e.g. "wind 11 m/s > 8 m/s"
}

/** Simulated weather used by the go / no-go check. */
export interface Weather {
  wind_mps: number;
  gust_mps: number;
  rain: boolean;
  flyable: boolean;
  simulated: true;
  updated_at: string;
}

export interface District {
  name: string;
  center: GeoPoint;
  radius_m: number;
}

export interface Drone {
  drone_id: string;
  status: DroneStatus;
  battery_pct: number;
  position: DronePosition;
  heading_deg: number;
  mission_id: number | null;
  report_id: number | null;
  target: GeoPoint | null;
  available_at: string | null; // when a swapping drone is ready again
  last_decision: FlightDecision | null;
}

/** One inspection task waiting for (or past) dispatch. lat / lon is the pothole position. */
export interface FleetTask {
  task_id: number;
  report_id: number;
  status: TaskStatus;
  priority: number; // higher flies first
  created_at: string;
  hold_reason: string | null;
  lat: number;
  lon: number;
}

export interface Fleet {
  district: District;
  base: GeoPoint;
  weather: Weather;
  drones: Drone[];
  queue: FleetTask[];
  decisions: FlightDecision[]; // newest first
}

/** POST /reports/{id}/enqueue. */
export interface EnqueueResult {
  task_id: number;
  status: TaskStatus;
  report_ids: number[];
  drone_id: string | null;
  flight_plan_id: number | null;
  mission_id: number | null;
}

/** POST /dispatcher/tick. */
export interface DispatchTickResult {
  dispatched_mission_ids: number[];
}

// ---------------------------------------------------------------- frontend-only (not in schemas.py)

export type Role = "resident" | "monitor";

export interface Session {
  role: Role;
  name: string;
}
