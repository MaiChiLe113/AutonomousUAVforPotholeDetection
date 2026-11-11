"use client";

// Full-bleed Leaflet map (CARTO Voyager tiles). Safe to import from any client page: the Leaflet
// code loads in the browser only (next/dynamic, ssr: false), so no extra dynamic() is needed.
//
//   <main> (relative)                                  <- AppShell provides this
//     <MapView markers={...} fitKey={...} />           <- fills it (className "absolute inset-0")
//     <FloatingPanel title="...">...</FloatingPanel>    <- left card / bottom sheet on top
//     <MapControls><MapControlButton .../></MapControls>
//
// Props are documented on MapViewProps in lib/map.ts. Summary:
//   overlays   markers (+selectedId, onMarkerClick), pin (+onPinMove when draggable), route (solid),
//              plannedRoute (dashed), waypoints, highlightWaypoint, trail, circle, home (+homeLine),
//              uav (rotated by headingDeg), cameraFootprint
//   behaviour  onMapClick, flyTo (flies when the value changes), follow (+onUserMove on drag),
//              fitKey (fit all overlays when it changes), avoidPanel (default true), onReady(map)

import dynamic from "next/dynamic";

import { cn } from "@/lib/cn";
import type { MapViewProps } from "@/lib/map";

export type {
  CameraFootprint,
  FlyTarget,
  LatLng,
  MapCircle,
  MapMarker,
  MapPin,
  MapUav,
  MapViewProps,
  MapWaypoint,
} from "@/lib/map";

const LeafletMap = dynamic(() => import("./ui/LeafletMap"), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-slate-100" aria-label="Loading map" />,
});

export default function MapView({ className, ...props }: MapViewProps) {
  // `isolate` keeps Leaflet's internal z-indexes (400-1000) below floating panels and dialogs.
  // `map-root` scopes the phone attribution rule in globals.css (attribution top-left below 768 px).
  return (
    <div className={cn("map-root isolate overflow-hidden bg-slate-100", className ?? "absolute inset-0")}>
      <LeafletMap {...props} />
    </div>
  );
}
