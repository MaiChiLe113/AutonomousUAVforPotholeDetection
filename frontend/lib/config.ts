// Every changeable value in the frontend lives here (the backend equivalent is backend/config.py).

import type { IconName } from "@/components/ui/Icon";
import type { CameraStatus, DecisionAction, DroneStatus, MissionState, PlanStatus, ReportStatus, Role, TaskStatus } from "./types";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/** Demo role header sent on every API request (the backend reads it; not real authentication). */
export const API = {
  roleHeader: "X-Role",
  /**
   * Role sent when nobody is signed in. Only the login screen "Reset demo" button runs signed out, so it sends
   * the monitor role. This is a demo-only convenience, not access control: the header is not authenticated.
   */
  anonymousRole: "monitor" as Role,
};

export const APP = {
  name: "Pothole UAV",
  description: "Report potholes and follow UAV confirmation",
};

// ---------------------------------------------------------------- session / roles
export const SESSION = {
  storageKey: "pothole-uav.session",
  myReportsKey: "pothole-uav.my-reports", // resident: ids of reports sent from this browser
};

/** Resident pages (all under /resident; the old /report links redirect here). */
export const RESIDENT_ROUTES = {
  home: "/resident/home", // hub
  newReport: "/resident/report",
  reports: "/resident/reports",
  report: (id: number | string) => `/resident/reports/${id}`,
  photos: "/resident/photos",
  /** Photo history with the large view of one report's photo open. */
  photo: (id: number) => `/resident/photos?photo=${id}`,
};

/** UAV monitor pages. */
export const MONITOR_ROUTES = {
  home: "/monitor", // report queue (the Reports tab)
  fleet: "/monitor/dashboard", // where a monitor lands: the Fleet tab
  report: (id: number | string) => `/monitor/reports/${id}`,
  plan: (id: number | string) => `/monitor/flight-plans/${id}`,
  /** Dashboard: the fleet cards without an id, or the live view of one mission with an id. */
  dashboard: (missionId?: number | string | null) =>
    missionId == null ? "/monitor/dashboard" : `/monitor/dashboard?mission=${missionId}`,
  dashboardMap: "/monitor/dashboard/map",
  dashboardHistory: "/monitor/dashboard/history",
};

export const ROLE_HOME: Record<Role, string> = {
  resident: RESIDENT_ROUTES.home,
  monitor: MONITOR_ROUTES.fleet,
};

export const ROLE_LABEL: Record<Role, string> = {
  resident: "Resident",
  monitor: "UAV Monitor",
};

// ---------------------------------------------------------------- polling / simulation
export const SIM = {
  telemetryPollMs: 1000, // dashboard live UAV position (SCRUM-39)
  cameraPollMs: 2000, // live camera session while requested / live
  reportStatusPollMs: 5000, // resident status page (SCRUM-45)
  reportQueuePollMs: 10000, // monitor report list
  signalLostAfterMs: 3000, // telemetry older than this shows "Signal lost"
};

/** @deprecated use SIM; kept so older imports keep compiling. */
export const POLL_INTERVAL_MS = {
  reportStatus: SIM.reportStatusPollMs,
  telemetry: SIM.telemetryPollMs,
  reportQueue: SIM.reportQueuePollMs,
  camera: SIM.cameraPollMs,
};

export const BATTERY = {
  warnBelowPct: 40, // amber
  criticalBelowPct: 20, // red + "Return home" warning
  colors: { ok: "#16a34a", warn: "#f59e0b", critical: "#dc2626" },
};

// ---------------------------------------------------------------- resident pages
export const GEOLOCATION = {
  enableHighAccuracy: true,
  timeoutMs: 8000, // then fall back to MAP.defaultCenter
  maximumAgeMs: 60000, // accept a cached position this old
};

/** Report statuses that never change again (resident status polling stops here). */
export const FINAL_REPORT_STATUSES: ReportStatus[] = ["no_damage", "rejected", "confirmed", "not_confirmed"];

export const RESIDENT = {
  hubRecentReports: 3, // home hub: latest reports listed
  hubRecentPhotos: 8, // home hub: thumbnails in the photo strip
  listThumbPx: 48, // report rows
  stripThumbPx: 72, // home hub photo strip
  photoTileMinPx: 150, // photo history grid: min tile width (2 columns at 375 px)
  /** Order of the status counts on the home hub (open first, then closed). */
  statusOrder: [
    "submitted",
    "under_review",
    "uav_dispatched",
    "confirmed",
    "not_confirmed",
    "no_damage",
    "rejected",
  ] as ReportStatus[],
};

