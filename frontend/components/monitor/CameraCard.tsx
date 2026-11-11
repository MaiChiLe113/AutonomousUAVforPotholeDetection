"use client";

// UC-M5 live camera (FR-33..FR-36, mocked): Request -> "Waiting for drone…" -> simulated feed + Stop.
// GET /missions/{id}/camera is polled every SIM.cameraPollMs only while the session is requested / live.
// When the mission is over the card is one "Camera ended" line with the button disabled (G-10).

import { useEffect, useRef, useState } from "react";

import StatusBadge from "@/components/StatusBadge";
import { Banner, Button, Icon, PanelSection, Spinner } from "@/components/ui";
import { getCamera, mediaUrl, requestCamera, stopCamera } from "@/lib/api";
import { FLYING_STATES, MONITOR, SIM } from "@/lib/config";
import { formatDeg } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import type { CameraSession, MissionState, Telemetry } from "@/lib/types";

export interface CameraCardProps {
  missionId: number;
  missionState: MissionState;
  telemetry: Telemetry | null;
  /** Report photo used as the simulated view (Report.photo_url). */
  photoUrl: string | null;
}

export default function CameraCard({ missionId, missionState, telemetry, photoUrl }: CameraCardProps) {
  const flying = FLYING_STATES.includes(missionState);
  const over = missionState === "done" || missionState === "failed";
  const [session, setSession] = useState<CameraSession | null>(null);
  const [busy, setBusy] = useState<"request" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by every user action; poll answers that started before it are dropped (no stale "live" after Stop).
  const epoch = useRef(0);

  // Read the current session once the UAV flies (a reload may land on a live session).
  useEffect(() => {
    if (!flying) return;
    const started = epoch.current;
    let cancelled = false;
    getCamera(missionId)
      .then((s) => {
        if (!cancelled && started === epoch.current) setSession(s);
      })
      .catch(() => {
        // not fatal: the button still works
      });
    return () => {
      cancelled = true;
    };
  }, [missionId, flying]);

  // Poll only while requested / live.
  const polling = !over && (session?.status === "requested" || session?.status === "live");
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      const started = epoch.current;
      try {
        const s = await getCamera(missionId);
        if (!cancelled && started === epoch.current) setSession(s);
      } catch {
        // keep the last state; the next tick tries again
      }
      if (!cancelled) timer = window.setTimeout(tick, SIM.cameraPollMs);
    };
    timer = window.setTimeout(tick, SIM.cameraPollMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [polling, missionId]);

  async function act(kind: "request" | "stop") {
    if (busy) return;
    epoch.current += 1;
    setBusy(kind);
    setError(null);
    try {
      setSession(kind === "request" ? await requestCamera(missionId) : await stopCamera(missionId));
    } catch (e) {
      setError((e as Error).message || "The camera request failed.");
    } finally {
      setBusy(null);
    }
  }

  // ---------------------------------------------------------------- mission over: one line (G-10)
  if (over) {
    return (
      <PanelSection title="Live camera">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2 text-sm text-slate-600">
            <Icon name="camera" size={18} className="shrink-0 text-slate-400" />
            Camera ended
          </span>
          <Button size="sm" variant="secondary" disabled>
            Request live camera
          </Button>
        </div>
      </PanelSection>
    );
  }

  const status = session?.status ?? "idle";
  const showBadge = session && status !== "idle";

  return (
    <PanelSection title="Live camera" action={showBadge ? <StatusBadge status={status} kind="camera" /> : undefined}>
      {status === "live" && session ? (
        <div className="space-y-2">
          {session.stream_url ? (
            <video
              src={session.stream_url}
              autoPlay
              muted
              playsInline
              controls
              className="aspect-video w-full rounded-xl bg-black"
              aria-label="UAV live camera"
            />
          ) : (
            <SimulatedFeed photoUrl={photoUrl} telemetry={telemetry} />
          )}
          <Button variant="secondary" fullWidth loading={busy === "stop"} onClick={() => act("stop")} icon={<Icon name="close" size={16} />}>
            Stop camera
          </Button>
        </div>
      ) : status === "requested" ? (
        <div className="space-y-2">
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-xl bg-slate-100 text-sm text-slate-600" role="status">
            <Spinner className="text-accent" size={20} />
            Waiting for drone…
          </div>
          <Button variant="secondary" fullWidth loading={busy === "stop"} onClick={() => act("stop")}>
            Stop camera
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Button fullWidth disabled={!flying} loading={busy === "request"} onClick={() => act("request")} icon={<Icon name="camera" size={18} />}>
            Request live camera
          </Button>
          {status === "denied" ? (
            <p className="text-sm text-amber-800">Camera not available - the UAV is not flying.</p>
          ) : !flying ? (
            <p className="text-xs text-slate-500">Available while the UAV is flying.</p>
          ) : status === "ended" ? (
            <p className="text-xs text-slate-500">Camera stopped. You can request it again.</p>
          ) : null}
        </div>
      )}
      {error && (
        <Banner tone="danger" className="mt-2">
          {error}
        </Banner>
      )}
    </PanelSection>
  );
}

/** Mock feed: the report photo with a HUD (crosshair, altitude, gimbal pitch, time, "SIMULATED"). */
function SimulatedFeed({ photoUrl, telemetry }: { photoUrl: string | null; telemetry: Telemetry | null }) {
  const now = useNow(MONITOR.feedClockMs);
  const t = now / 1000;
  const drift = MONITOR.feedDriftPx;
  const dx = Math.sin(t / 3) * drift;
  const dy = Math.cos(t / 4) * drift;
  const hud = "[text-shadow:0_1px_2px_rgb(0_0_0/0.9)]";

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-slate-800 text-white select-none" aria-label="Simulated UAV camera feed">
      {photoUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- backend media used as a mock video frame
        <img
          src={mediaUrl(photoUrl)}
          alt=""
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-1000 ease-linear"
          style={{ transform: `scale(1.12) translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)` }}
        />
      )}
      <div className="absolute inset-0 bg-black/15" aria-hidden />

      {/* crosshair */}
      <svg viewBox="0 0 64 64" className="absolute top-1/2 left-1/2 h-14 w-14 -translate-x-1/2 -translate-y-1/2" aria-hidden>
        <g stroke="#fff" strokeWidth="1.5" fill="none" opacity="0.9">
          <circle cx="32" cy="32" r="12" />
          <path d="M32 4v16M32 44v16M4 32h16M44 32h16" />
        </g>
        <circle cx="32" cy="32" r="1.5" fill="#fff" />
      </svg>

      <span className="absolute top-2 left-2 rounded bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-slate-900">SIMULATED</span>
      <span className={`absolute top-2 right-2 flex items-center gap-1 font-mono text-[11px] ${hud}`}>
        <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" aria-hidden />
        LIVE {new Date(now).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </span>
      <div className={`absolute inset-x-2 bottom-2 flex items-end justify-between gap-2 font-mono text-[11px] ${hud}`}>
        <span>ALT {telemetry ? `${telemetry.altitude_m.toFixed(1)} m` : "–"}</span>
        <span>PITCH {formatDeg(telemetry?.gimbal_pitch_deg)}</span>
      </div>
    </div>
  );
}
