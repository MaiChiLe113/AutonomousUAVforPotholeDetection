import { cn } from "@/lib/cn";
import { statusStyle, type StatusKind } from "@/lib/format";
import type { CameraStatus, DecisionAction, DroneStatus, MissionState, PlanStatus, ReportStatus, TaskStatus } from "@/lib/types";

export interface StatusBadgeProps {
  status: ReportStatus | PlanStatus | MissionState | CameraStatus | DroneStatus | TaskStatus | DecisionAction;
  /** Which table to use; without it the tables are tried in the order report, plan, mission, camera, drone, task, decision. */
  kind?: StatusKind;
  size?: "sm" | "md";
  className?: string;
}

/** Coloured pill for report / plan / mission / camera / drone / task / decision statuses (colours from lib/config). */
export default function StatusBadge({ status, kind, size = "sm", className }: StatusBadgeProps) {
  const s = statusStyle(status, kind);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full font-medium whitespace-nowrap",
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-sm",
        className,
      )}
      style={{ background: s.bg, color: s.fg }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} aria-hidden />
      {s.label}
    </span>
  );
}
