import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Icon } from "./Icon";

export type StepState = "done" | "current" | "upcoming" | "failed" | "skipped";

export interface TimelineStep {
  key: string;
  label: string;
  state: StepState;
  /** Second line, e.g. "Pothole found 87%" or a review note. */
  description?: ReactNode;
  /** Pre-formatted time (use formatDateTime from lib/format). */
  time?: string | null;
}

export interface StatusTimelineProps {
  steps: TimelineStep[];
  /** vertical (default): report history. horizontal: compact stepper (mission takeoff → done). */
  orientation?: "vertical" | "horizontal";
  className?: string;
}

function Dot({ state }: { state: StepState }) {
  if (state === "done") {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white">
        <Icon name="check" size={12} />
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-white">
        <Icon name="close" size={12} />
      </span>
    );
  }
  if (state === "current") {
    return (
      <span className="relative flex h-5 w-5 items-center justify-center rounded-full border-2 border-accent bg-white">
        <span className="absolute inset-0 animate-ping rounded-full bg-accent/30" />
        <span className="h-2 w-2 rounded-full bg-accent" />
      </span>
    );
  }
  return <span className={cn("h-5 w-5 rounded-full border-2 bg-white", state === "skipped" ? "border-dashed border-slate-300" : "border-slate-300")} />;
}

const labelColor: Record<StepState, string> = {
  done: "text-slate-900",
  current: "text-accent font-semibold",
  upcoming: "text-slate-400",
  failed: "text-red-700 font-semibold",
  skipped: "text-slate-400 line-through",
};

export function StatusTimeline({ steps, orientation = "vertical", className }: StatusTimelineProps) {
  if (orientation === "horizontal") {
    return (
      <ol className={cn("flex w-full min-w-0 items-start", className)}>
        {steps.map((s, i) => (
          <li key={s.key} className="relative flex min-w-0 flex-1 flex-col items-center text-center" aria-current={s.state === "current" ? "step" : undefined}>
            {i > 0 && (
              <span
                className={cn(
                  "absolute top-2.5 right-1/2 h-0.5 w-full -translate-y-1/2",
                  s.state === "upcoming" || s.state === "skipped" ? "bg-slate-200" : "bg-accent",
                )}
                aria-hidden
              />
            )}
            <span className="relative z-10">
              <Dot state={s.state} />
            </span>
            <span className={cn("mt-1 w-full truncate px-0.5 text-[11px] leading-tight", labelColor[s.state])}>{s.label}</span>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <ol className={cn("min-w-0", className)}>
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        return (
          <li key={s.key} className="relative flex min-w-0 gap-3 pb-4 last:pb-0" aria-current={s.state === "current" ? "step" : undefined}>
            {!last && (
              <span
                className={cn(
                  "absolute top-6 bottom-0 left-[9px] w-0.5",
                  steps[i + 1].state === "upcoming" || steps[i + 1].state === "skipped" ? "bg-slate-200" : "bg-accent",
                )}
                aria-hidden
              />
            )}
            <span className="relative z-10 shrink-0 pt-0.5">
              <Dot state={s.state} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className={cn("text-sm", labelColor[s.state])}>{s.label}</span>
                {s.time && <span className="shrink-0 text-xs text-slate-500">{s.time}</span>}
              </div>
              {s.description && <div className="mt-0.5 text-sm break-words text-slate-600">{s.description}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
