"use client";

// Digital twin tab (/monitor/dashboard/map): the district in 3D (MapLibre, extruded OSM buildings) with the base,
// the 2 km service ring, every UAV and the queued report pins, all from GET /fleet.
// Selecting a UAV (marker) or a report pin opens it in a FloatingPanel. Controls: Reset view, 2D / 3D, Follow UAV.
// If WebGL or the 3D style is unavailable it falls back to the flat Leaflet map (Fit district, Follow UAV).

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";

import MapView, { type LatLng, type MapFleetUav } from "@/components/MapView";
import StatusBadge from "@/components/StatusBadge";
import { Banner, ButtonLink, Chip, FloatingPanel, LoadingState, MapControlButton, MapControls } from "@/components/ui";
import type { TwinPin, TwinUav } from "@/components/ui/TwinMap";
import { DRONE_STATUS, MAP, MONITOR_ROUTES, TASK_STATUS, TWIN } from "@/lib/config";
import { circleBounds, DISTRICT_SERVICE_AREA, DISTRICT_VIEW, type MapServiceArea, type MapStation } from "@/lib/map";
import type { Drone } from "@/lib/types";

import { useFleet } from "./FleetContext";
import UavCard from "./UavCard";
import { useFleetActions } from "./useFleetActions";

// Client-only: maplibre-gl touches `window` at import time.
const TwinMap = dynamic(() => import("@/components/ui/TwinMap"), {
  ssr: false,
  loading: () => <LoadingState className="absolute inset-0" text="Loading 3D map…" />,
});

