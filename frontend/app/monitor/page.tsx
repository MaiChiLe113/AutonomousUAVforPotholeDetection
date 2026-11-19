"use client";

// UC-M1 report queue (SCRUM-23, SCRUM-29), the Reports tab: a filtered list on the left, the map with every
// report as a status-coloured pin on the right (list above the map on narrow screens).
// Selecting a row or a pin flies the map to it; "Open" goes to the review page. Refreshes every 10 s.

import Link from "next/link";
import { useMemo, useState } from "react";

import MapView, { type FlyTarget, type MapMarker } from "@/components/MapView";
import { QUEUE_FILTERS, queueFilterOf, topDetection, type QueueFilter } from "@/components/monitor/queue";
import RoleGate from "@/components/RoleGate";
import StatusBadge from "@/components/StatusBadge";
import { Banner, Chip, ChipRow, EmptyState, Icon, LoadingState } from "@/components/ui";
import { listReports } from "@/lib/api";
import { cn } from "@/lib/cn";
import { MONITOR, MONITOR_ROUTES, REPORT_STATUS, SIM } from "@/lib/config";
import { classLabel, formatConfidence, parseApiDate, timeAgo } from "@/lib/format";
import { useNow, usePoll } from "@/lib/hooks";
import type { Report } from "@/lib/types";

export default function MonitorPage() {
  return (
    <RoleGate role="monitor">
      <ReportQueue />
    </RoleGate>
  );
}

const newestFirst = (a: Report, b: Report) =>
  (parseApiDate(b.created_at)?.getTime() ?? 0) - (parseApiDate(a.created_at)?.getTime() ?? 0) || b.id - a.id;

function ReportQueue() {
  const { data: reports, error, loading } = usePoll(() => listReports(), SIM.reportQueuePollMs);
  const [filter, setFilter] = useState<QueueFilter>("needs_review");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [fly, setFly] = useState<FlyTarget | null>(null);
  const now = useNow(MONITOR.queueClockMs); // "25 min ago" labels

  const counts = useMemo(() => {
    const c: Record<QueueFilter, number> = { needs_review: 0, flight_plans: 0, in_flight: 0, done: 0 };
    for (const r of reports ?? []) c[queueFilterOf(r)] += 1;
    return c;
  }, [reports]);

  const visible = useMemo(() => (reports ?? []).filter((r) => queueFilterOf(r) === filter).sort(newestFirst), [reports, filter]);

  const markers = useMemo<MapMarker[]>(
    () =>
      visible.map((r) => ({
        id: r.id,
        position: [r.lat, r.lon],
        color: REPORT_STATUS[r.status].color,
        label: `#${r.id} · ${REPORT_STATUS[r.status].label}`,
      })),
    [visible],
  );

  function select(r: Report, scrollRow: boolean) {
    setSelectedId(r.id);
    setFly({ center: [r.lat, r.lon], key: Date.now() });
    if (scrollRow) document.getElementById(`report-row-${r.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function onMarkerClick(id: string | number) {
    const r = visible.find((x) => x.id === id);
    if (r) select(r, true);
  }

  const current = QUEUE_FILTERS.find((f) => f.value === filter)!;

  return (
    <div className="absolute inset-0 flex flex-col md:flex-row">
      <section aria-label="Report queue" className="flex max-h-[55%] min-h-0 shrink-0 flex-col border-b border-slate-200 bg-white md:max-h-none md:w-[420px] md:border-r md:border-b-0">
        <header className="shrink-0 px-4 pt-4 pb-3">
          <h1 className="text-lg leading-tight font-semibold text-slate-900">Report queue</h1>
          <p className="mt-0.5 truncate text-sm text-slate-500">
            {reports ? `${reports.length} reports · refreshes every ${Math.round(SIM.reportQueuePollMs / 1000)} s` : "Loading reports…"}
          </p>
        </header>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 pb-4">
        <ChipRow className="mb-3">
          {QUEUE_FILTERS.map((f) => (
            <Chip key={f.value} active={filter === f.value} count={reports ? counts[f.value] : undefined} onClick={() => setFilter(f.value)}>
              {f.label}
            </Chip>
          ))}
        </ChipRow>

        {error && (
          <Banner tone="danger" className="mb-3">
            {reports ? "Could not refresh the queue; trying again. " : ""}
            {error}
          </Banner>
        )}

        {loading && !reports ? (
          <LoadingState text="Loading reports…" />
        ) : !reports ? null : visible.length === 0 ? (
          <EmptyState title={current.empty} description="Pick another filter to see more reports." />
        ) : (
          <ul className="-mx-2 min-w-0 space-y-1">
            {visible.map((r) => (
              <ReportRow key={r.id} report={r} selected={r.id === selectedId} now={now} onSelect={() => select(r, false)} />
            ))}
          </ul>
        )}
        </div>
      </section>
      <div className="relative min-h-0 min-w-0 flex-1">
        <MapView
          markers={markers}
          selectedId={selectedId}
          onMarkerClick={onMarkerClick}
          flyTo={fly}
          avoidPanel={false}
          // Fit the chip's pins once the data arrives and whenever the chip changes.
          fitKey={reports ? filter : null}
        />
      </div>
    </div>
  );
}

function ReportRow({ report: r, selected, now, onSelect }: { report: Report; selected: boolean; now: number; onSelect: () => void }) {
  const top = topDetection(r.detections);
  const summary = top ? `${classLabel(top.cls)} ${formatConfidence(top.confidence)}` : r.status === "no_damage" ? "No damage found" : "No detections";
  const extra =
    r.status === "uav_dispatched" && r.mission_id != null
      ? { href: MONITOR_ROUTES.dashboard(r.mission_id), label: "Open live dashboard" }
      : r.status === "under_review" && r.latest_plan_id != null && (r.latest_plan_status === "proposed" || r.latest_plan_status === "approved")
        ? { href: MONITOR_ROUTES.plan(r.latest_plan_id), label: `Open flight plan #${r.latest_plan_id}` }
        : (r.status === "confirmed" || r.status === "not_confirmed") && r.mission_id != null
          ? { href: MONITOR_ROUTES.dashboard(r.mission_id), label: "Open mission result" }
          : null;

  return (
    <li id={`report-row-${r.id}`} className={cn("min-w-0 rounded-xl", selected ? "bg-accent-soft" : "hover:bg-slate-50")}>
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2 text-left focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span className="h-3 w-3 shrink-0 rounded-full ring-2 ring-white" style={{ background: REPORT_STATUS[r.status].color }} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="text-sm font-semibold text-slate-900">#{r.id}</span>
              <StatusBadge status={r.status} kind="report" />
            </span>
            <span className="mt-0.5 block truncate text-sm text-slate-600">
              {summary} · {timeAgo(r.created_at, now)}
            </span>
          </span>
        </button>
        <Link
          href={MONITOR_ROUTES.report(r.id)}
          className="flex h-11 shrink-0 items-center gap-0.5 rounded-full px-3 text-sm font-medium text-accent hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent"
        >
          Open
          <Icon name="chevron-right" size={16} />
        </Link>
      </div>
      {selected && extra && (
        <div className="px-2 pb-2 pl-9">
          <Link href={extra.href} className="text-sm font-medium text-accent hover:underline">
            {extra.label} →
          </Link>
        </div>
      )}
    </li>
  );
}
