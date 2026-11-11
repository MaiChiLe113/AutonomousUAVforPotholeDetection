// Browser location for the resident map (FR-05). Failures are expected (denied, insecure origin, timeout):
// callers fall back to MAP.defaultCenter without showing an error.

import { GEOLOCATION } from "@/lib/config";
import type { LatLng } from "@/lib/map";

export type GeoFailure = "denied" | "unavailable";

export class GeoError extends Error {
  constructor(readonly reason: GeoFailure) {
    super(reason === "denied" ? "Location permission denied" : "Location unavailable");
    this.name = "GeoError";
  }
}

/** One location fix as [lat, lon]. Rejects with GeoError. */
export function requestLocation(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      reject(new GeoError("unavailable"));
      return;
    }
    try {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve([p.coords.latitude, p.coords.longitude]),
        (e) => reject(new GeoError(e.code === e.PERMISSION_DENIED ? "denied" : "unavailable")),
        {
          enableHighAccuracy: GEOLOCATION.enableHighAccuracy,
          timeout: GEOLOCATION.timeoutMs,
          maximumAge: GEOLOCATION.maximumAgeMs,
        },
      );
    } catch {
      reject(new GeoError("unavailable"));
    }
  });
}

/** "10.77690, 106.70090". */
export const formatLatLng = ([lat, lon]: LatLng) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
