"use client";

// 3D digital twin of the district (MapLibre GL + OpenFreeMap vector tiles with extruded OSM buildings).
// Used by the monitor Digital twin tab (FleetMap) and the live mission view (MissionDashboard, with `mission`
// overlays); every other page keeps the Leaflet map. Never import this file directly: it touches `window` at
// import time. Load it with next/dynamic (ssr: false), as FleetMap does.
//
// One map instance for the whole life of the component: the fleet updates move the markers and replace the GeoJSON
// data, they never re-create the map. UAV markers glide between two polls. If WebGL or the style fails to load,
// `onFail` is called once so the parent can show the flat map instead.

import "maplibre-gl/dist/maplibre-gl.css";

import { LngLatBounds, Map as MapLibreMap, Marker, Popup, setWorkerUrl } from "maplibre-gl";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { MAP, MONITOR, TWIN } from "@/lib/config";
import {
  circleBounds,
  destinationPoint,
  footprintPolygon,
  type CameraFootprint,
  type LatLng,
  type MapCircle,
  type MapWaypoint,
} from "@/lib/map";

export interface TwinUav {
  id: string;
  position: LatLng;
  headingDeg: number;
  color: string;
  label: string; // "sim-uav-1 · 72%"
}

export interface TwinPin {
  id: string;
  position: LatLng;
  color: string;
}

/** One mission drawn on the twin (the live mission view): the same overlays as the flat map. */
export interface TwinMission {
  /** The UAV in `uavs` the camera cone and home line start from; they move with its gliding marker. */
  uavId: string;
  plannedRoute?: LatLng[];
  trail?: LatLng[];
  waypoints?: MapWaypoint[];
  /** Index into `waypoints` of the one the UAV is heading to. */
  highlightWaypoint?: number | null;
  target?: LatLng | null;
  surveyCircle?: MapCircle | null;
  home?: LatLng | null;
  homeLine?: boolean;
  footprint?: CameraFootprint | null;
}

export interface TwinMapProps {
  district: { center: LatLng; radiusM: number };
  base: LatLng;
  uavs: TwinUav[];
  pins: TwinPin[];
  selectedUavId: string | null;
  selectedPinId: string | null;
  onUavClick: (id: string) => void;
  onPinClick: (id: string) => void;
  /** Keep the selected UAV centred (and zoomed in) while true. */
  follow: boolean;
  /** The user started dragging the map: turn `follow` off. */
  onUserMove: () => void;
  /** Fit the district (or `fitPoints`) again whenever this number changes. */
  resetKey: number;
  /** When set, a reset fits these points instead of the district (the live view's "Fit route"). */
  fitPoints?: LatLng[] | null;
  /** Mission overlays: route, trail, waypoints, target, survey circle, home line, camera cone. */
  mission?: TwinMission | null;
  /** How long a UAV marker glides to a new position: the poll interval of `uavs` (default MONITOR.fleetPollMs). */
  glideMs?: number;
  /** Card anchored above a point (the selected report dot). `id` identifies it: a new id is a new popup. */
  popup?: { id: string; position: LatLng; content: ReactNode } | null;
  /** The popup's close button, or a click on the map away from every dot. */
  onPopupClose?: () => void;
  /** true = top-down (pitch 0, north up); false = the angled 3D view. */
  flat: boolean;
  /** Leave room for the FloatingPanel when fitting the district. */
  avoidPanel: boolean;
  /** WebGL unsupported, or the style did not load. Called at most once. */
  onFail: (reason: string) => void;
}

