"use client";

// My reports: the reports sent from this browser, newest first, each with a status chip (FR-10).

import { Banner, ButtonLink, EmptyState, Icon, LoadingState } from "@/components/ui";
import { RESIDENT_ROUTES } from "@/lib/config";

import ReportRow from "./ReportRow";
import type { MyReportList } from "./useResidentReports";

export interface MyReportsListProps {
  list: MyReportList;
  /** Show only the newest n reports (home hub). Default: all. */
  limit?: number;
}

/** "1 earlier report is no longer available…" note for ids the backend forgot (demo reset). */
export function MissingNote({ missing }: { missing: number }) {
  if (missing <= 0) return null;
  return (
    <p className="mt-2 text-xs text-slate-500">
      {missing === 1 ? "1 earlier report is" : `${missing} earlier reports are`} no longer available (demo data was reset).
    </p>
  );
}

/** Empty state for a resident without reports, with the "Report a pothole" action. */
export function NoReportsYet({ missing = 0, className }: { missing?: number; className?: string }) {
  return (
    <EmptyState
      icon="pin"
      title="No reports yet"
      description={
        missing > 0
          ? "Your earlier reports are gone because the demo data was reset. Spotted a pothole? Report it in a minute."
          : "Spotted a pothole? Pin it on the map, add a photo and send it. You can follow every step here."
      }
      action={
        <ButtonLink href={RESIDENT_ROUTES.newReport} icon={<Icon name="plus" size={16} />}>
          Report a pothole
        </ButtonLink>
      }
      className={className}
    />
  );
}

export default function MyReportsList({ list, limit }: MyReportsListProps) {
  const { reports, missing, loading, error } = list;

  if (reports && reports.length === 0 && !error) return <NoReportsYet missing={missing} />;

  if (!reports) {
    if (error) {
      return (
        <Banner tone="danger" title="Cannot load your reports">
          {error} Trying again…
        </Banner>
      );
    }
    return loading ? <LoadingState text="Loading your reports…" /> : null;
  }

  const shown = limit ? reports.slice(0, limit) : reports;
  return (
    <div className="min-w-0">
      {error && (
        <p role="status" className="mb-2 text-xs text-amber-700">
          Reconnecting… showing the last known status.
        </p>
      )}
      <ul className="-mx-2 min-w-0">
        {shown.map((r) => (
          <li key={r.id}>
            <ReportRow report={r} />
          </li>
        ))}
      </ul>
      {!limit && <MissingNote missing={missing} />}
    </div>
  );
}
