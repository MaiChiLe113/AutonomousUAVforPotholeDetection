"use client";

// Small live map on a UAV card: the UAV (rotated by heading), its target pin and the base, centred on the UAV.
// Display only (no dragging or zoom); the whole map links to the Digital twin following this UAV.

import Link from "next/link";

import MapView, { type LatLng, type MapViewProps } from "@/components/MapView";
import { Icon } from "@/components/ui";
import { MONITOR, MONITOR_ROUTES } from "@/lib/config";
import type { Drone } from "@/lib/types";

const staticMap: MapViewProps["onReady"] = (map) => {
  map.dragging.disable();
  map.touchZoom.disable();
  map.doubleClickZoom.disable();
  map.scrollWheelZoom.disable();
  map.boxZoom.disable();
  map.keyboard.disable();
};

export default function UavMiniMap({ drone, base }: { drone: Drone; base: LatLng }) {
  const position: LatLng = [drone.position.lat, drone.position.lon];
  const away = drone.status === "flying" || drone.status === "returning";
  return (
    <div className="relative h-32 overflow-hidden rounded-xl border border-slate-200">
      <MapView
        className="absolute inset-0 [&_.leaflet-control-zoom]:hidden" // display only: no zoom buttons
        center={position}
        zoom={MONITOR.uavMiniMapZoom}
        uav={{ position, headingDeg: drone.heading_deg, label: drone.drone_id }}
        pin={drone.target ? { position: [drone.target.lat, drone.target.lon], label: "Target" } : null}
        home={base}
        homeLine={away}
        follow
        avoidPanel={false}
        onReady={staticMap}
      />
      <Link
        href={MONITOR_ROUTES.dashboardDrone(drone.drone_id)}
        aria-label={`Watch ${drone.drone_id} on the digital twin`}
        className="group absolute inset-0 z-10 flex items-end justify-end p-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
      >
        <span className="flex items-center gap-1 rounded-full bg-white/95 px-2.5 py-1 text-xs font-medium text-slate-900 shadow-sm group-hover:text-accent">
          <Icon name="map" size={14} />
          Watch on map
        </span>
      </Link>
    </div>
  );
}
