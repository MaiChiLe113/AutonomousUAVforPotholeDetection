"use client";

// Decision history of a report's flight plans (FR-24): newest first, with status, reason and decision time.
// Older versions link to their own (read-only) page.

import Link from "next/link";

import StatusBadge from "@/components/StatusBadge";
import { cn } from "@/lib/cn";
import { MONITOR_ROUTES } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import type { FlightPlan } from "@/lib/types";

export default function PlanHistory({ plans, currentId }: { plans: FlightPlan[]; currentId: number }) {
  return (
    <ol className="min-w-0 space-y-2">
      {plans.map((p, i) => {
        const version = plans.length - i;
        const current = p.id === currentId;
        const body = (
          <>
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-slate-900">
                v{version} · Plan #{p.id}
                {current && <span className="ml-1.5 text-xs font-normal text-accent">(viewing)</span>}
              </span>
              <StatusBadge status={p.status} kind="plan" />
            </div>
            <div className="mt-0.5 text-xs text-slate-500">
              {Math.round(p.altitude_m)} m altitude · {Math.round(p.survey_radius_m)} m radius
            </div>
            <div className="mt-0.5 text-xs text-slate-500">
              Proposed {formatDateTime(p.created_at)}
              {p.decided_at && <> · decided {formatDateTime(p.decided_at)}</>}
            </div>
            {p.decision_reason && <p className="mt-1 text-sm break-words text-slate-700">&ldquo;{p.decision_reason}&rdquo;</p>}
          </>
        );
        const box = cn("block min-w-0 rounded-xl border px-3 py-2", current ? "border-accent bg-accent-soft/50" : "border-slate-200");
        return (
          <li key={p.id}>
            {current ? (
              <div className={box} aria-current="page">
                {body}
              </div>
            ) : (
              <Link href={MONITOR_ROUTES.plan(p.id)} className={cn(box, "hover:bg-slate-50")}>
                {body}
              </Link>
            )}
          </li>
        );
      })}
    </ol>
  );
}