export default function FleetMap() {
  const { data: fleet, error, loading, refresh } = useFleet();
  const actions = useFleetActions(refresh);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);
  const [fitN, setFitN] = useState(0);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [flat, setFlat] = useState(false);
  const [twinFailure, setTwinFailure] = useState<string | null>(null); // set: show the flat map instead

  const serviceArea = useMemo<MapServiceArea>(
    () =>
      fleet
        ? { center: [fleet.district.center.lat, fleet.district.center.lon], radiusM: fleet.district.radius_m, label: fleet.district.name }
        : DISTRICT_SERVICE_AREA,
    [fleet],
  );
  const bounds = useMemo(
    () => (fleet ? circleBounds(serviceArea.center, serviceArea.radiusM, MAP.district.boundsPaddingM) : DISTRICT_VIEW.maxBounds),
    [fleet, serviceArea],
  );
  // The 2 km circle itself (no padding): "Fit district" and the first view fill the pane with it.
  const fitBounds = useMemo(() => circleBounds(serviceArea.center, serviceArea.radiusM), [serviceArea]);
  const stations = useMemo<MapStation[]>(() => (fleet ? [{ id: "base", position: [fleet.base.lat, fleet.base.lon], label: "UAV base" }] : []), [fleet]);
  const uavs = useMemo<MapFleetUav[]>(
    () =>
      (fleet?.drones ?? []).map((d) => ({
        id: d.drone_id,
        position: [d.position.lat, d.position.lon] as LatLng,
        headingDeg: d.heading_deg,
        color: DRONE_STATUS[d.status].color,
        label: `${d.drone_id} · ${DRONE_STATUS[d.status].label} · ${Math.round(d.battery_pct)}%`,
      })),
    [fleet],
  );

  const twinUavs = useMemo<TwinUav[]>(
    () =>
      (fleet?.drones ?? []).map((d) => ({
        id: d.drone_id,
        position: [d.position.lat, d.position.lon] as LatLng,
        headingDeg: d.heading_deg,
        color: DRONE_STATUS[d.status].color,
        label: `${d.drone_id} · ${Math.round(d.battery_pct)}%`,
      })),
    [fleet],
  );
  const twinPins = useMemo<TwinPin[]>(
    () =>
      (fleet?.queue ?? [])
        .filter((t) => TWIN.pinStatuses.includes(t.status))
        .map((t) => ({ id: String(t.task_id), position: [t.lat, t.lon] as LatLng, color: TASK_STATUS[t.status].color })),
    [fleet],
  );

  const selected: Drone | null = fleet?.drones.find((d) => d.drone_id === selectedId) ?? null;
  const selectedTask = fleet?.queue.find((t) => String(t.task_id) === selectedPinId) ?? null;
  const twin = twinFailure === null;

  const selectUav = (id: string | null) => {
    setSelectedId(id);
    setSelectedPinId(null);
    if (id === null) setFollow(false);
  };

  if (loading && !fleet && !error) return <LoadingState className="absolute inset-0" text="Loading fleet…" />;

  return (
    <>
      {twin ? (
        <TwinMap
          // The bounds are read once when the map is created, so a different district is a new map.
          key={`${serviceArea.center[0]},${serviceArea.center[1]},${serviceArea.radiusM}`}
          district={{ center: serviceArea.center, radiusM: serviceArea.radiusM }}
          base={fleet ? [fleet.base.lat, fleet.base.lon] : serviceArea.center}
          uavs={twinUavs}
          pins={twinPins}
          selectedUavId={selectedId}
          selectedPinId={selectedPinId}
          onUavClick={selectUav}
          onPinClick={(id) => {
            setSelectedPinId(id);
            setSelectedId(null);
            setFollow(false);
          }}
          follow={follow && !!selected}
          onUserMove={() => setFollow(false)}
          resetKey={fitN}
          flat={flat}
          avoidPanel={!!selected || !!selectedTask}
          onFail={setTwinFailure}
        />
      ) : (
        <MapView
          // The bounds are read once when the map is created, so a different district is a new map.
          key={`${serviceArea.center[0]},${serviceArea.center[1]},${serviceArea.radiusM}`}
          center={serviceArea.center}
          maxBounds={bounds}
          minZoom={DISTRICT_VIEW.minZoom}
          serviceArea={serviceArea}
          stations={stations}
          uavs={uavs}
          selectedUavId={selectedId}
          onUavClick={(id) => selectUav(id)}
          follow={follow && !!selected}
          onUserMove={() => setFollow(false)}
          fitKey={`district-${fitN}`}
          fitBoundsTo={fitBounds}
          avoidPanel={!!selected}
        />
      )}

      <MapControls>
        <Chip title="The UAVs are simulated; buildings come from OpenStreetMap">{twin ? TWIN.chipLabel : "Simulated UAVs"}</Chip>
        {twin ? (
          <>
            <MapControlButton
              label="Reset view"
              icon="fit"
              onClick={() => {
                setFlat(false);
                setFitN((n) => n + 1);
              }}
            />
            <MapControlButton label={flat ? "3D view" : "2D view"} icon="map" active={flat} onClick={() => setFlat((f) => !f)} />
          </>
        ) : (
          <MapControlButton label="Fit district" icon="fit" onClick={() => setFitN((n) => n + 1)} />
        )}
        <MapControlButton label="Follow UAV" icon="locate" active={follow && !!selected} disabled={!selected} onClick={() => setFollow((f) => !f)} />
      </MapControls>

      {!twin && (
        <div className="absolute bottom-3 left-3 z-10 max-w-sm max-md:hidden">
          <Banner tone="info">3D view unavailable ({twinFailure}). Showing the flat map.</Banner>
        </div>
      )}

      {error && (
        <div className="absolute top-3 left-3 z-10 max-w-[calc(100%-11rem)] md:max-w-sm">
          <Banner tone="danger">{error}</Banner>
        </div>
      )}

      {selected && (
        <FloatingPanel
          title={selected.drone_id}
          subtitle="UAV"
          onBack={() => selectUav(null)}
        >
          <UavCard drone={selected} framed={false} onRecall={actions.askRecall} />
        </FloatingPanel>
      )}
      {selectedTask && (
        <FloatingPanel
          title={`Report #${selectedTask.report_id}`}
          subtitle="Inspection task"
          headerRight={<StatusBadge status={selectedTask.status} kind="task" />}
          onBack={() => setSelectedPinId(null)}
          footer={
            <ButtonLink fullWidth variant="secondary" href={MONITOR_ROUTES.report(selectedTask.report_id)}>
              Open report
            </ButtonLink>
          }
        >
          <p className="text-sm text-slate-700">Priority {selectedTask.priority}</p>
          {selectedTask.hold_reason ? (
            <Banner tone="warning" title="Held" className="mt-2">
              {selectedTask.hold_reason}
            </Banner>
          ) : (
            <p className="mt-1 text-sm text-slate-500">No hold reason: a UAV takes it as soon as one is cleared to fly.</p>
          )}
        </FloatingPanel>
      )}
      {actions.dialog}
    </>
  );
}
