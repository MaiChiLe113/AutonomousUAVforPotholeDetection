"use client";

// UC-M4 live dashboard for one mission (SCRUM-39, SCRUM-33) + UC-M5 camera card.
// Telemetry every SIM.telemetryPollMs until done; the map shows the UAV (rotated by heading), the client-side
// trail, the dashed plan with the next waypoint highlighted, target + survey circle, home + home line, camera cone.
// The map is the 3D digital twin (TwinMap), following the UAV from the start; without WebGL or the 3D style it
// falls back to the flat Leaflet map.

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import MapView, { type CameraFootprint, type LatLng, type MapCircle, type MapPin, type MapUav } from "@/components/MapView";
import StatusBadge from "@/components/StatusBadge";
import type { TwinMission, TwinUav } from "@/components/ui/TwinMap";
import {
  Banner,
  Button,
  ButtonLink,
  Chip,
  EmptyState,
  FloatingPanel,
  LoadingState,
  MapControlButton,
  MapControls,
  PanelSection,
  ProgressBar,
} from "@/components/ui";
import { ApiError, dispatchMission, getFlightPlan, getMission, getReport, listMissionDetections } from "@/lib/api";
import { DECISION_ACTION, FLYING_STATES, MAP, MISSION_STATE, MONITOR, MONITOR_ROUTES, SIM } from "@/lib/config";
import { formatDateTime, formatPct } from "@/lib/format";
import { usePoll } from "@/lib/hooks";
import { DISTRICT_SERVICE_AREA, DISTRICT_STATIONS, routePoints, routeWaypoints } from "@/lib/map";

import CameraCard from "./CameraCard";
import DetectionRows from "./DetectionRows";
import { useFleet } from "./fleet/FleetContext";
import { FlightData, MissionStepper, SignalStatus, batteryLevel } from "./FlightStatus";
import { useTelemetry, useTrail } from "./telemetry";

// Client-only: maplibre-gl touches `window` at import time.
const TwinMap = dynamic(() => import("@/components/ui/TwinMap"), {
  ssr: false,
  loading: () => <LoadingState className="absolute inset-0" text="Loading 3D map…" />,
});

const nullOn404 = (e: unknown) => {
  if (e instanceof ApiError && e.status === 404) return null;
  throw e;
};

