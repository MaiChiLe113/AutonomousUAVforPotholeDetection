"use client";

// Result card right after "Send report": the AI pre-check outcome (FR-09).

import StatusBadge from "@/components/StatusBadge";
import { Banner } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import type { Report } from "@/lib/types";

import FindingsList from "./FindingsList";
import ReportPhoto from "./ReportPhoto";
import { precheckNotice } from "./reportProgress";

export default function PrecheckResult({ report }: { report: Report }) {
  const notice = precheckNotice(report);
  const hasFindings = report.detections.some((d) => d.source === "server");

  return (
    <div className="min-w-0 space-y-3">
      <Banner tone={notice.tone} title={notice.title}>
        {notice.text}
      </Banner>

      <div className="flex min-w-0 items-center gap-3">
        <ReportPhoto path={report.photo_url} alt={`Photo of report #${report.id}`} variant="thumb" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold text-slate-900">Report #{report.id}</span>
            <StatusBadge status={report.status} kind="report" />
          </div>
          <p className="truncate text-xs text-slate-500">Sent {formatDateTime(report.created_at)}</p>
        </div>
      </div>

      {hasFindings && (
        <div className="min-w-0">
          <h2 className="mb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">AI check</h2>
          <FindingsList detections={report.detections} />
        </div>
      )}
    </div>
  );
}
