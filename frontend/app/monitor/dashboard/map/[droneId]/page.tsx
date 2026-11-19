"use client";

// /monitor/dashboard/map/<droneId>: the Digital twin selected on one UAV and following it (from the UAV card
// mini map on the Fleet tab). (RoleGate and the sidebar: ../../../layout.tsx)

import { useParams } from "next/navigation";

import FleetMap from "@/components/monitor/fleet/FleetMap";

export default function DashboardDroneMapPage() {
  const { droneId } = useParams<{ droneId: string }>();
  return <FleetMap droneId={decodeURIComponent(droneId)} />;
}
