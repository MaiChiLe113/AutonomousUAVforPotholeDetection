"use client";

// Dashboard panel parts (UC-M4, FR-28, TR-01..TR-06): mission stepper, last-update / signal state,
// flight data grid (altitude, distances, heading compass, battery, gimbal).

import type { ReactNode } from "react";

import { ProgressBar, StatusTimeline, type TimelineStep } from "@/components/ui";
import { cn } from "@/lib/cn";
import { BATTERY, FLYING_STATES, MISSION_STATE, MONITOR, SIM } from "@/lib/config";
import { ageMs, compassPoint, formatDeg, formatTime } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { formatDistance } from "@/lib/map";
import type { MissionState, Telemetry } from "@/lib/types";

// ---------------------------------------------------------------- stepper

const STEPS: MissionState[] = ["takeoff", "surveying", "landing", "done"];

export function MissionStepper({ state }: { state: MissionState }) {
  const idx = STEPS.indexOf(state); // -1 for pending / failed
  const steps: TimelineStep[] = STEPS.map((s, i) => ({
    key: s,
    label: MISSION_STATE[s].label,
    state: state === "done" ? "done" : i < idx ? "done" : i === idx ? "current" : "upcoming",
  }));
  return <StatusTimeline steps={steps} orientation="horizontal" />;
}

// ---------------------------------------------------------------- last update / signal lost (TR-02)

export function isSignalLost(state: MissionState, ts: string | null | undefined, failed: boolean, now: number): boolean {
  if (!FLYING_STATES.includes(state)) return false;
  const age = ageMs(ts, now);
  return failed || age === null || age > SIM.signalLostAfterMs;
}

/** "Last update 1 s ago" while flying; "Signal lost" when older than SIM.signalLostAfterMs or the poll fails. */
export function SignalStatus({ telemetry, failed }: { telemetry: Telemetry; failed: boolean }) {
  const now = useNow(MONITOR.signalClockMs);
  const state = telemetry.state;
  if (state === "pending") return <span className="text-slate-500">On the ground, waiting for launch</span>;
  if (state === "done" || state === "failed") return <span className="text-slate-500">Final reading {formatTime(telemetry.ts)}</span>;
  if (isSignalLost(state, telemetry.ts, failed, now)) {
    return (
      <span className="inline-flex items-center gap-1.5 font-semibold text-red-700" role="status">
        <span className="h-2 w-2 animate-pulse rounded-full bg-red-600" aria-hidden />
        Signal lost
      </span>
    );
  }
  const s = Math.round((ageMs(telemetry.ts, now) ?? 0) / 1000);
  return (
    <span className="inline-flex items-center gap-1.5 text-slate-600">
      <span className="h-2 w-2 rounded-full bg-green-600" aria-hidden />
      Last update {s} s ago
    </span>
  );
}

// ---------------------------------------------------------------- battery (TR-01)

export type BatteryLevel = "ok" | "warn" | "critical";

export function batteryLevel(pct: number | null | undefined): BatteryLevel | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  return pct < BATTERY.criticalBelowPct ? "critical" : pct < BATTERY.warnBelowPct ? "warn" : "ok";
}

const LEVEL_TEXT: Record<BatteryLevel, string> = { ok: "OK", warn: "Low", critical: "Critical" };

// ---------------------------------------------------------------- heading compass

export function HeadingCompass({ deg, size = 44 }: { deg: number | null; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className="shrink-0" aria-hidden>
      <circle cx="24" cy="24" r="22" fill="#fff" stroke="#cbd5e1" strokeWidth="1.5" />
      {[0, 90, 180, 270].map((a) => (
        <line key={a} x1="24" y1="3.5" x2="24" y2="7" stroke="#94a3b8" strokeWidth="1.5" transform={`rotate(${a} 24 24)`} />
      ))}
      <text x="24" y="15" textAnchor="middle" fontSize="8" fontWeight="700" fill="#dc2626">
        N
      </text>
      {deg != null && (
        <g transform={`rotate(${deg} 24 24)`}>
          <path d="M24 9 L29 30 L24 26.5 L19 30 Z" fill="#2563eb" stroke="#fff" strokeWidth="1" strokeLinejoin="round" />
        </g>
      )}
      <circle cx="24" cy="24" r="1.6" fill="#0f172a" />
    </svg>
  );
}

// ---------------------------------------------------------------- flight data grid

const tile = "min-w-0 rounded-xl bg-slate-50 px-3 py-2";

function Value({ children, unit }: { children: ReactNode; unit?: string }) {
  return (
    <div className="truncate text-base font-semibold text-slate-900 tabular-nums">
      {children}
      {unit && <span className="ml-0.5 text-xs font-normal text-slate-500">{unit}</span>}
    </div>
  );
}

const num = (x: number | null | undefined, digits = 0) => (x == null || !Number.isFinite(x) ? "–" : x.toFixed(digits));

export function FlightData({ t }: { t: Telemetry }) {
  const level = batteryLevel(t.battery_pct);
  const heading = Number.isFinite(t.heading_deg) ? t.heading_deg : null;
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className={tile}>
        <div className="text-xs text-slate-500">Altitude</div>
        <Value unit={t.altitude_m != null ? "m" : undefined}>{num(t.altitude_m, 1)}</Value>
      </div>
      <div className={cn(tile, "flex items-center gap-2")}>
        <HeadingCompass deg={heading} size={40} />
        <div className="min-w-0">
          <div className="text-xs text-slate-500">Heading</div>
          <Value>{heading == null ? "–" : `${formatDeg(heading)} ${compassPoint(heading)}`}</Value>
        </div>
      </div>
      <div className={tile}>
        <div className="truncate text-xs text-slate-500">Distance to target</div>
        <Value>{formatDistance(t.distance_to_target_m)}</Value>
      </div>
      <div className={tile}>
        <div className="truncate text-xs text-slate-500">Distance to home</div>
        <Value>{formatDistance(t.distance_to_home_m)}</Value>
      </div>
      <div className={cn(tile, "col-span-2")}>
        <ProgressBar
          label="Battery"
          value={t.battery_pct ?? 0}
          color={level ? BATTERY.colors[level] : "#cbd5e1"}
          valueText={t.battery_pct == null ? "–" : `${Math.round(t.battery_pct)}% · ${LEVEL_TEXT[level!]}`}
        />
      </div>
      <div className={cn(tile, "col-span-2")}>
        <div className="text-xs text-slate-500">Gimbal</div>
        <div className="mt-0.5 grid grid-cols-3 gap-2">
          {(
            [
              ["Pitch", t.gimbal_pitch_deg],
              ["Yaw", t.gimbal_yaw_deg],
              ["Roll", t.gimbal_roll_deg],
            ] as const
          ).map(([label, v]) => (
            <div key={label} className="min-w-0">
              <div className="text-[11px] text-slate-500">{label}</div>
              <Value>{formatDeg(v)}</Value>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
