"use client";

// UC-M3 review a flight plan (SCRUM-31, SCRUM-27) and UC-M4 "Launch UAV" (SCRUM-33).
// Map: route, takeoff / landing badges, survey circle, target pin. Panel: plan details, decisions, history.

import { useParams, useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import MapView, { type LatLng, type MapCircle, type MapPin } from "@/components/MapView";
import PlanHistory from "@/components/monitor/PlanHistory";
import RoleGate from "@/components/RoleGate";
import StatusBadge from "@/components/StatusBadge";
import {
  Banner,
  Button,
  ButtonLink,
  EmptyState,
  FloatingPanel,
  LoadingState,
  MapControlButton,
  MapControls,
  PanelSection,
  ReasonDialog,
  Stat,
  StatGrid,
} from "@/components/ui";
import {
  ApiError,
  approveFlightPlan,
  dispatchMission,
  getFlightPlan,
  getMission,
  getReport,
  listReportFlightPlans,
  rejectFlightPlan,
  requestPlanChanges,
} from "@/lib/api";
import { MONITOR_ROUTES } from "@/lib/config";
import { formatDateTime, formatDuration } from "@/lib/format";
import { usePoll } from "@/lib/hooks";
import { formatDistance, routePoints, routeWaypoints } from "@/lib/map";
import type { FlightPlan } from "@/lib/types";

export default function FlightPlanPage() {
  return (
    <RoleGate role="monitor">
      <FlightPlanReview />
    </RoleGate>
  );
}

const nullOn404 = (e: unknown) => {
  if (e instanceof ApiError && e.status === 404) return null;
  throw e;
};

/** Survey circle centre when the report is not loaded yet: mean of the survey waypoints. */
function surveyCentre(plan: FlightPlan): LatLng | null {
  const pts = plan.route.filter((w) => w.action === "survey");
  if (pts.length === 0) return null;
  return [pts.reduce((s, w) => s + w.lat, 0) / pts.length, pts.reduce((s, w) => s + w.lon, 0) / pts.length];
}

function FlightPlanReview() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const pid = Number(params.id);
  const validId = Number.isInteger(pid) && pid > 0;

  const planQ = usePoll(() => getFlightPlan(pid).catch(nullOn404), null, { key: pid, enabled: validId });
  // Decisions return the updated plan; keep it locally instead of re-fetching.
  const [local, setLocal] = useState<FlightPlan | null>(null);
  const plan = local && local.id === pid ? local : planQ.data;

  const reportId = plan?.report_id ?? null;
  const { data: report, refresh: refreshReport } = usePoll(() => getReport(reportId!), null, { key: reportId, enabled: reportId !== null });
  const historyQ = usePoll(() => listReportFlightPlans(reportId!), null, { key: reportId, enabled: reportId !== null });
  const missionId = plan?.mission_id ?? null;
  const missionQ = usePoll(() => getMission(missionId!), null, { key: missionId, enabled: missionId !== null });
  const mission = missionQ.data;

  const [busy, setBusy] = useState<"approve" | "launch" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"changes" | "reject" | null>(null);
  const [fitN, setFitN] = useState(0);

  const route = useMemo(() => (plan ? routePoints(plan.route) : undefined), [plan]);
  const waypoints = useMemo(() => (plan ? routeWaypoints(plan.route) : undefined), [plan]);
  const target = useMemo<LatLng | null>(() => (report ? [report.lat, report.lon] : plan ? surveyCentre(plan) : null), [report, plan]);
  const pin = useMemo<MapPin | null>(() => (target ? { position: target, label: reportId ? `Report #${reportId}` : "Target" } : null), [target, reportId]);
  const circle = useMemo<MapCircle | null>(() => (target && plan ? { center: target, radiusM: plan.survey_radius_m } : null), [target, plan]);

  const notFound = !validId || (!planQ.loading && !planQ.error && planQ.data === null);

  function afterDecision(updated: FlightPlan) {
    setLocal(updated);
    historyQ.refresh();
    refreshReport();
  }

  async function onApprove() {
    if (busy) return;
    setBusy("approve");
    setError(null);
    try {
      afterDecision(await approveFlightPlan(pid));
    } catch (e) {
      setError((e as Error).message || "Could not approve the plan.");
    } finally {
      setBusy(null);
    }
  }

  async function onLaunch() {
    if (busy || missionId === null) return;
    setBusy("launch");
    setError(null);
    try {
      await dispatchMission(missionId);
      router.push(MONITOR_ROUTES.dashboard(missionId));
    } catch (e) {
      setError((e as Error).message || "Could not launch the UAV.");
      setBusy(null);
      missionQ.refresh();
    }
  }

  async function onRequestChanges(reason: string) {
    const next = await requestPlanChanges(pid, reason); // returns the NEW proposed plan
    router.push(MONITOR_ROUTES.plan(next.id));
  }

  async function onReject(reason: string) {
    afterDecision(await rejectFlightPlan(pid, reason));
  }

  // ---------------------------------------------------------------- footer actions
  let footer: ReactNode = null;
  if (plan?.status === "proposed") {
    footer = (
      <div className="space-y-2">
        {error && <Banner tone="danger">{error}</Banner>}
        <Button size="lg" fullWidth loading={busy === "approve"} onClick={onApprove}>
          Approve
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" fullWidth disabled={!!busy} onClick={() => setDialog("changes")}>
            Request changes
          </Button>
          <Button variant="danger" fullWidth disabled={!!busy} onClick={() => setDialog("reject")}>
            Reject
          </Button>
        </div>
      </div>
    );
  } else if (plan?.status === "approved" && missionId !== null) {
    footer = (
      <div className="space-y-2">
        {error && <Banner tone="danger">{error}</Banner>}
        {!mission ? (
          missionQ.error ? (
            <Banner tone="danger">{missionQ.error}</Banner>
          ) : (
            <Button size="lg" fullWidth loading>
              Loading mission…
            </Button>
          )
        ) : mission.state === "pending" ? (
          <Button size="lg" fullWidth loading={busy === "launch"} onClick={onLaunch}>
            Launch UAV
          </Button>
        ) : (
          <ButtonLink size="lg" fullWidth href={MONITOR_ROUTES.dashboard(mission.id)}>
            {mission.state === "done" ? "Open mission result" : "Open live dashboard"}
          </ButtonLink>
        )}
      </div>
    );
  } else if (plan?.status === "changes_needed" && report?.latest_plan_id != null && report.latest_plan_id !== plan.id) {
    footer = (
      <ButtonLink size="lg" fullWidth href={MONITOR_ROUTES.plan(report.latest_plan_id)}>
        Open latest plan #{report.latest_plan_id}
      </ButtonLink>
    );
  }

  return (
    <>
      <MapView route={route} waypoints={waypoints} pin={pin} circle={circle} fitKey={plan ? `${plan.id}-${fitN}` : null} />
      {plan && (
        <MapControls>
          <MapControlButton label="Fit route" icon="fit" onClick={() => setFitN((n) => n + 1)} />
        </MapControls>
      )}
      <FloatingPanel
        backHref={reportId ? MONITOR_ROUTES.report(reportId) : MONITOR_ROUTES.home}
        title={validId ? `Flight plan #${pid}` : "Flight plan"}
        subtitle={plan ? `Report #${plan.report_id} · proposed ${formatDateTime(plan.created_at)}` : undefined}
        headerRight={plan ? <StatusBadge status={plan.status} kind="plan" size="md" /> : undefined}
        footer={footer}
      >
        {notFound ? (
          <EmptyState
            title="Flight plan not found"
            description={`There is no flight plan #${params.id}.`}
            action={
              <ButtonLink href={MONITOR_ROUTES.home} variant="secondary">
                Back to the queue
              </ButtonLink>
            }
          />
        ) : !plan ? (
          planQ.error ? (
            <Banner tone="danger" action={<Button size="sm" variant="ghost" onClick={planQ.refresh}>Retry</Button>}>
              {planQ.error}
            </Banner>
          ) : (
            <LoadingState text="Loading flight plan…" />
          )
        ) : (
          <>
            <PanelSection>
              <StatGrid>
                <Stat label="Drone" value={plan.drone_id} />
                <Stat label="Status" value={<StatusBadge status={plan.status} kind="plan" />} />
                <Stat label="Altitude" value={Math.round(plan.altitude_m)} unit="m" />
                <Stat label="Survey radius" value={Math.round(plan.survey_radius_m)} unit="m" />
                <Stat label="Route distance" value={formatDistance(plan.distance_m)} />
                <Stat label="Estimated time" value={formatDuration(plan.estimated_duration_s)} />
              </StatGrid>
              <p className="mt-2 text-xs text-slate-500">
                {plan.route.length} waypoints: takeoff at home, fly to the pothole, survey circle, return and land.
              </p>
            </PanelSection>

            <DecisionNote plan={plan} />

            <PanelSection title="Decision history">
              {historyQ.data ? (
                <PlanHistory plans={historyQ.data} currentId={plan.id} />
              ) : historyQ.error ? (
                <p className="text-sm text-red-700">{historyQ.error}</p>
              ) : (
                <LoadingState text="Loading history…" className="py-3" />
              )}
            </PanelSection>
          </>
        )}
      </FloatingPanel>

      <ReasonDialog
        open={dialog === "changes"}
        tone="primary"
        title="Request changes"
        description="The planner proposes a new version with a different altitude or radius."
        placeholder="For example: fly lower, trees cover the pin"
        submitLabel="Request changes"
        onSubmit={onRequestChanges}
        onClose={() => setDialog(null)}
      />
      <ReasonDialog
        open={dialog === "reject"}
        title={`Reject flight plan #${pid}`}
        description="No mission is created and the report is closed as rejected."
        placeholder="Why should the UAV not fly?"
        submitLabel="Reject plan"
        onSubmit={onReject}
        onClose={() => setDialog(null)}
      />
    </>
  );
}

function DecisionNote({ plan }: { plan: FlightPlan }) {
  const when = plan.decided_at ? formatDateTime(plan.decided_at) : null;
  let note: ReactNode = null;
  switch (plan.status) {
    case "proposed":
      note = <Banner tone="info">Check the route, then approve it, request changes or reject it.</Banner>;
      break;
    case "approved":
      note = (
        <Banner tone="success" title={`Approved${when ? ` ${when}` : ""}`}>
          {plan.mission_id != null ? `Mission #${plan.mission_id} is ready.` : "Mission created."}
        </Banner>
      );
      break;
    case "changes_needed":
      note = (
        <Banner tone="warning" title={`Changes requested${when ? ` ${when}` : ""}`}>
          {plan.decision_reason ? <>Reason: {plan.decision_reason}</> : null}
        </Banner>
      );
      break;
    case "rejected":
      note = (
        <Banner tone="danger" title={`Rejected${when ? ` ${when}` : ""}`}>
          {plan.decision_reason && <p>Reason: {plan.decision_reason}</p>}
          <p>No mission was created; the report is closed.</p>
        </Banner>
      );
      break;
  }
  return <PanelSection>{note}</PanelSection>;
}
