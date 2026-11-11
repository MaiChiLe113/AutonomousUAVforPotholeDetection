"use client";

// Large view of one uploaded photo: photo, status, date, "Open report". Esc, the backdrop and Close dismiss it.

import { useEffect, useId, useRef } from "react";

import StatusBadge from "@/components/StatusBadge";
import { Button, ButtonLink, Icon } from "@/components/ui";
import { RESIDENT_ROUTES } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import type { Report } from "@/lib/types";

import ReportPhoto from "./ReportPhoto";
import { findingText } from "./reportProgress";

export interface PhotoViewerProps {
  report: Report;
  onClose: () => void;
}

export default function PhotoViewer({ report, onClose }: PhotoViewerProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Focus Close on open, Esc closes, focus returns to the tile afterwards.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="animate-sheet-in flex max-h-full w-full max-w-2xl min-w-0 flex-col overflow-hidden rounded-xl bg-white shadow-float-lg"
      >
        <div className="relative min-h-0 shrink bg-slate-900">
          <ReportPhoto path={report.photo_url} alt={`Photo of report #${report.id}`} variant="large" />
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute top-2 right-2 flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-slate-700 shadow-float hover:bg-white focus-visible:outline-2 focus-visible:outline-accent"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="min-w-0 shrink-0 p-4">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <h2 id={titleId} className="truncate text-base font-semibold text-slate-900">
              Report #{report.id}
            </h2>
            <StatusBadge status={report.status} kind="report" size="md" />
          </div>
          <p className="mt-1 text-sm text-slate-600">
            {findingText(report)} · Sent {formatDateTime(report.created_at)}
          </p>
          <div className="mt-4 flex gap-2">
            <ButtonLink href={RESIDENT_ROUTES.report(report.id)} className="min-w-0 flex-1">
              Open report
            </ButtonLink>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
