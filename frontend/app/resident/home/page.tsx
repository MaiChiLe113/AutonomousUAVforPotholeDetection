"use client";

// Resident home hub: my report pins on the map; panel with "Report a pothole", status counts,
// my latest reports and my latest photos. (RoleGate: app/resident/layout.tsx)

import Link from "next/link";
import { useRouter } from "next/navigation";

import MapView from "@/components/MapView";
import MyReportsList, { MissingNote, NoReportsYet } from "@/components/resident/MyReportsList";
import PhotoStrip from "@/components/resident/PhotoStrip";
import StatusCounts from "@/components/resident/StatusCounts";
import { reportMarkers } from "@/components/resident/reportMarkers";
import { isFinalStatus } from "@/components/resident/reportProgress";
import { useMyReportList } from "@/components/resident/useResidentReports";
import { ButtonLink, FloatingPanel, Icon, PanelSection } from "@/components/ui";
import { RESIDENT, RESIDENT_ROUTES } from "@/lib/config";
import { useSession } from "@/lib/session";

function SeeAll({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-full px-2 py-1 text-sm font-medium text-accent hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent"
    >
      See all
      <Icon name="chevron-right" size={16} />
    </Link>
  );
}

export default function ResidentHomePage() {
  const router = useRouter();
  const { session } = useSession();
  const list = useMyReportList(true);
  const { reports, missing, error } = list;
  const markers = reportMarkers(reports);
  const isNew = reports !== null && reports.length === 0 && !error;
  const openCount = reports?.filter((r) => !isFinalStatus(r.status)).length ?? 0;

  return (
    <>
      <MapView
        markers={markers}
        onMarkerClick={(id) => router.push(RESIDENT_ROUTES.report(id))}
        fitKey={markers.length > 0 ? `home-${markers.length}` : null}
      />

      <FloatingPanel
        title={session?.name ? `Hi, ${session.name}` : "Welcome"}
        subtitle={
          reports && reports.length > 0
            ? `${reports.length} ${reports.length === 1 ? "report" : "reports"} · ${openCount} open`
            : "Report potholes and follow what happens"
        }
        footer={
          isNew ? undefined : (
            <ButtonLink href={RESIDENT_ROUTES.newReport} size="lg" fullWidth icon={<Icon name="plus" size={18} />}>
              Report a pothole
            </ButtonLink>
          )
        }
      >
        {isNew ? (
          <NoReportsYet missing={missing} />
        ) : (
          <>
            <PanelSection title="My reports" action={reports && reports.length > 0 && <SeeAll href={RESIDENT_ROUTES.reports} label="See all my reports" />}>
              {reports && reports.length > 0 && <StatusCounts reports={reports} />}
              <div className="mt-2">
                <MyReportsList list={list} limit={RESIDENT.hubRecentReports} />
              </div>
              <MissingNote missing={missing} />
            </PanelSection>

            {reports && reports.length > 0 && (
              <PanelSection title="My photos" action={<SeeAll href={RESIDENT_ROUTES.photos} label="See all my photos" />}>
                <PhotoStrip reports={reports.slice(0, RESIDENT.hubRecentPhotos)} />
              </PanelSection>
            )}
          </>
        )}
      </FloatingPanel>
    </>
  );
}
