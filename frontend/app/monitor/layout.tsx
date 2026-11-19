// Every page under /monitor: Monitor role only, inside the sidebar frame (Fleet, Map, Reports, History).

import type { ReactNode } from "react";

import MonitorShell from "@/components/monitor/MonitorShell";
import RoleGate from "@/components/RoleGate";

export default function MonitorLayout({ children }: { children: ReactNode }) {
  return (
    <RoleGate role="monitor">
      <MonitorShell>{children}</MonitorShell>
    </RoleGate>
  );
}
