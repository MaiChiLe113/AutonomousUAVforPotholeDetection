// My reports as map dots coloured by status (home hub and My reports map).

import { REPORT_STATUS } from "@/lib/config";
import type { MapMarker } from "@/lib/map";
import type { Report } from "@/lib/types";

export function reportMarkers(reports: Report[] | null): MapMarker[] {
  return (reports ?? []).map((r) => ({
    id: r.id,
    position: [r.lat, r.lon],
    color: REPORT_STATUS[r.status].color,
    label: `Report #${r.id} · ${REPORT_STATUS[r.status].label}`,
  }));
}
