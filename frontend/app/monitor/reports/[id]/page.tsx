"use client";

// UC-M2 review a report (SCRUM-29, SCRUM-37, SCRUM-27): photo with the AI boxes, "Wrong detection" per row,
// "Confirm & propose flight plan" (review, then propose, then open the plan) or Reject with a reason.

import { useParams, useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import DetectionOverlay from "@/components/DetectionOverlay";
import MapView, { type MapPin } from "@/components/MapView";
import DetectionRows from "@/components/monitor/DetectionRows";
import RoleGate from "@/components/RoleGate";
import StatusBadge from "@/components/StatusBadge";
import { Banner, Button, ButtonLink, EmptyState, FloatingPanel, LoadingState, PanelSection, ReasonDialog } from "@/components/ui";
import { ApiError, flagDetection, getReport, proposeFlightPlan, reviewReport } from "@/lib/api";
import { MAP, MONITOR_ROUTES, REPORT_STATUS } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import { usePoll } from "@/lib/hooks";
import type { Detection, Report } from "@/lib/types";

export default function ReviewReportPage() {
  return (
    <RoleGate role="monitor">
      <ReviewReport />
    </RoleGate>
  );
}

/** 404 -> null so the page can show "not found"; other errors still throw. */
const nullOn404 = (e: unknown) => {
  if (e instanceof ApiError && e.status === 404) return null;
  throw e;
};

function ReviewReport() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const rid = Number(params.id);
  const validId = Number.isInteger(rid) && rid > 0;

  const q = usePoll(() => getReport(rid).catch(nullOn404), null, { key: rid, enabled: validId });
  // Actions return the updated report; keep it locally instead of re-fetching.
  const [local, setLocal] = useState<Report | null>(null);
  const report = local && local.id === rid ? local : q.data;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [activeBox, setActiveBox] = useState<number | null>(null);

  const pin = useMemo<MapPin | null>(() => (report ? { position: [report.lat, report.lon], label: `Report #${report.id}` } : null), [report]);

  const notFound = !validId || (!q.loading && !q.error && q.data === null);

  async function onFlag(d: Detection) {
    const updated = await flagDetection(d.id);
    // Functional update: two quick flags must not overwrite each other.
    const fetched = q.data;
    setLocal((prev) => {
      const base = prev && prev.id === rid ? prev : fetched;
      return base ? { ...base, detections: base.detections.map((x) => (x.id === updated.id ? updated : x)) } : prev;
    });
  }

  async function onConfirm() {
    if (!report || busy) return;
    setBusy(true);
    setError(null);
    try {
      await reviewReport(rid, true);
      let planId: number;
      try {
        planId = (await proposeFlightPlan(rid)).id;
      } catch (e) {
        // 409: a proposed / approved plan already exists -> open it.
        if (!(e instanceof ApiError && e.status === 409)) throw e;
        const fresh = await getReport(rid);
        if (fresh.latest_plan_id == null) throw e;
        planId = fresh.latest_plan_id;
      }
      router.push(MONITOR_ROUTES.plan(planId));
    } catch (e) {
      setError((e as Error).message || "Could not confirm the report.");
      setBusy(false);
    }
  }

  async function onReject(reason: string) {
    const updated = await reviewReport(rid, false, reason);
    setLocal(updated);
    setError(null);
  }

  const activePlan =
    report?.status === "under_review" && report.latest_plan_id != null && (report.latest_plan_status === "proposed" || report.latest_plan_status === "approved")
      ? { id: report.latest_plan_id, status: report.latest_plan_status }
      : null;
  const canDecide = report?.status === "under_review" && !activePlan;

  let footer: ReactNode = null;
  if (report && report.status === "under_review") {
    footer = (
      <div className="space-y-2">
        {error && <Banner tone="danger">{error}</Banner>}
        {canDecide ? (
          <div className="flex flex-col gap-2">
            <Button size="lg" fullWidth loading={busy} onClick={onConfirm}>
              Confirm &amp; propose flight plan
            </Button>
            <Button size="lg" variant="danger" fullWidth disabled={busy} onClick={() => setRejectOpen(true)}>
              Reject
            </Button>
          </div>
        ) : activePlan ? (
          <div className="flex flex-col gap-2">
            <ButtonLink size="lg" fullWidth href={MONITOR_ROUTES.plan(activePlan.id)}>
              Open flight plan #{activePlan.id}
            </ButtonLink>
            {activePlan.status === "proposed" && (
              <Button size="lg" variant="danger" fullWidth onClick={() => setRejectOpen(true)}>
                Reject report
              </Button>
            )}
          </div>
        ) : null}
      </div>
    );
  } else if (report) {
    // Read-only report (UC-M2 A3): links to its mission and its latest flight plan.
    const missionLink =
      report.mission_id == null
        ? null
        : report.status === "uav_dispatched"
          ? "Open live dashboard"
          : report.status === "confirmed" || report.status === "not_confirmed"
            ? "Open mission result"
            : null;
    if (missionLink || report.latest_plan_id != null) {
      footer = (
        <div className="flex flex-col gap-2">
          {missionLink && (
            <ButtonLink size="lg" fullWidth href={MONITOR_ROUTES.dashboard(report.mission_id)}>
              {missionLink}
            </ButtonLink>
          )}
          {report.latest_plan_id != null && (
            <ButtonLink size={missionLink ? "md" : "lg"} variant={missionLink ? "secondary" : "primary"} fullWidth href={MONITOR_ROUTES.plan(report.latest_plan_id)}>
              Open flight plan
            </ButtonLink>
          )}
        </div>
      );
    }
  }

  return (
    <>
      <MapView pin={pin} flyTo={report ? { center: [report.lat, report.lon], zoom: MAP.focusZoom } : null} />
      <FloatingPanel
        backHref={MONITOR_ROUTES.home}
        title={validId ? `Report #${rid}` : "Report"}
        subtitle={report ? `Sent ${formatDateTime(report.created_at)}` : undefined}
        headerRight={report ? <StatusBadge status={report.status} kind="report" size="md" /> : undefined}
        footer={footer}
      >
        {notFound ? (
          <EmptyState title="Report not found" description={`There is no report #${params.id}.`} action={<ButtonLink href={MONITOR_ROUTES.home} variant="secondary">Back to the queue</ButtonLink>} />
        ) : !report ? (
          q.error ? (
            <Banner tone="danger" action={<Button size="sm" variant="ghost" onClick={q.refresh}>Retry</Button>}>
              {q.error}
            </Banner>
          ) : (
            <LoadingState text="Loading report…" />
          )
        ) : (
          <>
            <PanelSection>
              <DetectionOverlay
                photoUrl={report.photo_url}
                detections={report.detections}
                activeId={activeBox}
                alt={`Photo of report #${report.id}`}
              />
              <p className="mt-2 text-xs text-slate-500 tabular-nums">
                {report.lat.toFixed(5)}, {report.lon.toFixed(5)}
              </p>
            </PanelSection>

            <StatusNote report={report} activePlan={activePlan} />

            <PanelSection title={`AI detections (${report.detections.length})`}>
              {report.detections.length === 0 ? (
                <p className="text-sm text-slate-600">No damage found by the AI.</p>
              ) : (
                <DetectionRows
                  detections={report.detections}
                  onFlag={report.status === "under_review" ? onFlag : undefined}
                  activeId={activeBox}
                  onActiveChange={setActiveBox}
                />
              )}
              {report.status === "under_review" && report.detections.length > 0 && (
                <p className="mt-2 text-xs text-slate-500">Flags are feedback for retraining; they do not decide the report.</p>
              )}
            </PanelSection>
          </>
        )}
      </FloatingPanel>

      <ReasonDialog
        open={rejectOpen}
        title={`Reject report #${rid}`}
        description="The report is closed as rejected and the resident sees your reason."
        placeholder="For example: painted road marking, not a pothole"
        submitLabel="Reject report"
        onSubmit={onReject}
        onClose={() => setRejectOpen(false)}
      />
    </>
  );
}

