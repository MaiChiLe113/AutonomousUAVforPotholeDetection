"use client";

// Photo history: a grid of the photos I uploaded (my reports' photo_url), each with status and date.
// Tapping a tile opens a large view (?photo=ID, so the home hub strip can link straight to it).
// A normal scrolling page, no map. (RoleGate: app/resident/layout.tsx)

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { MissingNote, NoReportsYet } from "@/components/resident/MyReportsList";
import PhotoGrid from "@/components/resident/PhotoGrid";
import PhotoViewer from "@/components/resident/PhotoViewer";
import { useMyReportList } from "@/components/resident/useResidentReports";
import { Banner, Icon, LoadingState } from "@/components/ui";
import { RESIDENT_ROUTES } from "@/lib/config";

export default function PhotoHistoryPage() {
  return (
    <div className="min-h-full bg-slate-50">
      <div className="mx-auto w-full max-w-5xl min-w-0 px-4 py-4 sm:py-6">
        <Suspense fallback={<LoadingState text="Loading your photos…" />}>
          <PhotoHistory />
        </Suspense>
      </div>
    </div>
  );
}

function PhotoHistory() {
  const searchParams = useSearchParams();
  const openId = Number(searchParams.get("photo")) || null;
  const list = useMyReportList(true);
  const { reports, missing, loading, error } = list;
  const selected = openId !== null ? (reports?.find((r) => r.id === openId) ?? null) : null;

  // The URL holds the open photo (native history calls are synced with useSearchParams).
  const open = (id: number) => window.history.replaceState(null, "", RESIDENT_ROUTES.photo(id));
  const close = () => window.history.replaceState(null, "", RESIDENT_ROUTES.photos);

  return (
    <>
      <header className="mb-4 flex min-w-0 items-center gap-2">
        <Link
          href={RESIDENT_ROUTES.home}
          aria-label="Back"
          className="-ml-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-600 hover:bg-slate-200/60 focus-visible:outline-2 focus-visible:outline-accent"
        >
          <Icon name="back" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg leading-tight font-semibold text-slate-900">My photos</h1>
          <p className="truncate text-sm text-slate-500">
            {reports && reports.length > 0
              ? `${reports.length} ${reports.length === 1 ? "photo" : "photos"} sent from this browser`
              : "Photos you sent with your reports"}
          </p>
        </div>
      </header>

      {error && reports && (
        <p role="status" className="mb-3 text-xs text-amber-700">
          Reconnecting… showing the last known status.
        </p>
      )}

      {!reports ? (
        error ? (
          <Banner tone="danger" title="Cannot load your photos">
            {error} Trying again…
          </Banner>
        ) : (
          loading && <LoadingState text="Loading your photos…" />
        )
      ) : reports.length === 0 ? (
        <div className="rounded-xl bg-white shadow-float">
          <NoReportsYet missing={missing} />
        </div>
      ) : (
        <>
          <PhotoGrid reports={reports} onOpen={open} />
          <MissingNote missing={missing} />
        </>
      )}

      {selected && <PhotoViewer report={selected} onClose={close} />}
    </>
  );
}