// ---------------------------------------------------------------- monitor pages
export const MONITOR = {
  fleetPollMs: 2000, // GET /fleet on every dashboard tab (cards, map, decision log)
  historyPollMs: 5000, // History tab: finished missions
  historyMaxMissions: 25, // History tab: newest finished missions listed
  countdownClockMs: 1000, // "ready in 42 s" on a swapping UAV card
  decisionsShown: 50, // History tab: newest decisions listed
  /**
   * Monitor sidebar tabs. A tab is active on its own href or on a route under one of `alsoUnder`.
   * Under MAP.panel.desktopMinWidthPx the sidebar shrinks to an icon-only rail (never a bottom bar).
   */
  tabs: [
    { key: "fleet", label: "Fleet", icon: "drone", href: "/monitor/dashboard", alsoUnder: [] },
    { key: "map", label: "Digital twin", icon: "map", href: "/monitor/dashboard/map", alsoUnder: [] },
    { key: "reports", label: "Reports", icon: "list", href: "/monitor", alsoUnder: ["/monitor/reports", "/monitor/flight-plans"] },
    { key: "simulator", label: "Simulator", icon: "play", href: "/monitor/dashboard/simulator", alsoUnder: [] },
    { key: "history", label: "History", icon: "history", href: "/monitor/dashboard/history", alsoUnder: [] },
  ] as { key: string; label: string; icon: IconName; href: string; alsoUnder: string[] }[],
  /** Tasks the queue list shows (the others are done with). */
  waitingTaskStatuses: ["queued", "held", "flagged"] as TaskStatus[],
  /** Tasks that can still be cancelled. */
  cancellableTaskStatuses: ["queued", "held", "flagged"] as TaskStatus[],
  trailMaxPoints: 2000, // flown positions kept for the dashboard trail (client side)
  feedDriftPx: 6, // simulated camera feed: slow drift so the still photo reads as live video
  trailMaxJumpM: 2000, // a reading farther than this from the planned route is off-route (e.g. an ingest test sample): own trail segment
  queueClockMs: 30_000, // /monitor: refresh of the "25 min ago" labels
  signalClockMs: 500, // dashboard: refresh of "Last update n s ago" / "Signal lost"
  feedClockMs: 1000, // simulated camera feed: HUD clock and drift step
  /** "In mission" / "Idle" chip dot on the dashboard. */
  inMissionColors: { active: "#16a34a", idle: "#94a3b8" },
};

// ---------------------------------------------------------------- map
export const MAP = {
  // District: centred on the UAV base (backend/config.py FleetConfig.base_lat/base_lon, service_radius_m).
  // GET /fleet is the live source; these values are used until it answers and on the resident pages.
  district: {
    name: "District 1",
    center: [10.7769, 106.7009] as [number, number],
    radiusM: 2000,
    boundsPaddingM: 500, // the map cannot be panned farther than this outside the service circle
    minZoom: 13, // zoomed out enough to see the whole 4 km district, not the whole city
    boundsViscosity: 1, // 1 = hard wall at the bounds
    serviceColor: "#2563eb",
  },
  defaultCenter: [10.7769, 106.7009] as [number, number], // used when geolocation is denied; same as district.center
  defaultZoom: 16,
  focusZoom: 18, // zoom used when flying to a single pin
  maxZoom: 19,
  tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  tileSubdomains: "",
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  flyDurationS: 0.8,
  fitPaddingPx: 48,
  // Keep pins clear of the FloatingPanel when flying / fitting / following.
  panel: {
    desktopMinWidthPx: 768, // same breakpoint as the `md:` FloatingPanel layout
    desktopInsetPx: 412, // panel width (380) + left margin (16) + gap (16)
    mobileSheetFraction: 0.45, // part of the screen height covered by the bottom sheet
  },
  colors: {
    accent: "#2563eb",
    route: "#2563eb",
    plannedRoute: "#2563eb",
    trail: "#0f172a",
    homeLine: "#64748b",
    circle: "#2563eb",
    pin: "#ea4335",
    uav: "#2563eb",
    base: "#0f172a",
    camera: "#f59e0b",
  },
  camera: {
    halfAngleDeg: 30, // half of the horizontal field of view drawn as the footprint cone
    minRangeM: 12,
    maxRangeM: 80,
    defaultRangeM: 35, // used when pitch / altitude are unknown
  },
};