export default function MissionDashboard({ missionId }: { missionId: number }) {
  const missionQ = usePoll(() => getMission(missionId).catch(nullOn404), null, { key: missionId });
  const mission = missionQ.data;
  const refreshMission = missionQ.refresh;

  const { telemetry, error: teleError, notFound: teleNotFound, final } = useTelemetry(missionId);

  const planId = mission?.flight_plan_id ?? null;
  const { data: plan } = usePoll(() => getFlightPlan(planId!), null, { key: planId, enabled: planId !== null });
  const reportId = mission?.report_id ?? null;
  const { data: report, refresh: refreshReport } = usePoll(() => getReport(reportId!), null, { key: reportId, enabled: reportId !== null });
  const detQ = usePoll(() => listMissionDetections(missionId), null, { key: missionId, enabled: final });

  // At done the backend has stored the edge result and the report's final status: read them again.
  useEffect(() => {
    if (final) {
      refreshReport();
      refreshMission();
    }
  }, [final, refreshReport, refreshMission]);

  const [follow, setFollow] = useState(true); // watch the UAV fly from the start; dragging the map stops it
  const [fitN, setFitN] = useState(0);
  const [flat, setFlat] = useState(false);
  const [twinFailure, setTwinFailure] = useState<string | null>(null); // set: show the flat map instead
  const twin = twinFailure === null;
  const { data: fleet } = useFleet(); // district and base for the 3D map (config defaults until it answers)
  const [launching, setLaunching] = useState(false);
  const [launched, setLaunched] = useState(false); // hide "Launch UAV" until telemetry leaves "pending"
  const [launchError, setLaunchError] = useState<string | null>(null);

  const state = telemetry?.state ?? mission?.state ?? "pending";
  const flying = FLYING_STATES.includes(state);

  // ---------------------------------------------------------------- map layers (memoised per reading)
  const plannedRoute = useMemo(() => (plan ? routePoints(plan.route) : undefined), [plan]);
  const trail = useTrail(telemetry, plannedRoute);
  const waypoints = useMemo(() => (plan ? routeWaypoints(plan.route) : undefined), [plan]);
  const target = useMemo<LatLng | null>(() => (report ? [report.lat, report.lon] : null), [report]);
  const pin = useMemo<MapPin | null>(() => (target ? { position: target, label: `Pothole · report #${reportId}` } : null), [target, reportId]);
  const circle = useMemo<MapCircle | null>(() => (target && plan ? { center: target, radiusM: plan.survey_radius_m } : null), [target, plan]);
  const droneId = telemetry?.drone_id ?? mission?.drone_id ?? plan?.drone_id ?? "UAV";
  const uav = useMemo<MapUav | null>(
    () => (telemetry ? { position: [telemetry.lat, telemetry.lon], headingDeg: telemetry.heading_deg, label: droneId } : null),
    [telemetry, droneId],
  );
  const home = useMemo<LatLng | null>(
    () => (telemetry?.home_lat != null && telemetry.home_lon != null ? [telemetry.home_lat, telemetry.home_lon] : null),
    [telemetry],
  );
  const footprint = useMemo<CameraFootprint | null>(
    () =>
      telemetry && flying && telemetry.gimbal_yaw_deg != null
        ? { yawDeg: telemetry.gimbal_yaw_deg, pitchDeg: telemetry.gimbal_pitch_deg, altitudeM: telemetry.altitude_m }
        : null,
    [telemetry, flying],
  );
  const highlight = flying && telemetry?.current_waypoint != null ? telemetry.current_waypoint : null;

  // ---------------------------------------------------------------- the same layers on the 3D map
  const district = useMemo(
    () =>
      fleet
        ? { center: [fleet.district.center.lat, fleet.district.center.lon] as LatLng, radiusM: fleet.district.radius_m }
        : { center: DISTRICT_SERVICE_AREA.center, radiusM: DISTRICT_SERVICE_AREA.radiusM },
    [fleet],
  );
  const base: LatLng = fleet ? [fleet.base.lat, fleet.base.lon] : DISTRICT_STATIONS[0].position;
  const batteryPct = telemetry?.battery_pct;
  const twinUavs = useMemo<TwinUav[]>(
    () =>
      uav
        ? [
            {
              id: droneId,
              position: uav.position,
              headingDeg: uav.headingDeg,
              color: MAP.colors.uav,
              label: batteryPct != null ? `${droneId} · ${Math.round(batteryPct)}%` : droneId,
            },
          ]
        : [],
    [uav, droneId, batteryPct],
  );
  const twinMission = useMemo<TwinMission>(
    () => ({
      uavId: droneId,
      plannedRoute,
      trail,
      waypoints,
      highlightWaypoint: highlight,
      target,
      surveyCircle: circle,
      home,
      homeLine: flying && !!home,
      footprint,
    }),
    [droneId, plannedRoute, trail, waypoints, highlight, target, circle, home, flying, footprint],
  );
  const fitPoints = useMemo(() => [...(plannedRoute ?? []), ...(target ? [target] : [])], [plannedRoute, target]);

  const notFound = teleNotFound || (!missionQ.loading && !missionQ.error && mission === null);

  async function onLaunch() {
    if (launching) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      await dispatchMission(missionId);
      setLaunched(true);
      refreshMission();
      refreshReport();
    } catch (e) {
      setLaunchError((e as Error).message || "Could not launch the UAV.");
    } finally {
      setLaunching(false);
    }
  }

  if (notFound) {
    return (
      <>
        <MapView />
        <FloatingPanel backHref={MONITOR_ROUTES.dashboard()} title={`Mission #${missionId}`}>
          <EmptyState
            title="Mission not found"
            description={`There is no mission #${missionId}.`}
            action={
              <ButtonLink href={MONITOR_ROUTES.dashboard()} variant="secondary">
                Show active missions
              </ButtonLink>
            }
          />
        </FloatingPanel>
      </>
    );
  }

  const battery = telemetry?.battery_pct;
  const total = plan?.route.length ?? null;
  const wp = telemetry?.current_waypoint;
  const progress = telemetry?.progress_pct ?? (state === "done" ? 100 : 0);
  const result = report?.status === "confirmed" || report?.status === "not_confirmed" ? report.status : null;

  const footer =
    state === "pending" && telemetry && !launched ? (
      <div className="space-y-2">
        {launchError && <Banner tone="danger">{launchError}</Banner>}
        <Button size="lg" fullWidth loading={launching} onClick={onLaunch}>
          Launch UAV
        </Button>
      </div>
    ) : undefined;

  return (
    <>
      {twin ? (
        <TwinMap
          // The bounds are read once when the map is created, so a different district is a new map.
          key={`${district.center[0]},${district.center[1]},${district.radiusM}`}
          district={district}
          base={base}
          uavs={twinUavs}
          pins={[]}
          selectedUavId={uav ? droneId : null}
          selectedPinId={null}
          onUavClick={() => setFollow(true)}
          onPinClick={() => undefined}
          follow={follow && !!uav}
          onUserMove={() => setFollow(false)}
          resetKey={fitN}
          fitPoints={fitPoints}
          flat={flat}
          avoidPanel
          mission={twinMission}
          glideMs={SIM.telemetryPollMs}
          onFail={setTwinFailure}
        />
      ) : (
        <MapView
          plannedRoute={plannedRoute}
          waypoints={waypoints}
          highlightWaypoint={highlight}
          trail={trail}
          pin={pin}
          circle={circle}
          home={home}
          homeLine={flying && !!home}
          uav={uav}
          cameraFootprint={footprint}
          follow={follow}
          onUserMove={() => setFollow(false)}
          fitKey={plan && report ? `${missionId}-${fitN}` : null}
        />
      )}
      <MapControls>
        {twin && <MapControlButton label={flat ? "3D view" : "2D view"} icon="map" active={flat} onClick={() => setFlat((f) => !f)} />}
        <MapControlButton label="Follow UAV" icon="locate" active={follow} disabled={!uav} onClick={() => setFollow((f) => !f)} />
        <MapControlButton
          label="Fit route"
          icon="fit"
          disabled={!plan}
          onClick={() => {
            setFollow(false);
            setFitN((n) => n + 1);
          }}
        />
      </MapControls>

      <FloatingPanel
        backHref={MONITOR_ROUTES.dashboard()}
        title={droneId}
        subtitle={
          <>
            Mission #{missionId}
            {reportId !== null && (
              <>
                {" · "}
                <Link href={MONITOR_ROUTES.report(reportId)} className="text-accent hover:underline">
                  Report #{reportId}
                </Link>
              </>
            )}
          </>
        }
        headerRight={
          telemetry?.in_mission != null ? (
            <Chip color={telemetry.in_mission ? MONITOR.inMissionColors.active : MONITOR.inMissionColors.idle}>{telemetry.in_mission ? "In mission" : "Idle"}</Chip>
          ) : undefined
        }
        footer={footer}
      >
        {!telemetry ? (
          teleError ? (
            <Banner tone="danger" title="No telemetry">
              {teleError}
            </Banner>
          ) : (
            <LoadingState text="Connecting to the UAV…" />
          )
        ) : (
          <>
            {batteryLevel(battery) === "critical" && (
              <Banner tone="danger" title="Battery low - return home" className="mb-3">
                Battery at {formatPct(battery)}. This is a warning only; no command is sent to the UAV.
              </Banner>
            )}

            <PanelSection>
              <MissionStepper state={state} />
              <ProgressBar className="mt-3" label="Progress" value={progress} valueText={formatPct(progress)} />
              <div className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
                <span className="font-medium text-slate-900 tabular-nums">
                  Waypoint {wp != null ? wp + 1 : "–"} / {total ?? "–"}
                </span>
                <SignalStatus telemetry={telemetry} failed={!!teleError} />
              </div>
              {state === "failed" && (
                // Recalled (weather, monitor) or aborted (edge, offline): say which and why, from the decision log.
                <Banner
                  tone="danger"
                  title={mission?.end_action ? DECISION_ACTION[mission.end_action].label : `Mission ${MISSION_STATE.failed.label.toLowerCase()}`}
                  className="mt-3"
                >
                  {mission?.end_reason ?? "The flight ended before the survey was finished."}
                  {mission?.finished_at ? ` (${formatDateTime(mission.finished_at)})` : ""}
                </Banner>
              )}
            </PanelSection>

            {final && state !== "failed" && (
              <PanelSection title="Result" action={result ? <StatusBadge status={result} kind="report" size="md" /> : undefined}>
                {result === "confirmed" ? (
                  <Banner tone="success" title="Confirmed">
                    The UAV&apos;s edge device found the damage{mission?.finished_at ? ` (landed ${formatDateTime(mission.finished_at)})` : ""}.
                  </Banner>
                ) : result === "not_confirmed" ? (
                  <Banner tone="info" title="Not confirmed">
                    No damage seen by the UAV{mission?.finished_at ? ` (landed ${formatDateTime(mission.finished_at)})` : ""}.
                  </Banner>
                ) : (
                  <LoadingState text="Reading the result…" className="py-3" />
                )}
                <div className="mt-3">
                  <h3 className="mb-1 text-sm font-medium text-slate-700">Edge detections</h3>
                  {detQ.data ? (
                    detQ.data.length === 0 ? (
                      <p className="text-sm text-slate-600">No damage seen by the UAV.</p>
                    ) : (
                      <DetectionRows detections={detQ.data} variant="edge" />
                    )
                  ) : detQ.error ? (
                    <p className="text-sm text-red-700">{detQ.error}</p>
                  ) : (
                    <LoadingState text="Loading detections…" className="py-3" />
                  )}
                </div>
              </PanelSection>
            )}

            {final && <CameraCard missionId={missionId} missionState={state} telemetry={telemetry} photoUrl={report?.photo_url ?? null} />}

            <PanelSection title={final ? "Last flight data" : "Flight data"}>
              <FlightData t={telemetry} />
            </PanelSection>

            {!final && <CameraCard missionId={missionId} missionState={state} telemetry={telemetry} photoUrl={report?.photo_url ?? null} />}
          </>
        )}
      </FloatingPanel>
    </>
  );
}
