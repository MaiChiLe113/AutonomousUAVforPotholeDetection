// AI pre-check findings of a report (server detections), highest confidence first.

import { classLabel, formatConfidence } from "@/lib/format";
import type { Detection } from "@/lib/types";

export default function FindingsList({ detections }: { detections: Detection[] }) {
  const findings = detections.filter((d) => d.source === "server").sort((a, b) => b.confidence - a.confidence);
  if (findings.length === 0) return <p className="text-sm text-slate-600">No damage found.</p>;
  return (
    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
      {findings.map((d) => (
        <li key={d.id} className="flex min-w-0 items-center justify-between gap-2 px-3 py-2 text-sm">
          <span className="truncate text-slate-800">{classLabel(d.cls)}</span>
          <span className="shrink-0 font-medium text-slate-900 tabular-nums">{formatConfidence(d.confidence)}</span>
        </li>
      ))}
    </ul>
  );
}
