"use client";

// Compact list of reports waiting for a UAV, highest priority first, with the reason a task is held.

import Link from "next/link";
import { useMemo } from "react";

import StatusBadge from "@/components/StatusBadge";
import { Button, EmptyState } from "@/components/ui";
import { MONITOR, MONITOR_ROUTES } from "@/lib/config";
import { parseApiDate, timeAgo } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import type { FleetTask } from "@/lib/types";

const formatPriority = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

const byPriority = (a: FleetTask, b: FleetTask) =>
  b.priority - a.priority || (parseApiDate(a.created_at)?.getTime() ?? 0) - (parseApiDate(b.created_at)?.getTime() ?? 0);

export default function QueueList({ queue, onCancel }: { queue: FleetTask[]; onCancel: (reportId: number) => void }) {
  const now = useNow(MONITOR.queueClockMs);
  const waiting = useMemo(() => queue.filter((t) => MONITOR.waitingTaskStatuses.includes(t.status)).sort(byPriority), [queue]);

  if (waiting.length === 0) {
    return <EmptyState icon="check" title="Queue is empty" description="Confirmed reports wait here until a UAV is cleared to fly." />;
  }

  return (
    <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
      {waiting.map((t) => (
        <li key={t.task_id} className="flex min-w-0 items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <Link href={MONITOR_ROUTES.report(t.report_id)} className="text-sm font-semibold text-slate-900 hover:underline focus-visible:outline-2 focus-visible:outline-accent">
                Report #{t.report_id}
              </Link>
              <StatusBadge status={t.status} kind="task" />
              <span className="text-xs text-slate-500">Priority {formatPriority(t.priority)}</span>
              <span className="text-xs text-slate-500">{timeAgo(t.created_at, now)}</span>
            </div>
            {t.hold_reason && <p className="mt-0.5 break-words text-sm text-amber-800">{t.hold_reason}</p>}
          </div>
          {MONITOR.cancellableTaskStatuses.includes(t.status) && (
            <Button size="sm" variant="danger" onClick={() => onCancel(t.report_id)} aria-label={`Cancel task for report ${t.report_id}`}>
              Cancel
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
