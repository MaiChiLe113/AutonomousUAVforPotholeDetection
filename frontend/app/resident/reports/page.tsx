"use client";

// UC-R2 My reports (SCRUM-45): reports sent from this browser, newest first, with status chips,
// and their pins on the map. Each row and pin opens /resident/reports/{id}. (RoleGate: app/resident/layout.tsx)

import { useRouter } from "next/navigation";

import MapView from "@/components/MapView";
import MyReportsList from "@/components/resident/MyReportsList";
import { reportMarkers } from "@/components/resident/reportMarkers";
import { useMyReportList } from "@/components/resident/useResidentReports";
import { FloatingPanel } from "@/components/ui";
import { RESIDENT_ROUTES } from "@/lib/config";

export default function MyReportsPage() {
  const router = useRouter();
  const list = useMyReportList(true);
  const markers = reportMarkers(list.reports);
  const count = list.reports?.length ?? 0;

  return (
    <>
      <MapView
        markers={markers}
        onMarkerClick={(id) => router.push(RESIDENT_ROUTES.report(id))}
        fitKey={markers.length > 0 ? `mine-${markers.length}` : null}
      />
      <FloatingPanel
        title="My reports"
        subtitle={count > 0 ? `${count} sent from this browser` : "Sent from this browser"}
        backHref={RESIDENT_ROUTES.home}
      >
        <MyReportsList list={list} />
      </FloatingPanel>
    </>
  );
}
