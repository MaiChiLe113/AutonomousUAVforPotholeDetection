// Photo history grid: one tile per report photo, with status chip and date. Tiles are at least
// RESIDENT.photoTileMinPx wide (2 columns at 375 px, more on wider screens).

import StatusBadge from "@/components/StatusBadge";
import { RESIDENT } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import type { Report } from "@/lib/types";

import ReportPhoto from "./ReportPhoto";

export interface PhotoGridProps {
  reports: Report[];
  onOpen: (id: number) => void;
}

export default function PhotoGrid({ reports, onOpen }: PhotoGridProps) {
  return (
    <ul
      aria-label="My photos"
      className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${RESIDENT.photoTileMinPx}px, 100%), 1fr))` }}
    >
      {reports.map((r) => (
        <li key={r.id} className="min-w-0">
          <button
            type="button"
            onClick={() => onOpen(r.id)}
            aria-label={`Open the photo of report #${r.id}`}
            className="block w-full min-w-0 overflow-hidden rounded-xl bg-white text-left shadow-float transition-shadow hover:shadow-float-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <ReportPhoto path={r.photo_url} alt={`Photo of report #${r.id}`} variant="tile" />
            <div className="min-w-0 px-2.5 py-2">
              <StatusBadge status={r.status} kind="report" />
              <p className="mt-1 truncate text-xs text-slate-500">
                #{r.id} · {formatDateTime(r.created_at)}
              </p>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
