"use client";

// UC-R1 Report a pothole (SCRUM-24, 30). Full-bleed map with a draggable pin + floating panel:
// pin → photo → send → AI pre-check result. (RoleGate: app/resident/layout.tsx)

import { useEffect, useRef, useState } from "react";

import MapView from "@/components/MapView";
import PhotoPicker from "@/components/resident/PhotoPicker";
import PrecheckResult from "@/components/resident/PrecheckResult";
import { formatLatLng, requestLocation } from "@/components/resident/geolocation";
import {
  Banner,
  Button,
  ButtonLink,
  FloatingPanel,
  Icon,
  MapControlButton,
  MapControls,
  PanelSection,
  Spinner,
} from "@/components/ui";
import { ApiError, createReport } from "@/lib/api";
import { MAP, RESIDENT_ROUTES } from "@/lib/config";
import type { FlyTarget, LatLng } from "@/lib/map";
import { addMyReport } from "@/lib/session";
import type { Report } from "@/lib/types";

/** Where the pin is: the map default, the browser location, or placed by the resident. */
type PinSource = "default" | "location" | "user";

export default function NewReportPage() {
  // ---------------------------------------------------------------- map: pin, location, camera
  const [pin, setPin] = useState<LatLng>(MAP.defaultCenter);
  const [pinSource, setPinSource] = useState<PinSource>("default");
  const [locating, setLocating] = useState(true);
  // Fly to the starting pin once: the fly is offset for the panel, so the pin is not hidden under the phone sheet.
  const [fly, setFly] = useState<FlyTarget | null>({ center: MAP.defaultCenter, key: 0 });
  const flySeq = useRef(0);
  const pinTouched = useRef(false);

  /** Ask the browser for its location. `force`: also move a pin the resident already placed. */
  const locate = (force: boolean) => {
    setLocating(true);
    return requestLocation()
      .then(
        (pos) => {
          if (!force && pinTouched.current) return;
          pinTouched.current = false;
          setPin(pos);
          setPinSource("location");
          setFly({ center: pos, key: ++flySeq.current });
        },
        () => undefined, // denied / unavailable / timeout: keep the current pin, no error
      )
      .finally(() => setLocating(false));
  };

  // Open at the browser location (fallback: MAP.defaultCenter, quietly).
  const locateRef = useRef(locate);
  useEffect(() => {
    locateRef.current = locate;
  });
  useEffect(() => {
    void locateRef.current(false);
  }, []);

  // ---------------------------------------------------------------- report form
  const [photo, setPhoto] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [created, setCreated] = useState<Report | null>(null);
  const editable = !created && !sending;

  const movePin = (pos: LatLng) => {
    pinTouched.current = true;
    setPin(pos);
    setPinSource("user");
  };

  async function send() {
    if (!photo || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    try {
      const report = await createReport(pin[0], pin[1], photo);
      addMyReport(report.id);
      setCreated(report);
    } catch (e) {
      setSendError(e instanceof ApiError ? e.message : "Could not send the report. Try again.");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function reportAnother() {
    setCreated(null);
    setPhoto(null);
    setSendError(null);
  }

  const pinPosition: LatLng = created ? [created.lat, created.lon] : pin;

  return (
    <>
      <MapView
        pin={{ position: pinPosition, draggable: editable, label: created ? `Report #${created.id}` : undefined }}
        onPinMove={movePin}
        onMapClick={editable ? movePin : undefined}
        flyTo={fly}
      />

      {editable && (
        <MapControls>
          <MapControlButton label="Use my location" icon="locate" iconOnly onClick={() => void locate(true)} />
        </MapControls>
      )}

      <FloatingPanel
        title={created ? "Report sent" : "Report a pothole"}
        subtitle={created ? "AI check result" : "Pin it, add a photo, send"}
        backHref={RESIDENT_ROUTES.home}
        footer={
          created ? (
            <div className="flex gap-2">
              <ButtonLink href={RESIDENT_ROUTES.report(created.id)} className="min-w-0 flex-1">
                Track this report
              </ButtonLink>
              <Button variant="secondary" onClick={reportAnother}>
                New report
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {sendError && (
                <Banner tone="danger" title="Report not sent">
                  {sendError}
                </Banner>
              )}
              <Button fullWidth size="lg" onClick={send} disabled={!photo} loading={sending}>
                {sending ? "Sending…" : "Send report"}
              </Button>
              {!photo && !sending && <p className="text-center text-xs text-slate-500">Add a photo to send the report.</p>}
            </div>
          )
        }
      >
        {created ? (
          <PrecheckResult report={created} />
        ) : (
          <>
            <PanelSection title="1 · Pin the pothole">
              <p className="text-sm text-slate-700">Drag the pin, or tap the map, to put it on the pothole.</p>
              <p className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                <span className="inline-flex items-center gap-1 tabular-nums">
                  <Icon name="pin" size={14} />
                  {formatLatLng(pin)}
                </span>
                <PinNote source={pinSource} locating={locating} />
              </p>
            </PanelSection>
            <PanelSection title="2 · Add a photo">
              <PhotoPicker
                file={photo}
                onChange={(file) => {
                  setPhoto(file);
                  setSendError(null);
                }}
                disabled={sending}
              />
            </PanelSection>
          </>
        )}
      </FloatingPanel>
    </>
  );
}

/** Quiet hint about the pin. A denied or failed location lookup is not an error: the map centre is used. */
function PinNote({ source, locating }: { source: PinSource; locating: boolean }) {
  if (source === "user") return <span>Placed by you</span>;
  if (locating) {
    return (
      <span className="inline-flex items-center gap-1">
        <Spinner size={10} label="Finding your location" /> Finding your location…
      </span>
    );
  }
  if (source === "location") return <span>Your location</span>;
  return <span>Location not available – move the pin to the pothole</span>;
}
