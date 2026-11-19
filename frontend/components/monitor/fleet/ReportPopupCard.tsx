"use client";

// Card shown above a report dot on the Digital twin: photo, report number and status, the top detection,
// when it was reported, why its inspection is held (if it is) and a link to the report page.

import StatusBadge from "@/components/StatusBadge";
import ReportPhoto from "@/components/resident/ReportPhoto";
import { ButtonLink } from "@/components/ui";
import { MONITOR_ROUTES } from "@/lib/config";
import { classLabel, formatConfidence, formatDateTime } from "@/lib/format";
import type { FleetTask, Report } from "@/lib/types";

import { topDetection } from "../queue";

export default function ReportPopupCard({ report, task }: { report: Report; task: FleetTask | null }) {
  const top = topDetection(report.detections);
  const summary = top
    ? `${classLabel(top.cls)} ${formatConfidence(top.confidence)}`
    : report.status === "no_damage"
      ? "No damage found"
      : "No detections";
  return (
    <article aria-label={`Report #${report.id}`} className="w-full">
      <ReportPhoto path={report.photo_url} alt={`Photo of report #${report.id}`} variant="banner" />
      <div className="space-y-2 p-3">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <h3 className="truncate text-base font-semibold text-slate-900">Report #{report.id}</h3>
          <StatusBadge status={report.status} kind="report" />
        </div>
        <p className="text-sm text-slate-700">{summary}</p>
        <p className="text-xs text-slate-500">Reported {formatDateTime(report.created_at)}</p>
        {task?.status === "held" && task.hold_reason && <p className="text-xs text-amber-800">Held: {task.hold_reason}</p>}
        <ButtonLink size="sm" variant="secondary" fullWidth href={MONITOR_ROUTES.report(report.id)}>
          Open report
        </ButtonLink>
      </div>
    </article>
  );
}
