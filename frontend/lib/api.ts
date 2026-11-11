// One typed wrapper per backend endpoint. Errors are thrown as ApiError with the
// FastAPI `detail` text as the message (422 validation lists are joined).

import { API_URL } from "./config";
import type {
  CameraSession,
  Detection,
  DroneTelemetryIn,
  FlightPlan,
  Metrics,
  Mission,
  MissionResultsIn,
  Report,
  ReportStatus,
  ResetResult,
  Telemetry,
  TelemetryIn,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number, // 0 = network error (backend not reachable)
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function detailText(detail: unknown): string | null {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((d) => (d && typeof d === "object" && "msg" in d ? String(d.msg) : String(d)));
    return parts.join("; ");
  }
  return null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  } catch {
    throw new ApiError(`Cannot reach the server at ${API_URL}.`, 0);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(detailText(body?.detail) ?? `${res.status} ${res.statusText}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** Absolute URL for a backend media path such as Report.photo_url ("/media/..."). */
export const mediaUrl = (path: string) =>
  /^(https?:|data:|blob:)/.test(path) ? path : `${API_URL}${path.startsWith("/") ? "" : "/"}${path}`;

// Reports (SCRUM-23, 29, 30, 45)
export function createReport(lat: number, lon: number, photo: File): Promise<Report> {
  const form = new FormData();
  form.append("lat", String(lat));
  form.append("lon", String(lon));
  form.append("photo", photo);
  return request("/reports", { method: "POST", body: form });
}
export const listReports = (status?: ReportStatus) =>
  request<Report[]>(`/reports${status ? `?status=${encodeURIComponent(status)}` : ""}`);
export const getReport = (id: number) => request<Report>(`/reports/${id}`);
export const reviewReport = (id: number, confirmed: boolean, note?: string) =>
  request<Report>(`/reports/${id}/review`, json("PATCH", { confirmed, note }));

// Detections (SCRUM-29, 37)
export const listDetections = (reportId: number) =>
  request<Detection[]>(`/reports/${reportId}/detections`);
export const flagDetection = (id: number, note?: string) =>
  request<Detection>(`/detections/${id}/flag`, json("POST", { note }));

// Flight plans (SCRUM-27, 31)
export const proposeFlightPlan = (reportId: number) =>
  request<FlightPlan>(`/reports/${reportId}/flight-plan`, json("POST"));
/** Every plan for a report, newest first (decision history). */
export const listReportFlightPlans = (reportId: number) =>
  request<FlightPlan[]>(`/reports/${reportId}/flight-plans`);
export const getFlightPlan = (id: number) => request<FlightPlan>(`/flight-plans/${id}`);
export const approveFlightPlan = (id: number) =>
  request<FlightPlan>(`/flight-plans/${id}/approve`, json("POST"));
export const rejectFlightPlan = (id: number, reason: string) =>
  request<FlightPlan>(`/flight-plans/${id}/reject`, json("POST", { reason }));
export const requestPlanChanges = (id: number, reason: string) =>
  request<FlightPlan>(`/flight-plans/${id}/request-changes`, json("POST", { reason }));

// Missions (SCRUM-33, 39)
export const listMissions = (active = false) => request<Mission[]>(`/missions?active=${active}`);
export const getMission = (id: number) => request<Mission>(`/missions/${id}`);
export const dispatchMission = (id: number) =>
  request<Mission>(`/missions/${id}/dispatch`, json("POST"));
export const pushTelemetry = (missionId: number, body: TelemetryIn) =>
  request<Telemetry>(`/missions/${missionId}/telemetry`, json("POST", body));
export const latestTelemetry = (missionId: number) =>
  request<Telemetry>(`/missions/${missionId}/telemetry/latest`);
/** Edge (on-drone) detections stored for a mission. */
export const listMissionDetections = (missionId: number) =>
  request<Detection[]>(`/missions/${missionId}/detections`);
export const uploadMissionResults = (missionId: number, body: MissionResultsIn) =>
  request<Mission>(`/missions/${missionId}/results`, json("POST", body));

// Live camera (mocked: requested -> live after ~2 s, ended when the mission is done)
/** Returns the session; status "denied" (HTTP 200) when the UAV is not flying. */
export const requestCamera = (missionId: number) =>
  request<CameraSession>(`/missions/${missionId}/camera/request`, json("POST"));
export const getCamera = (missionId: number) => request<CameraSession>(`/missions/${missionId}/camera`);
/** Returns "ended" (or the "idle" session when nothing was requested). */
export const stopCamera = (missionId: number) =>
  request<CameraSession>(`/missions/${missionId}/camera/stop`, json("POST"));

// Telemetry ingest (raw drone app JSON)
export const ingestTelemetry = (raw: DroneTelemetryIn) =>
  request<Telemetry>(`/telemetry/ingest`, json("POST", raw));

// Monitoring (SCRUM-36)
export const getMetrics = () => request<Metrics>(`/monitoring/metrics`);
/** The drift report is an HTML file (404 in the mock prototype); open it in a new tab or an iframe. */
export const driftReportUrl = () => `${API_URL}/monitoring/drift-report`;

// Demo
/** Reseed the demo data (login screen "Reset demo"). */
export const resetDemo = () => request<ResetResult>(`/dev/reset`, json("POST"));
