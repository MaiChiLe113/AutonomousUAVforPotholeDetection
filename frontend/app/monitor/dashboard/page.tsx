"use client";

// SCRUM-39 live UAV dashboard. /monitor/dashboard?mission=ID follows one mission (UC-M4, UC-M5);
// without ?mission it lists the active missions. useSearchParams needs the <Suspense> boundary for `next build`.

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import ActiveMissions from "@/components/monitor/ActiveMissions";
import MissionDashboard from "@/components/monitor/MissionDashboard";
import RoleGate from "@/components/RoleGate";
import { ButtonLink, EmptyState, FloatingPanel, LoadingState } from "@/components/ui";
import { MONITOR_ROUTES } from "@/lib/config";

export default function DashboardPage() {
  return (
    <RoleGate role="monitor">
      <Suspense fallback={<LoadingState className="absolute inset-0" />}>
        <Dashboard />
      </Suspense>
    </RoleGate>
  );
}

function Dashboard() {
  const raw = useSearchParams().get("mission");
  if (raw === null || raw === "") return <ActiveMissions />;

  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return (
      <FloatingPanel backHref={MONITOR_ROUTES.dashboard()} title="Live dashboard">
        <EmptyState
          title="Mission not found"
          description={`"${raw}" is not a mission id.`}
          action={
            <ButtonLink href={MONITOR_ROUTES.dashboard()} variant="secondary">
              Show active missions
            </ButtonLink>
          }
        />
      </FloatingPanel>
    );
  }
  // key: a new mission id starts with fresh state (telemetry, trail, camera).
  return <MissionDashboard key={id} missionId={id} />;
}
