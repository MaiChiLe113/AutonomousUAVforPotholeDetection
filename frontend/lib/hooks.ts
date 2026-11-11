// Small React hooks shared by pages (client components only).

import { useCallback, useEffect, useRef, useState } from "react";

/** Current time in ms, re-rendering every `intervalMs` (for "Last update 2 s ago"). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

export interface PollResult<T> {
  data: T | null;
  error: string | null;
  /** true until the first response (success or error) for the current key. */
  loading: boolean;
  /** Fetch again now (e.g. after an action) without waiting for the next tick. */
  refresh: () => void;
}

/**
 * Call `fetcher` now and then every `intervalMs` (waits for each call to finish first).
 * Pass `intervalMs = null` to fetch once without polling, and `enabled = false` to pause.
 * `key` restarts polling and clears the data (e.g. the report id).
 *
 *   const { data: report } = usePoll(() => getReport(id), SIM.reportStatusPollMs, { key: id });
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number | null,
  opts: { enabled?: boolean; key?: string | number | null } = {},
): PollResult<T> {
  const { enabled = true, key = null } = opts;
  const [state, setState] = useState<{ key: string | number | null; data: T | null; error: string | null; loading: boolean }>(
    { key, data: null, error: null, loading: true },
  );
  const fetcherRef = useRef(fetcher);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: number | undefined;

    const run = async () => {
      try {
        const data = await fetcherRef.current();
        if (!cancelled) setState({ key, data, error: null, loading: false });
      } catch (e) {
        if (!cancelled) setState((s) => ({ key, data: s.key === key ? s.data : null, error: (e as Error).message, loading: false }));
      }
      if (!cancelled && intervalMs !== null) timer = window.setTimeout(run, intervalMs);
    };
    run();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, intervalMs, key, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Hide data that belongs to a previous key until the new key has answered.
  if (state.key !== key) return { data: null, error: null, loading: true, refresh };
  return { data: state.data, error: state.error, loading: state.loading, refresh };
}
