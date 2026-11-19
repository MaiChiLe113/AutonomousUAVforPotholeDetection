"use client";

// History tab (/monitor/dashboard/history): finished missions, newest first, and the decision log that shows
// when the UAVs decided to launch, hold or recall on their own.

import Link from "next/link";
import { useMemo, useRef } from "react";

import StatusBadge from "@/components/StatusBadge";
import { Banner, Chip, EmptyState, LoadingState } from "@/components/ui";
import { listMissionDetections, listMissions } from "@/lib/api";
import { MONITOR, MONITOR_ROUTES } from "@/lib/config";
import { formatDuration, formatTime, parseApiDate } from "@/lib/format";
import { usePoll } from "@/lib/hooks";
import type { FlightDecision, Mission } from "@/lib/types";

import { useFleet } from "./FleetContext";

interface Row {
  mission: Mission;
  detections: number | null; // null: not known (failed mission, or the request failed)
}

const FINISHED: Mission["state"][] = ["done", "failed"];

function durationS(m: Mission): number | null {
  const a = parseApiDate(m.started_at);
  const b = parseApiDate(m.finished_at);
  return a && b ? (b.getTime() - a.getTime()) / 1000 : null;
}

export default function HistoryView() {
  const { data: fleet, error: fleetError } = useFleet();

  // A finished mission never changes, so its detection count is fetched once.
  const counts = useRef(new Map<number, number>());
  const { data: rows, error, loading } = usePoll(async (): Promise<Row[]> => {
    const missions = (await listMissions(false)).filter((m) => FINISHED.includes(m.state)).slice(0, MONITOR.historyMaxMissions);
    return Promise.all(
      missions.map(async (mission) => {
        if (mission.state !== "done") return { mission, detections: null };
        let n = counts.current.get(mission.id);
        if (n === undefined) {
          try {
            n = (await listMissionDetections(mission.id)).length;
            counts.current.set(mission.id, n);
          } catch {
            return { mission, detections: null };
          }
        }
        return { mission, detections: n };
      }),
    );
  }, MONITOR.historyPollMs);

  const decisions = useMemo(() => (fleet?.decisions ?? []).slice(0, MONITOR.decisionsShown), [fleet]);
  const recalledReports = useMemo(() => new Set(decisions.filter((d) => d.action === "recall").map((d) => d.report_id)), [decisions]);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4">
      <section aria-label="Missions" className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">Finished missions</h2>
        {error && <Banner tone="danger">{error}</Banner>}
        {loading && !rows ? (
          <LoadingState text="Loading missions…" />
        ) : rows && rows.length === 0 ? (
          <EmptyState icon="history" title="No finished missions yet" description="Completed, failed and recalled flights appear here." />
        ) : rows ? (
          <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
            {rows.map(({ mission: m, detections }) => {
              const d = durationS(m);
              return (
                <li key={m.id}>
                  <Link
                    href={MONITOR_ROUTES.dashboard(m.id)}
                    className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <span className="min-w-0 flex-1 basis-40">
                      <span className="block truncate text-sm font-semibold text-slate-900">
                        Mission #{m.id} · {m.drone_id}
                      </span>
                      <span className="block truncate text-sm text-slate-600">Report #{m.report_id}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <StatusBadge status={m.state} kind="mission" />
                      {m.state === "failed" && recalledReports.has(m.report_id) && <Chip>Recalled</Chip>}
                    </span>
                    <span className="w-20 text-right text-sm text-slate-600 tabular-nums">{formatDuration(d)}</span>
                    <span className="w-24 text-right text-sm text-slate-600 tabular-nums">
                      {detections === null ? "–" : `${detections} ${detections === 1 ? "detection" : "detections"}`}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      <section aria-label="Decision log" className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">Decision log</h2>
        <p className="text-sm text-slate-500">Every launch, hold and recall the UAVs decided on, with the reason.</p>
        {fleetError && !fleet && <Banner tone="danger">{fleetError}</Banner>}
        {!fleet && !fleetError ? (
          <LoadingState text="Loading decisions…" />
        ) : decisions.length === 0 ? (
          <EmptyState icon="info" title="No decisions yet" description="The dispatcher logs a decision whenever it launches, holds or recalls a UAV." />
        ) : (
          <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
            {decisions.map((d) => (
              <DecisionRow key={d.id} d={d} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function DecisionRow({ d }: { d: FlightDecision }) {
  return (
    <li className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
      <span className="w-16 shrink-0 pt-0.5 text-xs text-slate-500 tabular-nums">{formatTime(d.at)}</span>
      <span className="w-20 shrink-0">
        <StatusBadge status={d.action} kind="decision" />
      </span>
      <span className="min-w-0 flex-1 basis-48">
        <span className="block break-words text-sm text-slate-900">{d.reason}</span>
        <span className="block truncate text-xs text-slate-500">
          {[d.drone_id, d.report_id !== null ? `Report #${d.report_id}` : null, d.code].filter(Boolean).join(" · ")}
        </span>
      </span>
    </li>
  );
}