// maplibre-gl derives its worker URL from import.meta.url, which a bundler rewrites to a file: URL.
// Emit the worker file as a static asset and point maplibre at it.
setWorkerUrl(new URL("../../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).href);

// ------------------------------------------------------------------ helpers

type LngLat = [number, number];
const lngLat = ([lat, lon]: LatLng): LngLat => [lon, lat];

const toBounds = ([[s, w], [n, e]]: [LatLng, LatLng]) => new LngLatBounds([w, s], [e, n]);

function ringPolygon(center: LatLng, radiusM: number, properties: GeoJSON.GeoJsonProperties = {}): GeoJSON.Feature<GeoJSON.Polygon> {
  const n = TWIN.ring.segments;
  const coords: LngLat[] = [];
  for (let i = 0; i <= n; i++) coords.push(lngLat(destinationPoint(center, (360 * (i % n)) / n, radiusM)));
  return { type: "Feature", properties, geometry: { type: "Polygon", coordinates: [coords] } };
}

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const lineFeature = (kind: string, pts: LatLng[]): GeoJSON.Feature => ({
  type: "Feature",
  properties: { kind },
  geometry: { type: "LineString", coordinates: pts.map(lngLat) },
});

const pointFeature = (properties: GeoJSON.GeoJsonProperties, p: LatLng): GeoJSON.Feature => ({
  type: "Feature",
  properties,
  geometry: { type: "Point", coordinates: lngLat(p) },
});

/** Mission layers that change only with a new poll: survey circle, planned route, trail, waypoints, target. */
function missionCollection(m: TwinMission | null | undefined): GeoJSON.FeatureCollection {
  if (!m) return EMPTY;
  const features: GeoJSON.Feature[] = [];
  if (m.surveyCircle) features.push(ringPolygon(m.surveyCircle.center, m.surveyCircle.radiusM, { kind: "survey" }));
  if (m.plannedRoute && m.plannedRoute.length > 1) features.push(lineFeature("planned", m.plannedRoute));
  if (m.trail && m.trail.length > 1) features.push(lineFeature("trail", m.trail));
  m.waypoints?.forEach((w, i) => {
    const endpoint = w.kind === "takeoff" || w.kind === "land" ? 1 : 0;
    features.push(pointFeature({ kind: "waypoint", endpoint, highlight: i === m.highlightWaypoint ? 1 : 0 }, w.position));
  });
  if (m.target) features.push(pointFeature({ kind: "target" }, m.target));
  return { type: "FeatureCollection", features };
}

/** Layers attached to the gliding UAV marker (redrawn every animation frame): camera cone and home line. */
function liveCollection(m: TwinMission | null | undefined, uav: LngLat | null): GeoJSON.FeatureCollection {
  if (!m || !uav) return EMPTY;
  const from: LatLng = [uav[1], uav[0]];
  const features: GeoJSON.Feature[] = [];
  if (m.footprint) {
    const cone = [...footprintPolygon(from, m.footprint.yawDeg, m.footprint.pitchDeg, m.footprint.altitudeM), from];
    features.push({ type: "Feature", properties: { kind: "cone" }, geometry: { type: "Polygon", coordinates: [cone.map(lngLat)] } });
  }
  if (m.homeLine && m.home) features.push(lineFeature("home", [from, m.home]));
  return { type: "FeatureCollection", features };
}

type GeoSource = { setData: (d: GeoJSON.FeatureCollection) => void } | undefined;
const isKind = (kind: string): ["==", ["get", string], string] => ["==", ["get", "kind"], kind];

function pinCollection(pins: TwinPin[], selectedId: string | null): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: pins.map((p) => ({
      type: "Feature",
      properties: { id: p.id, color: p.color, selected: p.id === selectedId ? 1 : 0 },
      geometry: { type: "Point", coordinates: lngLat(p.position) },
    })),
  };
}

/** Space the FloatingPanel covers (same rule as the Leaflet map: left card on desktop, bottom sheet on phones). */
function panelInsets(map: MapLibreMap, avoidPanel: boolean) {
  if (!avoidPanel) return { left: 0, bottom: 0 };
  const el = map.getContainer();
  const desktop = window.matchMedia(`(min-width: ${MAP.panel.desktopMinWidthPx}px)`).matches;
  if (desktop) return { left: el.clientWidth >= MAP.panel.desktopInsetPx * 1.6 ? MAP.panel.desktopInsetPx : 0, bottom: 0 };
  return { left: 0, bottom: Math.round(el.clientHeight * MAP.panel.mobileSheetFraction) };
}

