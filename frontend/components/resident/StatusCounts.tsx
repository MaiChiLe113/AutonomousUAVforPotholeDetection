// Home hub: how many of my reports are in each status (labels and colours from REPORT_STATUS).

import { REPORT_STATUS, RESIDENT } from "@/lib/config";
import type { Report, ReportStatus } from "@/lib/types";

export default function StatusCounts({ reports }: { reports: Report[] }) {
  const counts = new Map<ReportStatus, number>();
  for (const r of reports) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const statuses = RESIDENT.statusOrder.filter((s) => counts.has(s));

  return (
    <ul aria-label="My reports by status" className="grid grid-cols-3 gap-2">
      <li className="min-w-0 rounded-xl bg-slate-100 px-2.5 py-2">
        <div className="text-lg leading-tight font-semibold text-slate-900 tabular-nums">{reports.length}</div>
        <div className="text-xs leading-tight text-slate-600">All reports</div>
      </li>
      {statuses.map((s) => {
        const style = REPORT_STATUS[s];
        return (
          <li key={s} className="min-w-0 rounded-xl px-2.5 py-2" style={{ background: style.bg, color: style.fg }}>
            <div className="text-lg leading-tight font-semibold tabular-nums">{counts.get(s)}</div>
            <div className="flex min-w-0 items-start gap-1 text-xs leading-tight">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: style.color }} aria-hidden />
              <span className="min-w-0 break-words">{style.label}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
