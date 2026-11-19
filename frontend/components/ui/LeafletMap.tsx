"use client";

// Leaflet implementation behind <MapView>. Never import this file directly: it touches `window`
// at import time. Import "@/components/MapView" instead (it loads this with ssr: false).

import L from "leaflet";
import { useEffect, useMemo, useRef } from "react";
import {
  AttributionControl,
  Circle,
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  TileLayer,
  Tooltip,
  ZoomControl,
  useMap,
  useMapEvents,
} from "react-leaflet";

import { MAP } from "@/lib/config";
import { destinationPoint, footprintPolygon, normalizeDeg, type FlyTarget, type LatLng, type MapBounds, type MapViewProps } from "@/lib/map";

// ------------------------------------------------------------------ icons (divIcon, no CDN images)

const icons = new Map<string, L.DivIcon>();
function cachedIcon(key: string, make: () => L.DivIcon): L.DivIcon {
  let icon = icons.get(key);
  if (!icon) {
    icon = make();
    icons.set(key, icon);
  }
  return icon;
}

// Colours are injected into HTML, so only accept plain colour syntax.
const safeColor = (c: string | undefined, fallback: string) =>
  c && /^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d\s.,%]+\))$/i.test(c) ? c : fallback;

function dotIcon(color: string, selected: boolean) {
  const size = selected ? 22 : 16;
  return cachedIcon(`dot|${color}|${selected}`, () =>
    L.divIcon({
      className: "map-icon",
      html: `<span class="map-dot${selected ? " map-dot--selected" : ""}" style="background:${color}"></span>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      tooltipAnchor: [0, -size / 2],
    }),
  );
}

function pinIcon(color: string, draggable: boolean) {
  return cachedIcon(`pin|${color}|${draggable}`, () =>
    L.divIcon({
      className: "map-icon",
      html:
        `<svg class="map-pin${draggable ? " map-pin--draggable" : ""}" viewBox="0 0 28 40" aria-hidden="true">` +
        `<path d="M14 1C6.8 1 1 6.7 1 13.9 1 23.6 14 39 14 39s13-15.4 13-25.1C27 6.7 21.2 1 14 1z" fill="${color}" stroke="#fff" stroke-width="2"/>` +
        `<circle cx="14" cy="14" r="5" fill="#fff"/></svg>`,
      iconSize: [28, 40],
      iconAnchor: [14, 39],
      tooltipAnchor: [0, -38],
    }),
  );
}

function uavIcon(headingDeg: number, colorIn?: string, selected = false) {
  const h = Math.round(normalizeDeg(headingDeg) / 2) * 2;
  const color = safeColor(colorIn, MAP.colors.uav);
  return cachedIcon(`uav|${h}|${color}|${selected}`, () =>
    L.divIcon({
      className: "map-icon",
      html:
        `<svg class="map-uav" viewBox="0 0 40 40" style="transform:rotate(${h}deg)" aria-hidden="true">` +
        `<circle cx="20" cy="20" r="18" fill="${color}" fill-opacity="${selected ? 0.3 : 0.16}"${selected ? ` stroke="${color}" stroke-width="2"` : ""}/>` +
        `<path d="M20 5 L30 32 L20 26 L10 32 Z" fill="${color}" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/></svg>`,
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      tooltipAnchor: [0, -18],
    }),
  );
}

const homeIcon = () =>
  cachedIcon("home", () =>
    L.divIcon({ className: "map-icon", html: `<span class="map-home">H</span>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
  );

const stationIcon = () =>
  cachedIcon("station", () =>
    L.divIcon({
      className: "map-icon",
      html: `<span class="map-station" style="background:${MAP.colors.base}">B</span>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      tooltipAnchor: [0, -13],
    }),
  );

// takeoff / land are drawn as badges beside the point when they share a spot (they usually do: home).
function waypointIcon(kind: string, highlight: boolean, side: "left" | "right" | null) {
  return cachedIcon(`wp|${kind}|${highlight}|${side}`, () => {
    const big = kind === "takeoff" || kind === "land";
    const size = big ? 20 : highlight ? 12 : 9;
    const glyph = kind === "takeoff" ? "&#8593;" : kind === "land" ? "&#8595;" : "";
    const cls = `map-wp${big ? "" : " map-wp--small"}${highlight ? " map-wp--highlight" : ""}`;
    const dx = side === "left" ? size + 4 : side === "right" ? -4 : size / 2;
    return L.divIcon({
      className: "map-icon",
      html: `<span class="${cls}">${glyph}</span>`,
      iconSize: [size, size],
      iconAnchor: [dx, size / 2],
    });
  });
}

const highlightIcon = () =>
  cachedIcon("wp-highlight", () =>
    L.divIcon({
      className: "map-icon",
      html: `<span class="map-wp map-wp--small map-wp--highlight"></span>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    }),
  );

// ------------------------------------------------------------------ panel-aware positioning

interface Insets {
  left: number;
  bottom: number;
}

function panelInsets(map: L.Map, avoidPanel: boolean): Insets {
  if (!avoidPanel) return { left: 0, bottom: 0 };
  const size = map.getSize();
  const desktop = window.matchMedia(`(min-width: ${MAP.panel.desktopMinWidthPx}px)`).matches;
  if (desktop) {
    // Only offset when the map is wide enough to be the full-bleed page map.
    return { left: size.x >= MAP.panel.desktopInsetPx * 1.6 ? MAP.panel.desktopInsetPx : 0, bottom: 0 };
  }
  return { left: 0, bottom: Math.round(size.y * MAP.panel.mobileSheetFraction) };
}

/** Map centre that shows `target` in the middle of the area not covered by the panel. */
function offsetCenter(map: L.Map, target: LatLng, zoom: number, insets: Insets): L.LatLng {
  const p = map.project(target, zoom);
  return map.unproject(p.subtract([insets.left / 2, -insets.bottom / 2]), zoom);
}

function flyTargetOf(t: FlyTarget | null | undefined): { center: LatLng; zoom?: number; key?: string | number } | null {
  if (!t) return null;
  return Array.isArray(t) ? { center: t } : t;
}

// ------------------------------------------------------------------ behaviour (events, fly, follow, fit)

interface BehaviourProps {
  onMapClick?: (p: LatLng) => void;
  onUserMove?: () => void;
  onReady?: (map: L.Map) => void;
  flyTo?: FlyTarget | null;
  follow: boolean;
  uavPos: LatLng | null;
  fitKey?: string | number | null;
  fitPoints: LatLng[];
  fitBoundsTo?: MapBounds;
  avoidPanel: boolean;
}

function MapBehaviour({ onMapClick, onUserMove, onReady, flyTo, follow, uavPos, fitKey, fitPoints, fitBoundsTo, avoidPanel }: BehaviourProps) {
  const map = useMap();
  const latest = useRef({ onMapClick, onUserMove, fitPoints, fitBoundsTo, avoidPanel });
  const fitted = useRef(false);
  useEffect(() => {
    latest.current = { onMapClick, onUserMove, fitPoints, fitBoundsTo, avoidPanel };
  });

  useMapEvents({
    click: (e) => latest.current.onMapClick?.([e.latlng.lat, e.latlng.lng]),
    dragstart: () => latest.current.onUserMove?.(),
  });

  // Ready + keep Leaflet's size in sync with the container (panel / sheet / window changes).
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current?.(map);
    const ro = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    ro.observe(map.getContainer());
    return () => ro.disconnect();
  }, [map]);

  // flyTo: fly when the target value changes.
  const fly = flyTargetOf(flyTo);
  const flyKey = fly ? `${fly.center[0]},${fly.center[1]},${fly.zoom ?? ""},${fly.key ?? ""}` : null;
  const flyRef = useRef(fly);
  useEffect(() => {
    flyRef.current = fly;
  });
  useEffect(() => {
    const t = flyRef.current;
    if (!flyKey || !t) return;
    const zoom = t.zoom ?? Math.max(map.getZoom(), MAP.focusZoom);
    const center = offsetCenter(map, t.center, zoom, panelInsets(map, latest.current.avoidPanel));
    map.flyTo(center, zoom, { duration: MAP.flyDurationS });
  }, [flyKey, map]);

  // follow: keep the UAV centred.
  const uavLat = uavPos?.[0];
  const uavLon = uavPos?.[1];
  useEffect(() => {
    if (!follow || uavLat === undefined || uavLon === undefined) return;
    const zoom = map.getZoom();
    const center = offsetCenter(map, [uavLat, uavLon], zoom, panelInsets(map, latest.current.avoidPanel));
    map.panTo(center, { animate: true, duration: 0.5 });
  }, [follow, uavLat, uavLon, map]);

  // fitKey: fit every overlay when the key changes.
  useEffect(() => {
    if (fitKey === null || fitKey === undefined) return;
    const { fitPoints: pts, fitBoundsTo: target, avoidPanel: avoid } = latest.current;
    const insets = panelInsets(map, avoid);
    if (target) {
      // Fit the given bounds (the service area): instant the first time, so the map opens already fitted.
      map.invalidateSize({ pan: false });
      const pad = MAP.fitPaddingPx;
      map.fitBounds(L.latLngBounds(target), {
        paddingTopLeft: [pad + insets.left, pad],
        paddingBottomRight: [pad, pad + insets.bottom],
        animate: fitted.current,
      });
      fitted.current = true;
      return;
    }
    if (pts.length === 0) return;
    if (pts.length === 1) {
      const zoom = Math.max(map.getZoom(), MAP.focusZoom);
      map.flyTo(offsetCenter(map, pts[0], zoom, insets), zoom, { duration: MAP.flyDurationS });
      return;
    }
    const pad = MAP.fitPaddingPx;
    map.flyToBounds(L.latLngBounds(pts), {
      paddingTopLeft: [pad + insets.left, pad],
      paddingBottomRight: [pad, pad + insets.bottom],
      maxZoom: MAP.focusZoom,
      duration: MAP.flyDurationS,
    });
  }, [fitKey, map]);

  return null;
}

// ------------------------------------------------------------------ component

const samePoint = (a?: LatLng, b?: LatLng) => !!a && !!b && Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;

export default function LeafletMap({
  center = MAP.defaultCenter,
  zoom = MAP.defaultZoom,
  markers = [],
  selectedId = null,
  onMarkerClick,
  pin = null,
  onPinMove,
  route,
  plannedRoute,
  waypoints,
  highlightWaypoint = null,
  trail,
  circle = null,
  home = null,
  homeLine = false,
  uav = null,
  uavs,
  selectedUavId = null,
  onUavClick,
  serviceArea = null,
  stations,
  maxBounds,
  minZoom,
  cameraFootprint = null,
  onMapClick,
  flyTo = null,
  follow = false,
  onUserMove,
  fitKey = null,
  fitBoundsTo,
  avoidPanel = true,
  onReady,
  children,
}: Omit<MapViewProps, "className">) {
  const pinColor = safeColor(pin?.color, MAP.colors.pin);
  const pinRef = useRef<L.Marker>(null);
  const onPinMoveRef = useRef(onPinMove);
  useEffect(() => {
    onPinMoveRef.current = onPinMove;
  });
  const pinHandlers = useMemo<L.LeafletEventHandlerFnMap>(
    () => ({
      dragend: () => {
        const ll = pinRef.current?.getLatLng();
        if (ll) onPinMoveRef.current?.([ll.lat, ll.lng]);
      },
    }),
    [],
  );

  const takeoff = waypoints?.find((w) => w.kind === "takeoff")?.position;
  const land = waypoints?.find((w) => w.kind === "land")?.position;
  const sharedBase = samePoint(takeoff, land);

  const highlightPoint = useMemo<LatLng | null>(() => {
    if (highlightWaypoint === null || highlightWaypoint < 0) return null;
    const list = waypoints?.map((w) => w.position) ?? plannedRoute ?? route ?? [];
    return list[highlightWaypoint] ?? null;
  }, [highlightWaypoint, waypoints, plannedRoute, route]);

  const footprint = useMemo(
    () =>
      uav && cameraFootprint
        ? footprintPolygon(uav.position, cameraFootprint.yawDeg, cameraFootprint.pitchDeg, cameraFootprint.altitudeM)
        : null,
    [uav, cameraFootprint],
  );

  const followPos = uav?.position ?? uavs?.find((u) => u.id === selectedUavId)?.position ?? null;

  const fitPoints = useMemo<LatLng[]>(() => {
    const pts: LatLng[] = [];
    if (route) pts.push(...route);
    if (plannedRoute) pts.push(...plannedRoute);
    if (trail) pts.push(...trail);
    if (waypoints) pts.push(...waypoints.map((w) => w.position));
    pts.push(...markers.map((m) => m.position));
    if (pin) pts.push(pin.position);
    if (home) pts.push(home);
    if (uav) pts.push(uav.position);
    if (uavs) pts.push(...uavs.map((u) => u.position));
    if (stations) pts.push(...stations.map((st) => st.position));
    for (const area of [circle, serviceArea]) {
      if (!area) continue;
      const r = area.radiusM;
      pts.push(destinationPoint(area.center, 0, r), destinationPoint(area.center, 180, r));
      pts.push(destinationPoint(area.center, 90, r), destinationPoint(area.center, 270, r));
    }
    return pts;
  }, [route, plannedRoute, trail, waypoints, markers, pin, home, uav, uavs, stations, circle, serviceArea]);

  const c = MAP.colors;

  return (
    <MapContainer
      center={center}
      zoom={zoom}
      maxZoom={MAP.maxZoom}
      minZoom={minZoom}
      maxBounds={maxBounds}
      maxBoundsViscosity={maxBounds ? MAP.district.boundsViscosity : undefined}
      zoomControl={false}
      attributionControl={false}
      className="h-full w-full"
    >
      <TileLayer url={MAP.tileUrl} attribution={MAP.attribution} subdomains={MAP.tileSubdomains} maxZoom={MAP.maxZoom} />
      {/* Bottom-right on desktop; globals.css moves it to the top-left below 768 px (the sheet covers the bottom). */}
      <AttributionControl position="bottomright" prefix={false} />
      <ZoomControl position="bottomright" />

      <MapBehaviour
        onMapClick={onMapClick}
        onUserMove={onUserMove}
        onReady={onReady}
        flyTo={flyTo}
        follow={follow}
        uavPos={followPos}
        fitKey={fitKey}
        fitPoints={fitPoints}
        fitBoundsTo={fitBoundsTo}
        avoidPanel={avoidPanel}
      />

      {serviceArea && (
        <Circle
          center={serviceArea.center}
          radius={serviceArea.radiusM}
          interactive={false}
          pathOptions={{ color: MAP.district.serviceColor, weight: 2, opacity: 0.7, dashArray: "8 8", fillOpacity: 0.03 }}
        />
      )}

      {circle && (
        <Circle
          center={circle.center}
          radius={circle.radiusM}
          interactive={false}
          pathOptions={{ color: safeColor(circle.color, c.circle), weight: 2, opacity: 0.8, fillOpacity: 0.08 }}
        />
      )}

      {route && route.length > 1 && (
        <Polyline positions={route} interactive={false} pathOptions={{ color: c.route, weight: 4, opacity: 0.85 }} />
      )}
      {plannedRoute && plannedRoute.length > 1 && (
        <Polyline
          positions={plannedRoute}
          interactive={false}
          pathOptions={{ color: c.plannedRoute, weight: 3, opacity: 0.75, dashArray: "6 8" }}
        />
      )}
      {trail && trail.length > 1 && (
        <Polyline positions={trail} interactive={false} pathOptions={{ color: c.trail, weight: 3, opacity: 0.8 }} />
      )}
      {homeLine && home && uav && (
        <Polyline
          positions={[uav.position, home]}
          interactive={false}
          pathOptions={{ color: c.homeLine, weight: 2, opacity: 0.8, dashArray: "4 6" }}
        />
      )}
      {footprint && (
        <Polygon
          positions={footprint}
          interactive={false}
          pathOptions={{ color: c.camera, weight: 1, opacity: 0.7, fillColor: c.camera, fillOpacity: 0.22 }}
        />
      )}

      {waypoints?.map((w, i) => {
        const side = sharedBase && w.kind === "takeoff" ? "left" : sharedBase && w.kind === "land" ? "right" : null;
        const label = w.kind === "takeoff" ? "Takeoff" : w.kind === "land" ? "Landing" : `Waypoint ${i + 1}`;
        return (
          <Marker
            key={`wp-${i}`}
            position={w.position}
            icon={waypointIcon(w.kind, i === highlightWaypoint, side)}
            interactive={w.kind === "takeoff" || w.kind === "land"}
            keyboard={false}
            zIndexOffset={w.kind === "takeoff" || w.kind === "land" ? 200 : 0}
          >
            {(w.kind === "takeoff" || w.kind === "land") && <Tooltip direction="top">{label}</Tooltip>}
          </Marker>
        );
      })}
      {highlightPoint && !waypoints && (
        <Marker position={highlightPoint} icon={highlightIcon()} interactive={false} keyboard={false} zIndexOffset={300} />
      )}

      {home && (
        <Marker position={home} icon={homeIcon()} alt="Home" zIndexOffset={100}>
          <Tooltip direction="top" offset={[0, -10]}>
            Home
          </Tooltip>
        </Marker>
      )}

      {stations?.map((st) => (
        <Marker key={`station-${st.id}`} position={st.position} icon={stationIcon()} alt={st.label ?? "Base"} zIndexOffset={150}>
          <Tooltip direction="top" offset={[0, -6]}>
            {st.label ?? "UAV base"}
          </Tooltip>
        </Marker>
      ))}

      {markers.map((m) => {
        const selected = m.id === selectedId;
        return (
          <Marker
            key={m.id}
            position={m.position}
            icon={dotIcon(safeColor(m.color, c.accent), selected)}
            alt={m.label}
            zIndexOffset={selected ? 1000 : 0}
            eventHandlers={onMarkerClick ? { click: () => onMarkerClick(m.id) } : undefined}
          >
            {m.label && <Tooltip direction="top">{m.label}</Tooltip>}
          </Marker>
        );
      })}

      {pin && (
        <Marker
          ref={pinRef}
          position={pin.position}
          icon={pinIcon(pinColor, !!pin.draggable)}
          draggable={!!pin.draggable}
          autoPan={!!pin.draggable}
          title={pin.label ? undefined : pin.draggable ? "Drag to move" : undefined}
          alt={pin.label ?? "Pin"}
          zIndexOffset={1500}
          eventHandlers={pinHandlers}
        >
          {pin.label && <Tooltip direction="top">{pin.label}</Tooltip>}
        </Marker>
      )}

      {uav && (
        <Marker position={uav.position} icon={uavIcon(uav.headingDeg)} title={uav.label ? undefined : "UAV"} alt="UAV" zIndexOffset={2000}>
          {uav.label && <Tooltip direction="top">{uav.label}</Tooltip>}
        </Marker>
      )}

      {uavs?.map((u) => {
        const selected = u.id === selectedUavId;
        return (
          <Marker
            key={`uav-${u.id}`}
            position={u.position}
            icon={uavIcon(u.headingDeg, u.color, selected)}
            title={u.label ? undefined : u.id}
            alt={u.label ?? u.id}
            zIndexOffset={selected ? 2100 : 1900}
            eventHandlers={onUavClick ? { click: () => onUavClick(u.id) } : undefined}
          >
            {u.label && <Tooltip direction="top">{u.label}</Tooltip>}
          </Marker>
        );
      })}

      {children}
    </MapContainer>
  );
}
