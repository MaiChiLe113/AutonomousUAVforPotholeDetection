// Map prop types and geo helpers. No Leaflet import here, so pages can import this during SSR.

import type { Map as LeafletMap } from "leaflet";
import type { ReactNode } from "react";

import type { Waypoint, WaypointAction } from "./types";

/** [lat, lon] in degrees. */
export type LatLng = [number, number];

export interface MapMarker {
  id: string | number;
  position: LatLng;
  /** Dot colour; use REPORT_STATUS[status].color etc. Defaults to the accent blue. */
  color?: string;
  /** Hover tooltip (and accessible title). */
  label?: string;
}

export interface MapPin {
  position: LatLng;
  /** Teardrop colour; defaults to MAP.colors.pin (red). */
  color?: string;
  label?: string;
  /** When true the user can drag the pin; MapView.onPinMove receives the new position. */
  draggable?: boolean;
}

export interface MapWaypoint {
  position: LatLng;
  kind: WaypointAction; // takeoff / land get an arrow icon, fly / survey a small dot
}

export interface MapUav {
  position: LatLng;
  headingDeg: number; // 0 = north, clockwise
  label?: string;
}

export interface MapCircle {
  center: LatLng;
  radiusM: number;
  color?: string;
}

export interface CameraFootprint {
  yawDeg: number; // gimbal yaw (absolute, 0 = north)
  pitchDeg?: number | null; // -90 = straight down; used with altitude to size the cone
  altitudeM?: number | null;
}

/** Target for MapView.flyTo. The map flies when the value changes; change `key` to fly to the same place again. */
export type FlyTarget = LatLng | { center: LatLng; zoom?: number; key?: string | number };

/**
 * Props of <MapView>. Every overlay is optional; positions are [lat, lon].
 * Behaviour props (flyTo, follow, fitKey) keep pins clear of the FloatingPanel unless avoidPanel=false.
 */
export interface MapViewProps {
  /** Wrapper classes. Default "absolute inset-0": fills the nearest positioned parent (the app <main>). */
  className?: string;
  /** Initial view only (later changes are ignored; use flyTo / fitKey). */
  center?: LatLng;
  zoom?: number;

  /** Status dots. */
  markers?: MapMarker[];
  selectedId?: string | number | null;
  onMarkerClick?: (id: string | number) => void;

  /** One teardrop pin (resident pothole pin or the monitor's target). Draggable when pin.draggable. */
  pin?: MapPin | null;
  onPinMove?: (position: LatLng) => void;

  /** Solid blue line (e.g. a flight plan route). */
  route?: LatLng[];
  /** Dashed blue line (planned route on the live dashboard). */
  plannedRoute?: LatLng[];
  /** Waypoint icons: takeoff / land arrows, small dots for fly / survey. */
  waypoints?: MapWaypoint[];
  /** 0-based index of the waypoint to pulse; indexes `waypoints`, else `plannedRoute`, else `route`. */
  highlightWaypoint?: number | null;
  /** Solid dark line of flown positions. */
  trail?: LatLng[];
  /** Translucent circle (survey area). */
  circle?: MapCircle | null;
  /** "H" marker. */
  home?: LatLng | null;
  /** Dashed grey line from the UAV back to home (needs uav + home). */
  homeLine?: boolean;
  /** Arrow marker rotated by heading. */
  uav?: MapUav | null;
  /** Cone from the UAV in the gimbal yaw direction (needs uav). */
  cameraFootprint?: CameraFootprint | null;

  onMapClick?: (position: LatLng) => void;
  flyTo?: FlyTarget | null;
  /** Keep the UAV centred while true. */
  follow?: boolean;
  /** Fired when the user starts dragging the map (turn `follow` off here, like Google Maps). */
  onUserMove?: () => void;
  /**
   * Fit every drawn overlay (route, plannedRoute, trail, waypoints, markers, pin, circle, home, uav)
   * into view whenever this value changes, including on mount. null / undefined = never.
   * "Fit route" button: setFitKey((k) => k + 1). Fit once data loads: fitKey={plan?.id}.
   */
  fitKey?: string | number | null;
  /** Offset fly / fit / follow so targets are not hidden by the FloatingPanel. Default true. */
  avoidPanel?: boolean;
  /** Escape hatch: the Leaflet map instance, once. */
  onReady?: (map: LeafletMap) => void;
  /** Extra react-leaflet layers. They must be client-only (import them via next/dynamic, ssr: false). */
  children?: ReactNode;
}

const EARTH_R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Shortest distance in metres from `p` to the polyline `line` (point-to-segment on a local flat projection
 * around `p`; accurate at city scale, and far-away points still come out far). Infinity for an empty line.
 */
export function distanceToPolylineM(p: LatLng, line: LatLng[]): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return haversineM(p, line[0]);
  const kx = rad(1) * EARTH_R * Math.cos(rad(p[0])); // metres per degree of longitude at p
  const ky = rad(1) * EARTH_R; // metres per degree of latitude
  const xy = (q: LatLng): [number, number] => [(q[1] - p[1]) * kx, (q[0] - p[0]) * ky];
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = xy(line[i - 1]);
    const [bx, by] = xy(line[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** Total length of a polyline in metres. */
export function routeLengthM(points: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineM(points[i - 1], points[i]);
  return total;
}

/** Point `distanceM` metres from `from` along compass bearing `bearingDeg`. */
export function destinationPoint(from: LatLng, bearingDeg: number, distanceM: number): LatLng {
  const d = distanceM / EARTH_R;
  const b = rad(bearingDeg);
  const lat1 = rad(from[0]);
  const lon1 = rad(from[1]);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [deg(lat2), deg(lon2)];
}

/** Normalise any angle to 0-360. */
export const normalizeDeg = (d: number) => ((d % 360) + 360) % 360;

/** FlightPlan.route -> polyline points. */
export const routePoints = (route: Waypoint[]): LatLng[] => route.map((w) => [w.lat, w.lon]);

/** FlightPlan.route -> MapView.waypoints. */
export const routeWaypoints = (route: Waypoint[]): MapWaypoint[] =>
  route.map((w) => ({ position: [w.lat, w.lon], kind: w.action }));

/** "1.2 km" / "350 m". */
export function formatDistance(m: number | null | undefined): string {
  if (m == null || Number.isNaN(m)) return "–";
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}
