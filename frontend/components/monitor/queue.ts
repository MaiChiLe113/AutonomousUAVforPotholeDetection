// Report queue filter chips for /monitor (UC-M1, FR-14). Uses Report.latest_plan_status, so no per-report calls.

import type { Detection, Report } from "@/lib/types";

export type QueueFilter = "needs_review" | "flight_plans" | "in_flight" | "done";

export const QUEUE_FILTERS: { value: QueueFilter; label: string; empty: string }[] = [
  { value: "needs_review", label: "Needs review", empty: "Nothing needs review" },
  { value: "flight_plans", label: "Flight plans", empty: "No flight plans waiting" },
  { value: "in_flight", label: "In flight", empty: "No UAV in flight" },
  { value: "done", label: "Done", empty: "No closed reports yet" },
];

/**
 * - Needs review: submitted, or under_review without a proposed / approved plan.
 * - Flight plans: under_review whose latest plan is proposed, or approved with the mission still pending
 *   (an approved plan keeps the report under_review only until dispatch).
 * - In flight: uav_dispatched.
 * - Done: no_damage, rejected, confirmed, not_confirmed.
 */
export function queueFilterOf(r: Report): QueueFilter {
  switch (r.status) {
    case "submitted":
      return "needs_review";
    case "under_review":
      return r.latest_plan_status === "proposed" || r.latest_plan_status === "approved" ? "flight_plans" : "needs_review";
    case "uav_dispatched":
      return "in_flight";
    default:
      return "done";
  }
}

/** Highest-confidence detection that is not flagged wrong (falls back to any). */
export function topDetection(detections: Detection[]): Detection | null {
  const pool = detections.some((d) => !d.flagged_wrong) ? detections.filter((d) => !d.flagged_wrong) : detections;
  return pool.reduce<Detection | null>((best, d) => (!best || d.confidence > best.confidence ? d : best), null);
}