const shortestDelta = (from: number, to: number) => ((((to - from) % 360) + 540) % 360) - 180;

const UAV_SVG = (size: number) =>
  `<svg viewBox="0 0 40 40" width="${size}" height="${size}" aria-hidden="true">` +
  `<circle class="twin-uav__halo" cx="20" cy="20" r="18"/>` +
  `<path class="twin-uav__arrow" d="M20 5 L30 32 L20 26 L10 32 Z" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/></svg>`;

interface UavState {
  marker: Marker;
  el: HTMLElement;
  arrow: HTMLElement;
  label: HTMLElement;
  from: LngLat;
  to: LngLat;
  cur: LngLat;
  fromHeading: number;
  toHeading: number;
  curHeading: number;
  t0: number;
}

// ------------------------------------------------------------------ component

export default function TwinMap(props: TwinMapProps) {
  const { uavs, pins, selectedUavId, selectedPinId, follow, resetKey, flat } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [readyMap, setReadyMap] = useState<MapLibreMap | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const uavStates = useRef(new Map<string, UavState>());
  const raf = useRef(0);
  const followEaseUntil = useRef(0); // performance.now() when the follow zoom-in ends

  // Latest props for callbacks that outlive a render (map events, animation frames).
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  const fitDistrict = (map: MapLibreMap, animate: boolean) => {
    const { district, avoidPanel, flat: isFlat } = latest.current;
    const insets = panelInsets(map, avoidPanel);
    const pad = TWIN.fitPaddingPx;
    const view = {
      padding: { top: pad, right: pad, bottom: pad + insets.bottom, left: pad + insets.left },
      pitch: isFlat ? TWIN.flatPitch : TWIN.pitch,
      bearing: isFlat ? TWIN.flatBearing : TWIN.bearing,
    };
    const cam = map.cameraForBounds(toBounds(circleBounds(district.center, district.radiusM)), { padding: view.padding });
    if (!cam) return;
    // The fit ignores the tilt: back off a little so the far side of a tilted ring stays in view.
    const zoom = (cam.zoom ?? TWIN.initialZoom) - (isFlat ? 0 : TWIN.tiltZoomOffset);
    map.easeTo({ center: cam.center, zoom, pitch: view.pitch, bearing: view.bearing, duration: animate ? TWIN.cameraMs : 0 });
  };

  /** Fit `points` (the live view's route and target), keeping the current tilt. */
  const fitToPoints = (map: MapLibreMap, points: LatLng[]) => {
    const insets = panelInsets(map, latest.current.avoidPanel);
    const pad = TWIN.fitPaddingPx;
    const bounds = new LngLatBounds();
    for (const p of points) bounds.extend(lngLat(p));
    const cam = map.cameraForBounds(bounds, {
      padding: { top: pad, right: pad, bottom: pad + insets.bottom, left: pad + insets.left },
      maxZoom: TWIN.mission.fitMaxZoom,
    });
    if (!cam) return;
    // Same as fitDistrict: the fit ignores the tilt, so back off a little to keep the near end in view.
    const zoom = (cam.zoom ?? TWIN.initialZoom) - (latest.current.flat ? 0 : TWIN.tiltZoomOffset);
    map.easeTo({ center: cam.center, zoom, duration: TWIN.cameraMs });
  };

  /** Camera cone + home line from the mission UAV's current (gliding) marker position. */
  const updateLive = () => {
    const map = mapRef.current;
    const m = latest.current.mission;
    const source = map?.getSource("twin-mission-live") as GeoSource;
    if (!source) return;
    const s = m ? uavStates.current.get(m.uavId) : undefined;
    source.setData(liveCollection(m, s?.cur ?? null));
  };

  const refreshArrows = () => {
    const map = mapRef.current;
    if (!map) return;
    const bearing = map.getBearing();
    for (const s of uavStates.current.values()) s.arrow.style.transform = `rotate(${s.curHeading - bearing}deg)`;
  };

  // ---------------------------------------------------------------- create the map once
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const { district } = latest.current;
    let failed = false;
    let loaded = false;
    const fail = (reason: string) => {
      if (failed || loaded) return;
      failed = true;
      latest.current.onFail(reason);
    };

    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container: el,
        style: TWIN.styleUrl,
        center: lngLat(district.center),
        zoom: TWIN.initialZoom,
        pitch: TWIN.pitch,
        bearing: TWIN.bearing,
        maxPitch: TWIN.maxPitch,
        minZoom: TWIN.minZoom,
        maxZoom: TWIN.maxZoom,
        maxBounds: toBounds(circleBounds(district.center, district.radiusM, TWIN.boundsPaddingM)),
        attributionControl: { compact: true, customAttribution: TWIN.attribution },
      });
    } catch (e) {
      failed = true;
      latest.current.onFail(e instanceof Error ? e.message : "WebGL is not available");
      return;
    }
    mapRef.current = map;
    fitDistrict(map, false);

    const timer = window.setTimeout(() => fail("The map style did not load in time"), TWIN.loadTimeoutMs);
    // Style errors have no source; a missing tile (with a sourceId) must not abandon the 3D view.
    map.on("error", (e) => {
      if (!(e as { sourceId?: string }).sourceId && !loaded) fail(e.error?.message ?? "The map style failed to load");
    });

    map.once("load", () => {
      loaded = true;
      window.clearTimeout(timer);

      // Buildings: the style's own 3D layer, visible from the district overview zoom; add one if the style has none.
      const layers = map.getStyle().layers ?? [];
      const extrusions = layers.filter((l) => l.type === "fill-extrusion");
      if (extrusions.length > 0) {
        for (const l of extrusions) {
          map.setLayerZoomRange(l.id, TWIN.extrusion.minZoom, 24);
          // Tint by height so the towers stand out against the flat ground of the style.
          map.setPaintProperty(l.id, "fill-extrusion-color", [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "render_height"], 0],
            ...TWIN.extrusion.heightColors.flat(),
          ]);
          map.setPaintProperty(l.id, "fill-extrusion-opacity", TWIN.extrusion.opacity);
        }
      } else if (map.getSource("openmaptiles")) {
        map.addLayer({
          id: "twin-buildings",
          type: "fill-extrusion",
          source: "openmaptiles",
          "source-layer": "building",
          minzoom: TWIN.extrusion.minZoom,
          paint: {
            "fill-extrusion-color": TWIN.extrusion.color,
            "fill-extrusion-opacity": TWIN.extrusion.opacity,
            "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          },
        });
      }

      // Service area: faint fill and a dashed ring.
      const d = latest.current.district;
      map.addSource("twin-district", { type: "geojson", data: ringPolygon(d.center, d.radiusM) });
      map.addLayer({
        id: "twin-district-fill",
        type: "fill",
        source: "twin-district",
        paint: { "fill-color": TWIN.ring.color, "fill-opacity": TWIN.ring.fillOpacity },
      });
      map.addLayer({
        id: "twin-district-ring",
        type: "line",
        source: "twin-district",
        paint: { "line-color": TWIN.ring.color, "line-width": TWIN.ring.width, "line-dasharray": TWIN.ring.dash },
      });

      // Live mission view: survey circle, planned route, trail, camera cone, home line, waypoints, target.
      const c = MAP.colors;
      const tm = TWIN.mission;
      map.addSource("twin-mission", { type: "geojson", data: EMPTY });
      map.addSource("twin-mission-live", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "twin-survey-fill",
        type: "fill",
        source: "twin-mission",
        filter: isKind("survey"),
        paint: { "fill-color": c.circle, "fill-opacity": tm.surveyFillOpacity },
      });
      map.addLayer({
        id: "twin-survey-line",
        type: "line",
        source: "twin-mission",
        filter: isKind("survey"),
        paint: { "line-color": c.circle, "line-width": 2, "line-opacity": 0.8 },
      });
      map.addLayer({
        id: "twin-planned",
        type: "line",
        source: "twin-mission",
        filter: isKind("planned"),
        paint: { "line-color": c.plannedRoute, "line-width": tm.routeWidth, "line-opacity": 0.9, "line-dasharray": tm.routeDash },
      });
      map.addLayer({
        id: "twin-trail",
        type: "line",
        source: "twin-mission",
        filter: isKind("trail"),
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": c.trail, "line-width": tm.trailWidth, "line-opacity": 0.8 },
      });
      map.addLayer({
        id: "twin-cone-fill",
        type: "fill",
        source: "twin-mission-live",
        filter: isKind("cone"),
        paint: { "fill-color": c.camera, "fill-opacity": tm.coneFillOpacity },
      });
      map.addLayer({
        id: "twin-cone-line",
        type: "line",
        source: "twin-mission-live",
        filter: isKind("cone"),
        paint: { "line-color": c.camera, "line-width": 1, "line-opacity": 0.7 },
      });
      map.addLayer({
        id: "twin-home-line",
        type: "line",
        source: "twin-mission-live",
        filter: isKind("home"),
        paint: { "line-color": c.homeLine, "line-width": 2, "line-opacity": 0.8, "line-dasharray": tm.homeLineDash },
      });
      map.addLayer({
        id: "twin-waypoints",
        type: "circle",
        source: "twin-mission",
        filter: isKind("waypoint"),
        paint: {
          "circle-radius": [
            "case",
            ["==", ["get", "highlight"], 1],
            tm.highlightRadius,
            ["==", ["get", "endpoint"], 1],
            tm.endpointRadius,
            tm.waypointRadius,
          ],
          "circle-color": ["case", ["==", ["get", "highlight"], 1], c.plannedRoute, "#ffffff"],
          "circle-stroke-color": c.plannedRoute,
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "twin-target",
        type: "circle",
        source: "twin-mission",
        filter: isKind("target"),
        paint: { "circle-radius": tm.targetRadius, "circle-color": c.pin, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
      });

      // Report / task pins.
      map.addSource("twin-pins", { type: "geojson", data: pinCollection([], null) });
      map.addLayer({
        id: "twin-pins",
        type: "circle",
        source: "twin-pins",
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": ["case", ["==", ["get", "selected"], 1], TWIN.pin.radius * 1.5, TWIN.pin.radius],
          "circle-stroke-color": TWIN.pin.strokeColor,
          "circle-stroke-width": TWIN.pin.strokeWidth,
        },
      });
      // A wider invisible circle makes the small pins easy to hit.
      map.addLayer({
        id: "twin-pins-hit",
        type: "circle",
        source: "twin-pins",
        paint: { "circle-radius": TWIN.pin.hitRadius, "circle-opacity": 0 },
      });
      map.on("click", "twin-pins-hit", (e) => {
        const id = e.features?.[0]?.properties?.id;
        if (id !== undefined) latest.current.onPinClick(String(id));
      });
      map.on("click", (e) => {
        const onDot = map.queryRenderedFeatures(e.point, { layers: ["twin-pins-hit"] }).length > 0;
        if (!onDot && latest.current.popup) latest.current.onPopupClose?.();
      });
      map.on("mouseenter", "twin-pins-hit", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "twin-pins-hit", () => (map.getCanvas().style.cursor = ""));

      setReadyMap(map);
    });

    map.on("dragstart", (e) => {
      if ((e as { originalEvent?: unknown }).originalEvent) latest.current.onUserMove();
    });
    map.on("rotate", refreshArrows);

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(el);

    // The base marker never moves.
    const baseEl = document.createElement("div");
    baseEl.className = "twin-base";
    baseEl.style.width = baseEl.style.height = `${TWIN.baseSizePx}px`;
    baseEl.textContent = "B";
    baseEl.title = "UAV base";
    const baseMarker = new Marker({ element: baseEl }).setLngLat(lngLat(latest.current.base)).addTo(map);

    const states = uavStates.current;
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(raf.current);
      raf.current = 0;
      ro.disconnect();
      baseMarker.remove();
      for (const s of states.values()) s.marker.remove();
      states.clear();
      map.remove();
      mapRef.current = null;
      setReadyMap(null);
    };
    // (created once; everything else is read through `latest`)
  }, []);

  // ---------------------------------------------------------------- report / task pins
  useEffect(() => {
    if (!readyMap) return;
    (readyMap.getSource("twin-pins") as { setData: (d: GeoJSON.FeatureCollection) => void } | undefined)?.setData(
      pinCollection(pins, selectedPinId),
    );
  }, [readyMap, pins, selectedPinId]);

  // ---------------------------------------------------------------- mission overlays (live mission view)
  const { mission } = props;
  useEffect(() => {
    if (!readyMap) return;
    (readyMap.getSource("twin-mission") as GeoSource)?.setData(missionCollection(mission));
    updateLive();
    // (updateLive only reads refs)
  }, [readyMap, mission]);

  // ---------------------------------------------------------------- UAV markers, gliding between polls
  useEffect(() => {
    const map = readyMap;
    if (!map) return;
    const states = uavStates.current;
    const now = performance.now();
    const seen = new Set<string>();

    for (const u of uavs) {
      seen.add(u.id);
      const to = lngLat(u.position);
      let s = states.get(u.id);
      if (!s) {
        const el = document.createElement("div");
        el.className = "twin-uav";
        el.style.width = el.style.height = `${TWIN.uavSizePx}px`;
        el.innerHTML = UAV_SVG(TWIN.uavSizePx) + `<span class="twin-uav__label"></span>`;
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          latest.current.onUavClick(u.id);
        });
        const marker = new Marker({ element: el }).setLngLat(to).addTo(map);
        s = {
          marker,
          el,
          arrow: el.querySelector("svg") as unknown as HTMLElement,
          label: el.querySelector(".twin-uav__label") as HTMLElement,
          from: to,
          to,
          cur: to,
          fromHeading: u.headingDeg,
          toHeading: u.headingDeg,
          curHeading: u.headingDeg,
          t0: now,
        };
        states.set(u.id, s);
      } else {
        // Glide from wherever the marker is now to the new position.
        s.from = s.cur;
        s.to = to;
        s.fromHeading = s.curHeading;
        s.toHeading = s.curHeading + shortestDelta(s.curHeading, u.headingDeg);
        s.t0 = now;
      }
      s.el.style.setProperty("--twin-uav-color", u.color);
      s.el.classList.toggle("twin-uav--selected", u.id === selectedUavId);
      s.label.textContent = u.label;
      s.el.title = u.label;
    }
    for (const [id, s] of states) {
      if (!seen.has(id)) {
        s.marker.remove();
        states.delete(id);
      }
    }
    // UAVs parked on the same spot (all idle ones sit on the base) would hide each other: draw them side by side.
    const stacks = new Map<string, UavState[]>();
    for (const s of states.values()) {
      const key = `${s.to[0].toFixed(5)},${s.to[1].toFixed(5)}`;
      stacks.set(key, [...(stacks.get(key) ?? []), s]);
    }
    for (const group of stacks.values()) {
      group.forEach((s, i) =>
        s.marker.setOffset(group.length > 1 ? [(i - (group.length - 1) / 2) * TWIN.stackSpreadPx, -TWIN.stackLiftPx] : [0, 0]),
      );
    }

    const tick = (t: number) => {
      let animating = false;
      for (const [id, s] of states) {
        const p = Math.min(1, (t - s.t0) / (latest.current.glideMs ?? MONITOR.fleetPollMs));
        s.cur = [s.from[0] + (s.to[0] - s.from[0]) * p, s.from[1] + (s.to[1] - s.from[1]) * p];
        s.curHeading = s.fromHeading + (s.toHeading - s.fromHeading) * p;
        s.marker.setLngLat(s.cur);
        if (p < 1) animating = true;
        // jumpTo cancels a running camera animation: let the follow zoom-in (easeTo below) finish first.
        if (latest.current.follow && latest.current.selectedUavId === id && t >= followEaseUntil.current) map.jumpTo({ center: s.cur });
      }
      refreshArrows();
      updateLive();
      raf.current = animating ? window.requestAnimationFrame(tick) : 0;
    };
    window.cancelAnimationFrame(raf.current);
    raf.current = window.requestAnimationFrame(tick);
    // (refreshArrows only reads refs)
  }, [readyMap, uavs, selectedUavId]);

  // ---------------------------------------------------------------- popup card (React content in a maplibre Popup)
  const [popupEl] = useState(() => (typeof document === "undefined" ? null : document.createElement("div")));
  const popupId = props.popup?.id ?? null;
  const popupLat = props.popup?.position[0];
  const popupLon = props.popup?.position[1];
  useEffect(() => {
    const map = readyMap;
    if (!map || !popupEl || popupId === null || popupLat === undefined || popupLon === undefined) return;
    const popup = new Popup({
      className: "twin-popup",
      closeOnClick: false, // the map click handler closes it, so a click on another dot switches instead
      maxWidth: `${TWIN.popup.widthPx}px`,
      offset: TWIN.popup.offsetPx,
    })
      .setLngLat([popupLon, popupLat])
      .setDOMContent(popupEl)
      .addTo(map);
    const onClose = () => latest.current.onPopupClose?.();
    popup.on("close", onClose);
    return () => {
      popup.off("close", onClose); // replaced or unmounted, not closed by the user
      popup.remove();
    };
  }, [readyMap, popupEl, popupId, popupLat, popupLon]);

  // ---------------------------------------------------------------- camera: follow, 2D / 3D, reset
  // (re-runs once the selected UAV's marker exists: a page opened on a UAV can be ready before the first poll)
  const selectedOnMap = uavs.some((u) => u.id === selectedUavId);
  useEffect(() => {
    const map = readyMap;
    if (!map || !follow || !selectedUavId) return;
    const s = uavStates.current.get(selectedUavId);
    if (!s) return;
    followEaseUntil.current = performance.now() + TWIN.cameraMs;
    map.easeTo({ center: s.cur, zoom: Math.max(map.getZoom(), TWIN.followZoom), duration: TWIN.cameraMs });
  }, [readyMap, follow, selectedUavId, selectedOnMap]);

  const firstFlat = useRef(true);
  useEffect(() => {
    const map = readyMap;
    if (!map) return;
    if (firstFlat.current) {
      firstFlat.current = false;
      return;
    }
    map.easeTo({
      pitch: flat ? TWIN.flatPitch : TWIN.pitch,
      bearing: flat ? TWIN.flatBearing : TWIN.bearing,
      duration: TWIN.cameraMs,
    });
  }, [readyMap, flat]);

  const firstReset = useRef(true);
  useEffect(() => {
    const map = readyMap;
    if (!map) return;
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    const points = latest.current.fitPoints;
    if (points && points.length > 0) fitToPoints(map, points);
    else fitDistrict(map, true);
    // (only a new resetKey refits)
  }, [readyMap, resetKey]);

  // maplibre's own CSS makes its container `position: relative`, so it sits inside a wrapper that fills the pane.
  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" role="application" aria-label="3D map of the district" />
      {props.popup && popupEl && createPortal(props.popup.content, popupEl)}
    </div>
  );
}
