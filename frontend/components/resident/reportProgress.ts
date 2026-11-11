// Resident view of a report: pre-check summary text and the status timeline (UC-R1, UC-R2).

import type { BannerTone, TimelineStep } from "@/components/ui";
import { FINAL_REPORT_STATUSES } from "@/lib/config";
import { classLabel, formatConfidence, formatDateTime } from "@/lib/format";
import type { Detection, Report, ReportStatus } from "@/lib/types";

/** Polling stops at these statuses (FR-12). */
export const isFinalStatus = (status: ReportStatus) => FINAL_REPORT_STATUSES.includes(status);

/** Highest-confidence server detection of the AI pre-check, or null when none. */
export function topDetection(report: Pick<Report, "detections">): Detection | null {
  let best: Detection | null = null;
  for (const d of report.detections) {
    if (d.source !== "server") continue;
    if (!best || d.confidence > best.confidence) best = d;
  }
  return best;
}

/** "Pothole found 87%" for the top detection, "No damage found" when there is none. */
export function findingText(report: Pick<Report, "detections">): string {
  const top = topDetection(report);
  return top ? `${classLabel(top.cls)} found ${formatConfidence(top.confidence)}` : "No damage found";
}

export interface Notice {
  tone: BannerTone;
  title: string;
  text?: string;
}

/** Result card right after sending (FR-09). */
export function precheckNotice(report: Report): Notice {
  switch (report.status) {
    case "no_damage":
      return {
        tone: "info",
        title: "No damage found – report closed",
        text: "The AI check found no road damage in your photo. Thank you for reporting.",
      };
    case "submitted":
      return { tone: "info", title: "Report sent", text: "The AI check has not finished yet. Track the report to see the result." };
    default:
      return {
        tone: "success",
        title: `${findingText(report)} – sent to the UAV monitor`,
        text: "A UAV monitor will review it. Follow it under My reports.",
      };
  }
}

/** Summary above the timeline once the report is closed (FR-12). Null while it is still open. */
export function closingNotice(report: Report): Notice | null {
  switch (report.status) {
    case "no_damage":
      return { tone: "info", title: "No damage found – closed", text: "The AI check found no road damage in the photo." };
    case "rejected":
      return {
        tone: "warning",
        title: "Rejected",
        text: report.review_note ? `Reason: ${report.review_note}` : "The UAV monitor closed this report.",
      };
    case "confirmed":
      return { tone: "success", title: "Confirmed", text: "The UAV confirmed the road damage at this spot." };
    case "not_confirmed":
      return { tone: "info", title: "Not confirmed", text: "The UAV did not see damage at this spot." };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- timeline

const MAIN_STEPS = [
  { key: "submitted", label: "Submitted" },
  { key: "ai_check", label: "AI check" },
  { key: "under_review", label: "Under review" },
  { key: "uav_dispatched", label: "UAV dispatched" },
  { key: "result", label: "Confirmed / Not confirmed" },
] as const;

/** Index in MAIN_STEPS of the last step each status has reached. */
const REACHED: Record<ReportStatus, number> = {
  submitted: 0,
  no_damage: 1,
  under_review: 2,
  rejected: 2,
  uav_dispatched: 3,
  confirmed: 4,
  not_confirmed: 4,
};

/**
 * Steps for StatusTimeline: Submitted → AI check → Under review → UAV dispatched → Confirmed / Not confirmed,
 * marked as in the UC-R2 table. A closed report (no_damage, rejected) gets an end step right after the last
 * step it reached, with the reason; the steps it never reaches follow as "skipped".
 */
export function reportTimeline(report: Report): TimelineStep[] {
  const { status } = report;
  const reached = REACHED[status];
  const final = isFinalStatus(status);
  const created = formatDateTime(report.created_at);
  const updated = formatDateTime(report.updated_at);

  const describe = (key: (typeof MAIN_STEPS)[number]["key"]): Pick<TimelineStep, "description" | "time"> => {
    switch (key) {
      case "submitted":
        return { description: status === "submitted" ? "Waiting for the AI check" : undefined, time: created };
      case "ai_check":
        return reached >= 1
          ? { description: status === "no_damage" ? "No road damage in the photo" : findingText(report), time: created }
          : {};
      case "under_review":
        if (status === "under_review") return { description: "A UAV monitor is checking your report", time: updated };
        return reached >= 2 ? { description: "Checked by a UAV monitor" } : {};
      case "uav_dispatched":
        if (status === "uav_dispatched") return { description: "A drone is flying to the spot to check the damage", time: updated };
        return {};
      case "result":
        if (status === "confirmed") return { description: "The UAV confirmed the road damage.", time: updated };
        if (status === "not_confirmed") return { description: "The UAV did not see damage at this spot.", time: updated };
        return {};
    }
  };

  const resultLabel = status === "confirmed" ? "Confirmed" : status === "not_confirmed" ? "Not confirmed" : null;

  if (status === "no_damage" || status === "rejected") {
    const end: TimelineStep =
      status === "no_damage"
        ? { key: "closed", label: "No damage found – closed", state: "done", time: updated }
        : {
            key: "closed",
            label: "Rejected",
            state: "failed",
            description: report.review_note ? `Reason: ${report.review_note}` : "No reason was given.",
            time: updated,
          };
    const done = MAIN_STEPS.slice(0, reached + 1).map((s) => ({ ...s, state: "done" as const, ...describe(s.key) }));
    const skipped = MAIN_STEPS.slice(reached + 1).map((s) => ({ ...s, state: "skipped" as const }));
    return [...done, end, ...skipped];
  }

  return MAIN_STEPS.map((s, i) => ({
    key: s.key,
    label: s.key === "result" && resultLabel ? resultLabel : s.label,
    state: i < reached ? "done" : i === reached ? (final ? "done" : "current") : "upcoming",
    ...describe(s.key),
  }));
}
