import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface ProgressBarProps {
  /** 0-100; clamped. */
  value: number;
  /** Bar colour (CSS colour). Defaults to the accent blue. */
  color?: string;
  /** Text above the bar on the left, e.g. "Progress" or "Battery". */
  label?: ReactNode;
  /** Text above the bar on the right; defaults to the rounded percentage when label is set. */
  valueText?: ReactNode;
  className?: string;
}

/** Mission progress and battery bars. */
export function ProgressBar({ value, color, label, valueText, className }: ProgressBarProps) {
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div className={cn("min-w-0", className)}>
      {(label || valueText) && (
        <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
          <span className="text-slate-500">{label}</span>
          <span className="font-medium text-slate-900 tabular-nums">{valueText ?? `${Math.round(v)}%`}</span>
        </div>
      )}
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v)}
        aria-label={typeof label === "string" ? label : undefined}
      >
        <div
          className={cn("h-full rounded-full transition-[width] duration-500", !color && "bg-accent")}
          style={{ width: `${v}%`, background: color }}
        />
      </div>
    </div>
  );
}
