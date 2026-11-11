"use client";

// Data hooks for the resident pages (UC-R2).

import { useState } from "react";

import { ApiError, getReport } from "@/lib/api";
import { SIM } from "@/lib/config";
import { parseApiDate } from "@/lib/format";
import { usePoll } from "@/lib/hooks";
import { useMyReports } from "@/lib/session";
import type { Report } from "@/lib/types";

import { isFinalStatus } from "./reportProgress";

/** GET /reports/{id}, with 404 as `null` instead of an error. */
async function findReport(id: number): Promise<Report | null> {
  try {
    return await getReport(id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

const newestFirst = (a: Report, b: Report) =>
  (parseApiDate(b.created_at)?.getTime() ?? 0) - (parseApiDate(a.created_at)?.getTime() ?? 0) || b.id - a.id;

export interface MyReportList {
  ids: number[];
  /** Reports that still exist, newest first. Null until the first answer. */
  reports: Report[] | null;
  /** Saved ids the backend no longer knows (for example after Reset demo). */
  missing: number;
  loading: boolean;
  error: string | null;
}

/**
 * Reports sent from this browser ("my reports" in localStorage), each loaded with GET /reports/{id}.
 * Ids that answer 404 are skipped. Refreshes every SIM.reportStatusPollMs while `active` and while
 * at least one report is still open.
 */
export function useMyReportList(active: boolean): MyReportList {
  const ids = useMyReports();
  const key = ids.join(",");
  const [settledKey, setSettledKey] = useState<string | null>(null);

  const poll = usePoll(
    async () => {
      const found = await Promise.all(ids.map(findReport));
      return found.filter((r): r is Report => r !== null).sort(newestFirst);
    },
    SIM.reportStatusPollMs,
    { key, enabled: active && ids.length > 0 && settledKey !== key },
  );

  // Every report is closed: stop polling until the list of ids changes.
  const settled = poll.data !== null && poll.data.every((r) => isFinalStatus(r.status));
  if (settled && settledKey !== key) setSettledKey(key);

  return {
    ids,
    reports: ids.length === 0 ? [] : poll.data,
    missing: poll.data ? ids.length - poll.data.length : 0,
    loading: ids.length > 0 && poll.loading,
    error: poll.error,
  };
}

export type ReportLookup = { found: true; report: Report } | { found: false };

export interface ReportStatusResult {
  lookup: ReportLookup | null;
  loading: boolean;
  /** Last request failed (polling goes on; the last known report stays). */
  error: string | null;
  /** True while polling (the report is open). */
  polling: boolean;
}

/**
 * One report, polled every SIM.reportStatusPollMs until it reaches a final status
 * (confirmed, not_confirmed, no_damage, rejected) or turns out not to exist (FR-11, FR-12).
 */
export function useReportStatus(id: number | null): ReportStatusResult {
  const [stoppedId, setStoppedId] = useState<number | null>(null);
  const enabled = id !== null && stoppedId !== id;

  const poll = usePoll<ReportLookup>(
    async () => {
      const report = await findReport(id as number);
      return report ? { found: true, report } : { found: false };
    },
    SIM.reportStatusPollMs,
    { key: id, enabled },
  );

  const lookup = poll.data;
  const finished = lookup !== null && (!lookup.found || isFinalStatus(lookup.report.status));
  if (finished && id !== null && stoppedId !== id) setStoppedId(id);

  return { lookup, loading: id !== null && poll.loading, error: poll.error, polling: enabled && !finished };
}
