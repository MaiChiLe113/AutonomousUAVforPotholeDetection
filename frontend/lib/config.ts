// Every changeable value in the frontend lives here (the backend equivalent is backend/config.py).

import type { CameraStatus, MissionState, PlanStatus, ReportStatus, Role } from "./types";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

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
  home: "/monitor", // report queue
  report: (id: number | string) => `/monitor/reports/${id}`,
  plan: (id: number | string) => `/monitor/flight-plans/${id}`,
  /** Live dashboard of one mission, or the active missions list without an id. */
  dashboard: (missionId?: number | string | null) =>
    missionId == null ? "/monitor/dashboard" : `/monitor/dashboard?mission=${missionId}`,
};

export const ROLE_HOME: Record<Role, string> = {
  resident: RESIDENT_ROUTES.home,
  monitor: MONITOR_ROUTES.home,
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
  activeMissionsPollMs: 3000, // /monitor/dashboard without ?mission: active missions + their battery
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
  defaultCenter: [10.7769, 106.7009] as [number, number], // used when geolocation is denied
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
    camera: "#f59e0b",
  },
  camera: {
    halfAngleDeg: 30, // half of the horizontal field of view drawn as the footprint cone
    minRangeM: 12,
    maxRangeM: 80,
    defaultRangeM: 35, // used when pitch / altitude are unknown
  },
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
