import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface StatProps {
  label: string;
  value: ReactNode;
  unit?: string;
  /** Small line under the value. */
  hint?: ReactNode;
  className?: string;
}

/** One labelled reading (altitude, distance, gimbal…). Put several in <StatGrid>. */
export function Stat({ label, value, unit, hint, className }: StatProps) {
  return (
    <div className={cn("min-w-0 rounded-xl bg-slate-50 px-3 py-2", className)}>
      <div className="truncate text-xs text-slate-500">{label}</div>
      <div className="truncate text-base font-semibold text-slate-900 tabular-nums">
        {value}
        {unit && <span className="ml-0.5 text-xs font-normal text-slate-500">{unit}</span>}
      </div>
      {hint && <div className="truncate text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

/** Two-column grid of Stat tiles. */
export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-2", className)}>{children}</div>;
}
