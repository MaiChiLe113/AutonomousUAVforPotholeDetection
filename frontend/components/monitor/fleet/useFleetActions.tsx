"use client";

// Monitor overrides on the dashboard: recall a flying UAV, cancel a queued task. Both ask for a reason in a dialog.

import { useState, type ReactNode } from "react";

import { ReasonDialog } from "@/components/ui";
import { cancelReport, recallMission } from "@/lib/api";

type Pending = { kind: "recall"; missionId: number; droneId: string } | { kind: "cancel"; reportId: number };

export interface FleetActions {
  askRecall: (missionId: number, droneId: string) => void;
  askCancel: (reportId: number) => void;
  /** Render once next to the buttons that call askRecall / askCancel. */
  dialog: ReactNode;
}

/** `onDone` runs after a successful action (refresh the fleet). */
export function useFleetActions(onDone: () => void): FleetActions {
  const [pending, setPending] = useState<Pending | null>(null);

  const dialog = (
    <ReasonDialog
      open={pending !== null}
      title={pending?.kind === "recall" ? `Recall ${pending.droneId}?` : pending ? `Cancel the task for report #${pending.reportId}?` : ""}
      description={
        pending?.kind === "recall"
          ? "The UAV flies back to base and its task is queued again."
          : "The task leaves the queue and its reports are closed as rejected."
      }
      label="Reason"
      submitLabel={pending?.kind === "recall" ? "Recall UAV" : "Cancel task"}
      onSubmit={async (reason) => {
        if (!pending) return;
        if (pending.kind === "recall") await recallMission(pending.missionId, reason);
        else await cancelReport(pending.reportId, reason);
        onDone();
      }}
      onClose={() => setPending(null)}
    />
  );

  return {
    askRecall: (missionId, droneId) => setPending({ kind: "recall", missionId, droneId }),
    askCancel: (reportId) => setPending({ kind: "cancel", reportId }),
    dialog,
  };
}
