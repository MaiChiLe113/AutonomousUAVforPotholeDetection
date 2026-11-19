"use client";

// /monitor/dashboard is the Fleet tab (3 UAV cards + inspection queue).
// /monitor/dashboard?mission=ID is the live view of one mission (SCRUM-39, UC-M4, UC-M5); the layout then
// keeps its full-bleed map inside the content pane next to the monitor sidebar.
// useSearchParams needs the <Suspense> boundary for `next build`.

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import FleetView from "@/components/monitor/fleet/FleetView";
import MissionDashboard from "@/components/monitor/MissionDashboard";
import { ButtonLink, EmptyState, FloatingPanel, LoadingState } from "@/components/ui";
import { MONITOR_ROUTES } from "@/lib/config";

export default function DashboardPage() {
  return (
    <Suspense fallback={<LoadingState className="absolute inset-0" />}>
      <Dashboard />
    </Suspense>
  );
}

function Dashboard() {
  const raw = useSearchParams().get("mission");
  if (raw === null || raw === "") return <FleetView />;

  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return (
      <FloatingPanel backHref={MONITOR_ROUTES.dashboard()} title="Live dashboard">
        <EmptyState
          title="Mission not found"
          description={`"${raw}" is not a mission id.`}
          action={
            <ButtonLink href={MONITOR_ROUTES.dashboard()} variant="secondary">
              Show the fleet
            </ButtonLink>
          }
        />
      </FloatingPanel>
    );
  }
  // key: a new mission id starts with fresh state (telemetry, trail, camera).
  return <MissionDashboard key={id} missionId={id} />;
}
