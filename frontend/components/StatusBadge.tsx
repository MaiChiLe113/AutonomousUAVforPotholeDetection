import { cn } from "@/lib/cn";
import { statusStyle, type StatusKind } from "@/lib/format";
import type { CameraStatus, MissionState, PlanStatus, ReportStatus } from "@/lib/types";

export interface StatusBadgeProps {
  status: ReportStatus | PlanStatus | MissionState | CameraStatus;
  /** Which table to use; without it report, plan, mission, camera are tried in that order. */
  kind?: StatusKind;
  size?: "sm" | "md";
  className?: string;
}

/** Coloured pill for report / plan / mission / camera statuses (colours from lib/config). */
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
