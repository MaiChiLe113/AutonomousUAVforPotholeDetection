"use client";

// Simulator tab (/monitor/dashboard/simulator): the standalone RDMO Unity WebGL simulator in an iframe.
// Nothing loads until "Launch simulator" (the build is ~187 MB). It is not connected to the fleet.

import { useEffect, useRef, useState } from "react";

import { Banner, Button, Icon, LoadingState } from "@/components/ui";
import { SIMULATOR } from "@/lib/config";

type Availability = "checking" | "ready" | "missing";

export default function SimulatorView() {
  const [availability, setAvailability] = useState<Availability>("checking");
  const [running, setRunning] = useState(false);
  const frameBox = useRef<HTMLDivElement>(null);

  // Is the build installed? A HEAD request is enough, nothing big is downloaded.
  useEffect(() => {
    let cancelled = false;
    fetch(SIMULATOR.src, { method: "HEAD", cache: "no-store" })
      .then((res) => !cancelled && setAvailability(res.ok ? "ready" : "missing"))
      .catch(() => !cancelled && setAvailability("missing"));
    return () => {
      cancelled = true;
    };
  }, []);

  function fullscreen() {
    frameBox.current?.requestFullscreen?.().catch(() => undefined);
  }

  if (running) {
    return (
      <div className="absolute inset-0 flex flex-col bg-slate-900">
        <div className="flex h-12 shrink-0 items-center gap-2 bg-white px-3">
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">{SIMULATOR.title}</p>
          <Button size="sm" variant="secondary" onClick={fullscreen}>
            Fullscreen
          </Button>
          <Button size="sm" variant="danger" onClick={() => setRunning(false)} title="Close the simulator and free its memory">
            Stop
          </Button>
        </div>
        {/* The iframe keeps the Unity canvas size at least; a smaller pane scrolls instead of squeezing it. */}
        <div ref={frameBox} className="min-h-0 flex-1 overflow-auto bg-slate-900">
          <iframe
            src={SIMULATOR.src}
            title={SIMULATOR.title}
            allow="fullscreen"
            className="block h-full w-full border-0"
            style={{ minWidth: SIMULATOR.minWidthPx, minHeight: SIMULATOR.minHeightPx }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-xl p-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Icon name="drone" size={20} />
        </span>
        <h1 className="text-lg font-semibold text-slate-900">{SIMULATOR.title}</h1>
        <p className="mt-1 text-sm text-slate-600">{SIMULATOR.description}</p>

        <Banner tone="warning" className="mt-4">
          {SIMULATOR.standalone}
        </Banner>
        <ul className="mt-4 space-y-1.5 text-sm text-slate-600">
          <li>{SIMULATOR.downloadNote}</li>
          <li>{SIMULATOR.detectionNote}</li>
        </ul>

        <div className="mt-5">
          {availability === "checking" ? (
            <LoadingState text="Checking the simulator files…" className="py-2" />
          ) : availability === "missing" ? (
            <Banner tone="danger" title={SIMULATOR.notInstalled}>
              {SIMULATOR.installHint}
              <code className="mt-1 block rounded bg-white/70 px-2 py-1 text-xs break-all">{SIMULATOR.installCommand}</code>
            </Banner>
          ) : (
            <Button size="lg" fullWidth icon={<Icon name="play" size={18} />} onClick={() => setRunning(true)}>
              Launch simulator
            </Button>
          )}
        </div>

        <p className="mt-4 text-xs text-slate-500">
          {SIMULATOR.creditText}.{" "}
          <a href={SIMULATOR.repoUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
            Source on GitHub
          </a>
        </p>
      </section>
    </div>
  );
}
