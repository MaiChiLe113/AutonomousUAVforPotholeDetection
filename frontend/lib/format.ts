// Display helpers shared by every page.

import { CAMERA_STATUS, CLASS_LABELS, MISSION_STATE, PLAN_STATUS, REPORT_STATUS, type StatusStyle } from "./config";

/**
 * Parse a backend datetime. The API sends timezone-aware UTC times ("2026-11-04T10:00:00Z" or "+00:00").
 * A value without an offset is still read as UTC (JS would otherwise take it as local time).
 */
export function parseApiDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(iso);
  const d = new Date(hasZone ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "4 Nov, 14:05". */
export function formatDateTime(iso: string | null | undefined): string {
  const d = parseApiDate(iso);
  if (!d) return "–";
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** "14:05:09". */
export function formatTime(iso: string | null | undefined): string {
  const d = parseApiDate(iso);
  if (!d) return "–";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Milliseconds since `iso` (null when unknown). Negative clock skew is clamped to 0. */
export function ageMs(iso: string | null | undefined, nowMs: number): number | null {
  const d = parseApiDate(iso);
  return d ? Math.max(0, nowMs - d.getTime()) : null;
}

/** "just now", "3 s ago", "2 min ago", "1 h ago". */
export function timeAgo(iso: string | null | undefined, nowMs: number): string {
  const ms = ageMs(iso, nowMs);
  if (ms === null) return "–";
  const s = Math.round(ms / 1000);
  if (s < 1) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** 0.873 -> "87%". */
export const formatConfidence = (x: number | null | undefined) => (x == null ? "–" : `${Math.round(x * 100)}%`);

/** 87.3 -> "87%". */
export const formatPct = (x: number | null | undefined) => (x == null ? "–" : `${Math.round(x)}%`);

/** 45 -> "45 s", 95 -> "1 min 35 s", 3720 -> "1 h 2 min". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "–";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
}

/** 268.4 -> "268°", -30 -> "-30°". */
export const formatDeg = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "–" : `${Math.round(x)}°`);

/** 0-360 heading -> 8-point compass label ("N", "NE", ... "NW"). */
export function compassPoint(deg: number): string {
  const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const d = ((deg % 360) + 360) % 360;
  return points[Math.round(d / 45) % 8];
}

/** "D40" -> "Pothole". */
export const classLabel = (cls: string) => CLASS_LABELS[cls] ?? cls;

export type StatusKind = "report" | "plan" | "mission" | "camera";

const TABLES: Record<StatusKind, Record<string, StatusStyle>> = {
  report: REPORT_STATUS,
  plan: PLAN_STATUS,
  mission: MISSION_STATE,
  camera: CAMERA_STATUS,
};

/**
 * Label and colours for any status. Without `kind` the tables are searched in the order
 * report, plan, mission, camera ("rejected" looks the same for reports and plans).
 */
export function statusStyle(status: string, kind?: StatusKind): StatusStyle {
  const order: StatusKind[] = kind ? [kind] : ["report", "plan", "mission", "camera"];
  for (const k of order) {
    const s = TABLES[k][status];
    if (s) return s;
  }
  const label = status.replace(/_/g, " ");
  return { label: label.charAt(0).toUpperCase() + label.slice(1), color: "#64748b", bg: "#f1f5f9", fg: "#334155" };
}
