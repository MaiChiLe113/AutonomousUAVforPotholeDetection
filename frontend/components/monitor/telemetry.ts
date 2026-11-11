"use client";

// Live telemetry for the dashboard (UC-M4): poll every SIM.telemetryPollMs until the mission is final,
// and keep a client-side trail of the flown positions (A-13: a reload starts the trail again).

import { useEffect, useRef, useState } from "react";

import { ApiError, latestTelemetry } from "@/lib/api";
import { MONITOR, SIM } from "@/lib/config";
import { distanceToPolylineM, type LatLng } from "@/lib/map";
import type { MissionState, Telemetry } from "@/lib/types";

export const FINAL_STATES: MissionState[] = ["done", "failed"];

export interface TelemetryFeed {
  telemetry: Telemetry | null;
  /** Message of the last failed request (cleared by the next success). */
  error: string | null;
  /** The mission does not exist (404): polling stopped. */
  notFound: boolean;
  /** The mission is done / failed: polling stopped after that reading. */
  final: boolean;
}

/**
 * GET /missions/{id}/telemetry/latest now and every SIM.telemetryPollMs (waiting for each answer).
 * Stops for good once a reading says done / failed, or the mission is 404. Errors keep the last reading.
 */
export function useTelemetry(missionId: number): TelemetryFeed {
  const [feed, setFeed] = useState<TelemetryFeed & { id: number }>({ id: missionId, telemetry: null, error: null, notFound: false, final: false });

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const run = async () => {
      let stop = false;
      try {
        const t = await latestTelemetry(missionId);
        if (cancelled) return;
        stop = FINAL_STATES.includes(t.state);
        setFeed({ id: missionId, telemetry: t, error: null, notFound: false, final: stop });
      } catch (e) {
        if (cancelled) return;
        const notFound = e instanceof ApiError && e.status === 404;
        stop = notFound;
        setFeed((f) => ({ ...(f.id === missionId ? f : { telemetry: null, final: false }), id: missionId, error: (e as Error).message, notFound }));
      }
      if (!cancelled && !stop) timer = window.setTimeout(run, SIM.telemetryPollMs);
    };
    run();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [missionId]);

  if (feed.id !== missionId) return { telemetry: null, error: null, notFound: false, final: false };
  return feed;
}

interface TrailState {
  points: LatLng[];
  /** Whether the points lie on the planned route (within MONITOR.trailMaxJumpM). */
  onRoute: boolean;
}

/**
 * Flown positions from successive readings (skips repeats and the parked "pending" reading).
 * Readings farther than MONITOR.trailMaxJumpM from the planned route (e.g. an ingested test sample far away)
 * get their own segment, and the trail starts again when readings return to the route, so no line is drawn
 * across the map. Flights of any length on the route stay one continuous trail. Without a route: always append.
 */
export function useTrail(telemetry: Telemetry | null, route?: LatLng[] | null): LatLng[] {
  const [trail, setTrail] = useState<TrailState>({ points: [], onRoute: true });
  const lastId = useRef<number | null>(null);

  useEffect(() => {
    if (!telemetry || telemetry.state === "pending" || telemetry.id === lastId.current) return;
    lastId.current = telemetry.id;
    const p: LatLng = [telemetry.lat, telemetry.lon];
    const onRoute = !route || route.length < 2 || distanceToPolylineM(p, route) <= MONITOR.trailMaxJumpM;
    setTrail((prev) => {
      const last = prev.points[prev.points.length - 1];
      if (last && last[0] === p[0] && last[1] === p[1]) return prev;
      if (prev.points.length > 0 && onRoute !== prev.onRoute) return { points: [p], onRoute };
      const next = [...prev.points, p];
      return {
        points: next.length > MONITOR.trailMaxPoints ? next.slice(next.length - MONITOR.trailMaxPoints) : next,
        onRoute,
      };
    });
  }, [telemetry, route]);

  return trail.points;
}
