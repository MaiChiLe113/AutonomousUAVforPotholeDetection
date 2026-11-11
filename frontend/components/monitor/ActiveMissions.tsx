"use client";

// /monitor/dashboard without ?mission (UC-M4 A1, FR-31): active missions with drone id, state and battery.
// Battery and position come from each mission's latest telemetry (G-07). Selecting one opens its dashboard.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";

import MapView, { type MapMarker } from "@/components/MapView";
import StatusBadge from "@/components/StatusBadge";
import { Banner, ButtonLink, EmptyState, FloatingPanel, Icon, LoadingState } from "@/components/ui";
import { latestTelemetry, listMissions } from "@/lib/api";
import { BATTERY, MISSION_STATE, MONITOR, MONITOR_ROUTES } from "@/lib/config";
import { formatPct } from "@/lib/format";
import { usePoll } from "@/lib/hooks";
import type { Mission, Telemetry } from "@/lib/types";

import { batteryLevel } from "./FlightStatus";

interface Row {
  mission: Mission;
  telemetry: Telemetry | null;
}

async function loadActive(): Promise<Row[]> {
  const missions = await listMissions(true);
  const telemetry = await Promise.all(missions.map((m) => latestTelemetry(m.id).catch(() => null)));
  return missions.map((mission, i) => ({ mission, telemetry: telemetry[i] }));
}

export default function ActiveMissions() {
  const router = useRouter();
  const { data: rows, error, loading } = usePoll(loadActive, MONITOR.activeMissionsPollMs);

  const markers = useMemo<MapMarker[]>(
    () =>
      (rows ?? [])
        .filter((r) => r.telemetry)
        .map(({ mission: m, telemetry: t }) => ({
          id: m.id,
          position: [t!.lat, t!.lon],
          color: MISSION_STATE[t!.state].color,
          label: `${t!.drone_id ?? m.drone_id} · ${MISSION_STATE[t!.state].label}`,
        })),
    [rows],
  );

  return (
    <>
      <MapView markers={markers} onMarkerClick={(id) => router.push(MONITOR_ROUTES.dashboard(Number(id)))} fitKey={rows && rows.length > 0 ? "active" : null} />
      <FloatingPanel backHref={MONITOR_ROUTES.home} title="Live dashboard" subtitle="Active missions">
        {error && (
          <Banner tone="danger" className="mb-3">
            {error}
          </Banner>
        )}
        {loading && !rows ? (
          <LoadingState text="Loading missions…" />
        ) : !rows ? null : rows.length === 0 ? (
          <EmptyState
            icon="drone"
            title="No UAV in the air"
            description="Approve a flight plan and launch the UAV to follow it here."
            action={
              <ButtonLink href={MONITOR_ROUTES.home} variant="secondary">
                Open the report queue
              </ButtonLink>
            }
          />
        ) : (
          <ul className="-mx-2 min-w-0 space-y-1">
            {rows.map(({ mission: m, telemetry: t }) => {
              const state = t?.state ?? m.state;
              const level = batteryLevel(t?.battery_pct);
              return (
                <li key={m.id}>
                  <Link
                    href={MONITOR_ROUTES.dashboard(m.id)}
                    className="flex min-h-14 min-w-0 items-center gap-3 rounded-xl px-2 py-2 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                      <Icon name="drone" size={18} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-semibold text-slate-900">{t?.drone_id ?? m.drone_id}</span>
                        <StatusBadge status={state} kind="mission" />
                      </span>
                      <span className="mt-0.5 block truncate text-sm text-slate-600">
                        Mission #{m.id} · Report #{m.report_id}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-xs text-slate-500">Battery</span>
                      <span className="text-sm font-semibold tabular-nums" style={{ color: level ? BATTERY.colors[level] : undefined }}>
                        {formatPct(t?.battery_pct)}
                      </span>
                    </span>
                    <Icon name="chevron-right" size={16} className="shrink-0 text-slate-400" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </FloatingPanel>
    </>
  );
}
