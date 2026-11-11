// Home hub: my latest uploads as a horizontal strip. Each thumbnail opens its large view in the photo history.

import Link from "next/link";

import { RESIDENT, RESIDENT_ROUTES } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import type { Report } from "@/lib/types";

import ReportPhoto from "./ReportPhoto";

export default function PhotoStrip({ reports }: { reports: Report[] }) {
  return (
    <ul aria-label="My latest photos" className="-mx-1 flex min-w-0 gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
      {reports.map((r) => (
        <li key={r.id} className="shrink-0">
          <Link
            href={RESIDENT_ROUTES.photo(r.id)}
            title={`Report #${r.id} · ${formatDateTime(r.created_at)}`}
            className="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <ReportPhoto path={r.photo_url} alt={`Photo of report #${r.id}`} variant="thumb" size={RESIDENT.stripThumbPx} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
