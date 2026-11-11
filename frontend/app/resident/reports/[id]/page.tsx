"use client";

// UC-R2 Track my reports (SCRUM-45): map on the report pin + status timeline that updates by itself.
// Polls GET /reports/{id} every SIM.reportStatusPollMs until a final status, then stops.
// (RoleGate: app/resident/layout.tsx)

import { useParams } from "next/navigation";
import { useState } from "react";

import MapView from "@/components/MapView";
import StatusBadge from "@/components/StatusBadge";
import FindingsList from "@/components/resident/FindingsList";
import ReportPhoto from "@/components/resident/ReportPhoto";
import { formatLatLng } from "@/components/resident/geolocation";
import { closingNotice, reportTimeline } from "@/components/resident/reportProgress";
import { useReportStatus } from "@/components/resident/useResidentReports";
import {
  Banner,
  ButtonLink,
  EmptyState,
  FloatingPanel,
  LoadingState,
  MapControlButton,
  MapControls,
  PanelSection,
  Spinner,
  StatusTimeline,
} from "@/components/ui";
import { RESIDENT_ROUTES, SIM } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import type { Report } from "@/lib/types";

/** "12" -> 12; anything that is not a positive whole number -> null (shown as not found). */
function parseId(raw: string | string[] | undefined): number | null {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (!s || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export default function ReportStatusPage() {
  const params = useParams<{ id: string }>();
  const id = parseId(params?.id);
  const { lookup, loading, error, polling } = useReportStatus(id);
  const [refit, setRefit] = useState(0);

  const report = lookup?.found ? lookup.report : null;
  const notFound = id === null || lookup?.found === false;

  return (
    <>
      <MapView
        pin={report ? { position: [report.lat, report.lon], label: `Report #${report.id}` } : null}
        fitKey={report ? `${report.id}-${refit}` : null}
      />

      {report && (
        <MapControls>
          <MapControlButton label="Centre on the report" icon="fit" iconOnly onClick={() => setRefit((n) => n + 1)} />
        </MapControls>
      )}

      {notFound ? (
        <FloatingPanel title={id ? `Report #${id}` : "Report"} backHref={RESIDENT_ROUTES.reports}>
          <EmptyState
            icon="alert"
            title="Report not found"
            description={
              id === null
                ? "This link does not point to a report."
                : `There is no report #${id}. It may have been removed when the demo data was reset.`
            }
            action={<ButtonLink href={RESIDENT_ROUTES.reports}>Back to my reports</ButtonLink>}
          />
        </FloatingPanel>
      ) : report ? (
        <FloatingPanel
          title={`Report #${report.id}`}
          subtitle={`Sent ${formatDateTime(report.created_at)}`}
          backHref={RESIDENT_ROUTES.reports}
          headerRight={<StatusBadge status={report.status} kind="report" size="md" />}
        >
          <ReportDetails report={report} error={error} polling={polling} />
        </FloatingPanel>
      ) : (
        <FloatingPanel title={id ? `Report #${id}` : "Report"} backHref={RESIDENT_ROUTES.reports}>
          {error ? (
            <Banner tone="danger" title="Cannot load the report">
              {error} <Reconnecting />
            </Banner>
          ) : (
            loading && <LoadingState text="Loading the report…" />
          )}
        </FloatingPanel>
      )}
    </>
  );
}

function Reconnecting() {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <Spinner size={10} label="Reconnecting" /> Reconnecting…
    </span>
  );
}

function ReportDetails({ report, error, polling }: { report: Report; error: string | null; polling: boolean }) {
  const notice = closingNotice(report);

  return (
    <div className="min-w-0">
      {error ? (
        <p role="status" className="mb-3 text-xs text-amber-700">
          <Reconnecting /> Showing the last known status.
        </p>
      ) : (
        polling && (
          <p className="mb-3 text-xs text-slate-500">Updates by itself every {Math.round(SIM.reportStatusPollMs / 1000)} s.</p>
        )
      )}

      {notice && (
        <Banner tone={notice.tone} title={notice.title} className="mb-3">
          {notice.text}
        </Banner>
      )}

      <PanelSection title="Progress">
        <div aria-live="polite">
          <StatusTimeline steps={reportTimeline(report)} />
        </div>
      </PanelSection>

      <PanelSection title="Your photo">
        <ReportPhoto path={report.photo_url} alt={`Photo of report #${report.id}`} />
      </PanelSection>

      <PanelSection title="AI check">
        <FindingsList detections={report.detections} />
      </PanelSection>

      <PanelSection title="Location">
        <p className="text-sm text-slate-700 tabular-nums">{formatLatLng([report.lat, report.lon])}</p>
      </PanelSection>
    </div>
  );
}
