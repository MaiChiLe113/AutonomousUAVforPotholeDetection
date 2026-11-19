"use client";

// One UAV of the fleet: status, battery, swap countdown, mission / target and the last go / no-go decision.

import StatusBadge from "@/components/StatusBadge";
import { batteryLevel } from "@/components/monitor/FlightStatus";
import { ButtonLink, Button, Icon, ProgressBar } from "@/components/ui";
import { cn } from "@/lib/cn";
import { BATTERY, DECISION_ACTION, MONITOR, MONITOR_ROUTES } from "@/lib/config";
import { countdownTo, formatPct, timeAgo } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import type { Drone } from "@/lib/types";

export interface UavCardProps {
  drone: Drone;
  /** Recall a flying UAV (opens the reason dialog). Hidden when omitted. */
  onRecall?: (missionId: number, droneId: string) => void;
  /** Card with a border and shadow (grid). Without it the card is plain, for use inside a FloatingPanel. */
  framed?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  className?: string;
}

const fmtCoord = (n: number) => n.toFixed(4);

export default function UavCard({ drone, onRecall, framed = true, selected = false, onSelect, className }: UavCardProps) {
  const now = useNow(MONITOR.countdownClockMs);
  const level = batteryLevel(drone.battery_pct);
  const color = level ? BATTERY.colors[level] : undefined;
  const decision = drone.last_decision;
  const offline = drone.status === "offline";
  const canRecall = onRecall && drone.status === "flying" && drone.mission_id !== null;

  return (
    <article
      aria-label={`UAV ${drone.drone_id}`}
      className={cn(
        "flex min-w-0 flex-col gap-3",
        framed && "rounded-2xl border bg-white p-4 shadow-sm",
        framed && (selected ? "border-accent ring-2 ring-accent/30" : "border-slate-200"),
        offline && "opacity-75",
        className,
      )}
    >
      <header className="flex min-w-0 items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Icon name="drone" size={18} />
        </span>
        <div className="min-w-0 flex-1">
          {onSelect ? (
            <button type="button" onClick={onSelect} className="block max-w-full truncate text-left text-base font-semibold text-slate-900 hover:underline focus-visible:outline-2 focus-visible:outline-accent">
              {drone.drone_id}
            </button>
          ) : (
            <h3 className="truncate text-base font-semibold text-slate-900">{drone.drone_id}</h3>
          )}
        </div>
        <StatusBadge status={drone.status} kind="drone" />
      </header>

      <div>
        <ProgressBar label="Battery" value={drone.battery_pct} color={color} valueText={formatPct(drone.battery_pct)} />
        {drone.status === "swapping" && (
          <p className="mt-1 text-xs text-amber-800" role="status">
            Battery swap: ready in {countdownTo(drone.available_at, now)}
          </p>
        )}
        {level === "critical" && drone.status !== "swapping" && <p className="mt-1 text-xs font-medium text-red-700">Battery critical</p>}
      </div>

      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-slate-500">Mission</dt>
        <dd className="min-w-0 truncate text-slate-900">
          {drone.mission_id !== null ? `#${drone.mission_id}` : "None"}
          {drone.report_id !== null && <span className="text-slate-600"> · Report #{drone.report_id}</span>}
        </dd>
        <dt className="text-slate-500">Target</dt>
        <dd className="min-w-0 truncate tabular-nums text-slate-900">
          {drone.target ? `${fmtCoord(drone.target.lat)}, ${fmtCoord(drone.target.lon)}` : "None"}
        </dd>
      </dl>

      <div className="min-w-0 rounded-xl bg-slate-50 px-3 py-2 text-sm">
        <p className="text-xs text-slate-500">Last decision</p>
        {decision ? (
          <p className="mt-0.5 break-words text-slate-900">
            <span className="font-semibold" style={{ color: DECISION_ACTION[decision.action].fg }}>
              {DECISION_ACTION[decision.action].label}:
            </span>{" "}
            {decision.reason}
            <span className="ml-1 text-xs text-slate-500">{timeAgo(decision.at, now)}</span>
          </p>
        ) : (
          <p className="mt-0.5 text-slate-500">No decision yet</p>
        )}
      </div>

      {(drone.mission_id !== null || canRecall) && (
        <div className="flex flex-wrap gap-2">
          {drone.mission_id !== null && (
            <ButtonLink size="sm" variant="secondary" href={MONITOR_ROUTES.dashboard(drone.mission_id)}>
              Open live
            </ButtonLink>
          )}
          {canRecall && (
            <Button size="sm" variant="danger" onClick={() => onRecall(drone.mission_id!, drone.drone_id)}>
              Recall
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
