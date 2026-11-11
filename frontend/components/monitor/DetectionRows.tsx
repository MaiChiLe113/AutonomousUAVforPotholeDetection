"use client";

// Detection rows: server pre-check boxes on the review page (with "Wrong detection"), edge boxes on the
// dashboard result (read-only, with deployment and position). Row numbers match DetectionOverlay tags.

import { useState } from "react";

import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { classLabel, formatConfidence } from "@/lib/format";
import type { Detection } from "@/lib/types";

export interface DetectionRowsProps {
  detections: Detection[];
  /** When set, unflagged rows show "Wrong detection"; it should call flagDetection and update the data. */
  onFlag?: (d: Detection) => Promise<void>;
  /** Row hovered / focused (emphasises the matching box). */
  activeId?: number | null;
  onActiveChange?: (id: number | null) => void;
  /** Edge results: show deployment and lat/lon instead of model version and frame id. */
  variant?: "server" | "edge";
}

export default function DetectionRows({ detections, onFlag, activeId = null, onActiveChange, variant = "server" }: DetectionRowsProps) {
  return (
    <ul className="min-w-0 divide-y divide-slate-100">
      {detections.map((d, i) => (
        <DetectionRow
          key={d.id}
          index={i}
          d={d}
          onFlag={onFlag}
          active={d.id === activeId}
          onActiveChange={onActiveChange}
          variant={variant}
        />
      ))}
    </ul>
  );
}

function DetectionRow({
  index,
  d,
  onFlag,
  active,
  onActiveChange,
  variant,
}: {
  index: number;
  d: Detection;
  onFlag?: (d: Detection) => Promise<void>;
  active: boolean;
  onActiveChange?: (id: number | null) => void;
  variant: "server" | "edge";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function flag() {
    if (!onFlag || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onFlag(d);
    } catch (e) {
      setError((e as Error).message || "Could not flag this detection.");
    } finally {
      setBusy(false);
    }
  }

  const meta =
    variant === "edge"
      ? [d.deployment, d.lat != null && d.lon != null ? `${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}` : null, d.frame_id]
      : [`Model ${d.model_version}`, `Frame ${d.frame_id}`];

  return (
    <li
      className={cn("flex min-w-0 items-start gap-3 py-2.5", active && "bg-accent-soft/60")}
      onMouseEnter={() => onActiveChange?.(d.id)}
      onMouseLeave={() => onActiveChange?.(null)}
    >
      <span
        className={cn(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
          d.flagged_wrong ? "bg-slate-200 text-slate-500" : "bg-amber-400 text-slate-900",
        )}
        aria-hidden
      >
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className={cn("text-sm font-medium text-slate-900", d.flagged_wrong && "text-slate-500 line-through")}>
            {classLabel(d.cls)} <span className="font-normal text-slate-500">({d.cls})</span>
          </span>
          <span className="text-sm font-semibold text-slate-900 tabular-nums">{formatConfidence(d.confidence)}</span>
        </div>
        <div className="mt-0.5 text-xs break-words text-slate-500">{meta.filter(Boolean).join(" · ")}</div>
        {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
      </div>
      {d.flagged_wrong ? (
        <span className="mt-0.5 shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">Flagged</span>
      ) : onFlag ? (
        <Button
          variant="ghost"
          className="-mr-3 -my-1 shrink-0 px-3 text-red-700 hover:bg-red-50"
          loading={busy}
          onClick={flag}
          onFocus={() => onActiveChange?.(d.id)}
          onBlur={() => onActiveChange?.(null)}
        >
          Wrong detection
        </Button>
      ) : null}
    </li>
  );
}
