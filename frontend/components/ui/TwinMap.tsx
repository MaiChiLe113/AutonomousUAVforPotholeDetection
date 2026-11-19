"use client";

// 3D digital twin of the district (MapLibre GL + OpenFreeMap vector tiles with extruded OSM buildings).
// Used only by the monitor Map tab; every other page keeps the Leaflet map. Never import this file directly:
// it touches `window` at import time. Load it with next/dynamic (ssr: false), as FleetMap does.
//
// One map instance for the whole life of the component: the fleet updates move the markers and replace the GeoJSON
// data, they never re-create the map. UAV markers glide between two polls. If WebGL or the style fails to load,
// `onFail` is called once so the parent can show the flat map instead.

import "maplibre-gl/dist/maplibre-gl.css";

import { LngLatBounds, Map as MapLibreMap, Marker, setWorkerUrl } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

import { MAP, MONITOR, TWIN } from "@/lib/config";
import { circleBounds, destinationPoint, type LatLng } from "@/lib/map";

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
  /** Fit the district again whenever this number changes. */
  resetKey: number;
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

function ringPolygon(center: LatLng, radiusM: number): GeoJSON.Feature<GeoJSON.Polygon> {
  const n = TWIN.ring.segments;
  const coords: LngLat[] = [];
  for (let i = 0; i <= n; i++) coords.push(lngLat(destinationPoint(center, (360 * (i % n)) / n, radiusM)));
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [coords] } };
}

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

    const tick = (t: number) => {
      let animating = false;
      for (const [id, s] of states) {
        const p = Math.min(1, (t - s.t0) / MONITOR.fleetPollMs);
        s.cur = [s.from[0] + (s.to[0] - s.from[0]) * p, s.from[1] + (s.to[1] - s.from[1]) * p];
        s.curHeading = s.fromHeading + (s.toHeading - s.fromHeading) * p;
        s.marker.setLngLat(s.cur);
        if (p < 1) animating = true;
        if (latest.current.follow && latest.current.selectedUavId === id) map.jumpTo({ center: s.cur });
      }
      refreshArrows();
      raf.current = animating ? window.requestAnimationFrame(tick) : 0;
    };
    window.cancelAnimationFrame(raf.current);
    raf.current = window.requestAnimationFrame(tick);
    // (refreshArrows only reads refs)
  }, [readyMap, uavs, selectedUavId]);

  // ---------------------------------------------------------------- camera: follow, 2D / 3D, reset
  useEffect(() => {
    const map = readyMap;
    if (!map || !follow || !selectedUavId) return;
    const s = uavStates.current.get(selectedUavId);
    if (s) map.easeTo({ center: s.cur, zoom: Math.max(map.getZoom(), TWIN.followZoom), duration: TWIN.cameraMs });
  }, [readyMap, follow, selectedUavId]);

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
    fitDistrict(map, true);
    // (only a new resetKey refits)
  }, [readyMap, resetKey]);

  // maplibre's own CSS makes its container `position: relative`, so it sits inside a wrapper that fills the pane.
  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" role="application" aria-label="3D map of the district" />
    </div>
  );
}
