// One of my reports as a list row: thumbnail, number, status chip, AI finding, date. Opens the report.

import Link from "next/link";

import StatusBadge from "@/components/StatusBadge";
import { Icon } from "@/components/ui";
import { RESIDENT_ROUTES } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import type { Report } from "@/lib/types";

import ReportPhoto from "./ReportPhoto";
import { findingText } from "./reportProgress";

export default function ReportRow({ report }: { report: Report }) {
  return (
    <Link
      href={RESIDENT_ROUTES.report(report.id)}
      className="flex min-w-0 items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <ReportPhoto path={report.photo_url} alt={`Photo of report #${report.id}`} variant="thumb" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold text-slate-900">Report #{report.id}</span>
          <StatusBadge status={report.status} kind="report" />
        </div>
        <p className="mt-0.5 truncate text-sm text-slate-600">{findingText(report)}</p>
        <p className="truncate text-xs text-slate-500">Sent {formatDateTime(report.created_at)}</p>
      </div>
      <Icon name="chevron-right" size={18} className="shrink-0 text-slate-400" />
    </Link>
  );
}