// ---------------------------------------------------------------- RDMO simulator (monitor Simulator tab)
// Standalone Unity WebGL build in public/rdmo/ (fetched by scripts/fetch-rdmo.sh, gitignored). Not connected to the fleet.
export const SIMULATOR = {
  src: "/rdmo/index.html",
  repoUrl: "https://github.com/EdwinTSalcedo/RDMO-DigitalTwin",
  title: "RDMO road-inspection simulator",
  description: "A drone road-inspection simulation you can fly around a 3D city in the browser.",
  standalone:
    "Standalone Unity simulation by RDMO / CIDIMEC / UCB (MIT licence). It runs in your browser and is NOT connected to our fleet, reports or go/no-go logic.",
  downloadNote: "The first launch downloads about 187 MB. The browser keeps it afterwards.",
  detectionNote: "Detection inside the simulator is disabled in this build.",
  creditText: "RDMO Digital Twin by RDMO / CIDIMEC / UCB",
  notInstalled: "Simulator files not installed.",
  installCommand: "bash frontend/scripts/fetch-rdmo.sh",
  installHint: "Run this from the repo root, then reload this page:",
  // The Unity canvas is a fixed 1024 x 768 plus a 38 px footer: smaller panes scroll.
  minWidthPx: 1024,
  minHeightPx: 810,
};

// ---------------------------------------------------------------- 3D digital twin (monitor Map tab, MapLibre GL)
export const TWIN = {
  // OpenFreeMap vector style: free, no API key. Its "building-3d" layer extrudes OSM buildings.
  styleUrl: "https://tiles.openfreemap.org/styles/liberty",
  // Added to the attribution: the style's source supplies "OpenFreeMap © OpenMapTiles Data from OpenStreetMap".
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
  chipLabel: "Simulated UAVs · OSM buildings", // honest label: the UAVs are simulated, the buildings are OSM data
  // Camera
  pitch: 62, // default angled overview
  bearing: -20,
  flatPitch: 0, // the 2D toggle
  flatBearing: 0,
  maxPitch: 80,
  minZoom: 12,
  maxZoom: 19,
  initialZoom: 13.5, // until the first fit
  fitPaddingPx: 48,
  boundsPaddingM: 1200, // the camera centre stays within the service circle plus this (a tilted view needs more room)
  tiltZoomOffset: 0.3, // zoom out this much from a flat fit when the camera is tilted
  followZoom: 17, // zoom when "Follow UAV" starts
  cameraMs: 800,
  loadTimeoutMs: 15000, // style not loaded by then: fall back to the flat Leaflet map
  // District ring
  ring: { color: "#2563eb", width: 2, dash: [3, 2], fillOpacity: 0.06, segments: 96 },
  // Report / task pins
  pin: { radius: 7, strokeColor: "#ffffff", strokeWidth: 2, hitRadius: 12 },
  pinStatuses: ["queued", "held", "flagged", "dispatched"] as TaskStatus[], // tasks drawn as pins
  // Extrusion layer added only when the style has none
  extrusion: {
    color: "#dfe3e8",
    opacity: 0.92,
    minZoom: 13,
    /** [height in m, colour]: low blocks light, towers darker. */
    heightColors: [
      [0, "#e4e7ec"],
      [30, "#c3cad6"],
      [100, "#9aa8bd"],
      [250, "#6f819d"],
    ] as [number, string][],
  },
  // HTML markers
  uavSizePx: 40,
  baseSizePx: 26,
};

// ---------------------------------------------------------------- statuses
export interface StatusStyle {
  label: string;
  color: string; // solid colour: map dots, badge dot, timeline
  bg: string; // badge background
  fg: string; // badge text
}

export const REPORT_STATUS: Record<ReportStatus, StatusStyle> = {
  submitted: { label: "Submitted", color: "#64748b", bg: "#f1f5f9", fg: "#334155" },
  no_damage: { label: "No damage", color: "#94a3b8", bg: "#f1f5f9", fg: "#475569" },
  under_review: { label: "Under review", color: "#f59e0b", bg: "#fef3c7", fg: "#92400e" },
  rejected: { label: "Rejected", color: "#ef4444", bg: "#fee2e2", fg: "#991b1b" },
  uav_dispatched: { label: "UAV dispatched", color: "#8b5cf6", bg: "#ede9fe", fg: "#5b21b6" },
  confirmed: { label: "Confirmed", color: "#16a34a", bg: "#dcfce7", fg: "#166534" },
  not_confirmed: { label: "Not confirmed", color: "#14b8a6", bg: "#ccfbf1", fg: "#115e59" },
};