function StatusNote({ report, activePlan }: { report: Report; activePlan: { id: number; status: string } | null }) {
  const label = REPORT_STATUS[report.status].label;
  let note: ReactNode = null;
  switch (report.status) {
    case "submitted":
      note = <Banner tone="info">The AI pre-check is still running.</Banner>;
      break;
    case "under_review":
      note = activePlan ? (
        <Banner tone="info" title={`Flight plan #${activePlan.id} is ${activePlan.status}`}>
          The report was confirmed. Continue on the flight plan page.
        </Banner>
      ) : null;
      break;
    case "no_damage":
      note = <Banner tone="info" title="No damage found by the AI">The report was closed automatically.</Banner>;
      break;
    case "rejected":
      note = (
        <Banner tone="danger" title="Rejected">
          {report.review_note ? <>Reason: {report.review_note}</> : "No reason recorded."}
        </Banner>
      );
      break;
    case "uav_dispatched":
      note = <Banner tone="info" title="UAV dispatched">The UAV is flying to this pothole.</Banner>;
      break;
    case "confirmed":
    case "not_confirmed":
      note = (
        <Banner tone={report.status === "confirmed" ? "success" : "info"} title={label}>
          {report.status === "confirmed" ? "The UAV confirmed the damage." : "The UAV saw no damage."}
        </Banner>
      );
      break;
  }
  if (!note) return null;
  return <PanelSection>{note}</PanelSection>;
}
