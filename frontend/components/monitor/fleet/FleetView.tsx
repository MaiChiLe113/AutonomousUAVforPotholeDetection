"use client";

// Fleet tab (/monitor/dashboard): header strip, one card per UAV, then the inspection queue.

import { useState } from "react";

import { Banner, Button, LoadingState } from "@/components/ui";
import { ApiError, tickDispatcher } from "@/lib/api";

import { useFleet } from "./FleetContext";
import FleetHeader from "./FleetHeader";
import QueueList from "./QueueList";
import UavCard from "./UavCard";
import { useFleetActions } from "./useFleetActions";

export default function FleetView() {
  const { data: fleet, error, loading, refresh } = useFleet();
  const actions = useFleetActions(refresh);
  const [ticking, setTicking] = useState(false);
  const [tickError, setTickError] = useState<string | null>(null);

  async function runTick() {
    setTicking(true);
    setTickError(null);
    try {
      await tickDispatcher();
      refresh();
    } catch (e) {
      setTickError(e instanceof ApiError ? e.message : "Could not run the dispatcher.");
    } finally {
      setTicking(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 p-4">
      {error && (
        <Banner tone="danger" title={fleet ? "Showing the last known fleet" : "Fleet not available"}>
          {error}
        </Banner>
      )}
      {loading && !fleet ? (
        <LoadingState text="Loading fleet…" />
      ) : fleet ? (
        <>
          <FleetHeader fleet={fleet} />
          <section aria-label="UAVs" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {fleet.drones.map((d) => (
              <UavCard key={d.drone_id} drone={d} onRecall={actions.askRecall} />
            ))}
          </section>
          <section aria-label="Inspection queue" className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-900">Inspection queue</h2>
              <Button size="sm" variant="secondary" loading={ticking} onClick={runTick} title="Check the queue now instead of waiting for the next automatic run">
                Dispatch now
              </Button>
            </div>
            {tickError && <Banner tone="danger">{tickError}</Banner>}
            <QueueList queue={fleet.queue} onCancel={actions.askCancel} />
          </section>
        </>
      ) : null}
      {actions.dialog}
    </div>
  );
}