export const PLAN_STATUS: Record<PlanStatus, StatusStyle> = {
  proposed: { label: "Proposed", color: "#f59e0b", bg: "#fef3c7", fg: "#92400e" },
  approved: { label: "Approved", color: "#16a34a", bg: "#dcfce7", fg: "#166534" },
  changes_needed: { label: "Changes needed", color: "#f97316", bg: "#ffedd5", fg: "#9a3412" },
  rejected: { label: "Rejected", color: "#ef4444", bg: "#fee2e2", fg: "#991b1b" },
};

export const MISSION_STATE: Record<MissionState, StatusStyle> = {
  pending: { label: "Pending", color: "#64748b", bg: "#f1f5f9", fg: "#334155" },
  takeoff: { label: "Takeoff", color: "#3b82f6", bg: "#dbeafe", fg: "#1e40af" },
  surveying: { label: "Surveying", color: "#8b5cf6", bg: "#ede9fe", fg: "#5b21b6" },
  landing: { label: "Landing", color: "#0ea5e9", bg: "#e0f2fe", fg: "#075985" },
  done: { label: "Done", color: "#16a34a", bg: "#dcfce7", fg: "#166534" },
  failed: { label: "Failed", color: "#ef4444", bg: "#fee2e2", fg: "#991b1b" },
};

export const CAMERA_STATUS: Record<CameraStatus, StatusStyle> = {
  idle: { label: "Camera off", color: "#64748b", bg: "#f1f5f9", fg: "#334155" },
  requested: { label: "Waiting for drone", color: "#f59e0b", bg: "#fef3c7", fg: "#92400e" },
  live: { label: "Live", color: "#dc2626", bg: "#fee2e2", fg: "#991b1b" },
  denied: { label: "Denied", color: "#f97316", bg: "#ffedd5", fg: "#9a3412" },
  ended: { label: "Camera ended", color: "#64748b", bg: "#f1f5f9", fg: "#334155" },
};

export const DRONE_STATUS: Record<DroneStatus, StatusStyle> = {
  idle: { label: "Idle", color: "#16a34a", bg: "#dcfce7", fg: "#166534" },
  flying: { label: "Flying", color: "#3b82f6", bg: "#dbeafe", fg: "#1e40af" },
  returning: { label: "Returning", color: "#0ea5e9", bg: "#e0f2fe", fg: "#075985" },
  swapping: { label: "Battery swap", color: "#f59e0b", bg: "#fef3c7", fg: "#92400e" },
  offline: { label: "Offline", color: "#64748b", bg: "#f1f5f9", fg: "#334155" },
};

export const TASK_STATUS: Record<TaskStatus, StatusStyle> = {
  queued: { label: "Queued", color: "#64748b", bg: "#f1f5f9", fg: "#334155" },
  held: { label: "Held", color: "#f59e0b", bg: "#fef3c7", fg: "#92400e" },
  dispatched: { label: "Dispatched", color: "#8b5cf6", bg: "#ede9fe", fg: "#5b21b6" },
  completed: { label: "Completed", color: "#16a34a", bg: "#dcfce7", fg: "#166534" },
  cancelled: { label: "Cancelled", color: "#94a3b8", bg: "#f1f5f9", fg: "#475569" },
  flagged: { label: "Needs attention", color: "#ef4444", bg: "#fee2e2", fg: "#991b1b" },
};

export const DECISION_ACTION: Record<DecisionAction, StatusStyle> = {
  launch: { label: "Launch", color: "#16a34a", bg: "#dcfce7", fg: "#166534" },
  hold: { label: "Hold", color: "#f59e0b", bg: "#fef3c7", fg: "#92400e" },
  recall: { label: "Recall", color: "#0ea5e9", bg: "#e0f2fe", fg: "#075985" },
  abort: { label: "Abort", color: "#ef4444", bg: "#fee2e2", fg: "#991b1b" },
};

/** Mission states during which the UAV is in the air (camera can be requested). */
export const FLYING_STATES: MissionState[] = ["takeoff", "surveying", "landing"];

// ---------------------------------------------------------------- uploads / labels
export const UPLOAD = {
  maxMb: 10, // keep in sync with backend config.API.max_upload_mb
  allowedTypes: ["image/jpeg", "image/png"],
  accept: "image/jpeg,image/png", // <input type="file" accept=...>
};

export const CLASS_LABELS: Record<string, string> = {
  D00: "Longitudinal crack",
  D10: "Transverse crack",
  D20: "Alligator crack",
  D40: "Pothole",
};
