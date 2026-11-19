"use client";

// One GET /fleet poll shared by the three dashboard tabs (the provider lives in MonitorShell, so switching
// tabs does not restart the polling).

import { createContext, useContext, type ReactNode } from "react";

import { getFleet } from "@/lib/api";
import { MONITOR } from "@/lib/config";
import { usePoll, type PollResult } from "@/lib/hooks";
import type { Fleet } from "@/lib/types";

const FleetContext = createContext<PollResult<Fleet> | null>(null);

/** Polls GET /fleet every MONITOR.fleetPollMs while `enabled`. */
export function FleetProvider({ enabled = true, children }: { enabled?: boolean; children: ReactNode }) {
  const poll = usePoll(getFleet, MONITOR.fleetPollMs, { enabled });
  return <FleetContext.Provider value={poll}>{children}</FleetContext.Provider>;
}

/** The latest fleet snapshot (data is null until the first answer). Only valid under <FleetProvider>. */
export function useFleet(): PollResult<Fleet> {
  const ctx = useContext(FleetContext);
  if (!ctx) throw new Error("useFleet must be used inside <FleetProvider>");
  return ctx;
}
