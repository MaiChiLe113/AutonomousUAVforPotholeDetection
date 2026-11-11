// Demo sign-in: { role, name } kept in localStorage (no password, no backend auth).
// Every storage access is guarded; when storage is blocked the session lives in memory.

import { useSyncExternalStore } from "react";

import { SESSION } from "./config";
import type { Role, Session } from "./types";

const CHANGE_EVENT = "pothole-uav:session";
const MY_REPORTS_EVENT = "pothole-uav:my-reports";

// In-memory fallback for blocked storage (private mode, disabled site data).
const memory = new Map<string, string>();

function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function writeKey(key: string, value: string | null): void {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // storage blocked: the in-memory copy is used
  }
}

function subscribeTo(event: string, key: string) {
  return (onChange: () => void) => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === key) onChange();
    };
    window.addEventListener(event, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(event, onChange);
      window.removeEventListener("storage", onStorage);
    };
  };
}

// ---------------------------------------------------------------- session

function parseSession(raw: string | null): Session | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Session>;
    if ((v.role === "resident" || v.role === "monitor") && typeof v.name === "string") {
      return { role: v.role, name: v.name };
    }
  } catch {
    // corrupted value: treat as signed out
  }
  return null;
}

export interface SessionState {
  /** false only during the first (server / hydration) render; wait for it before redirecting. */
  ready: boolean;
  session: Session | null;
}

const SERVER_STATE: SessionState = { ready: false, session: null };
let cachedRaw: string | null | undefined;
let cachedState: SessionState = SERVER_STATE;

function sessionSnapshot(): SessionState {
  const raw = readKey(SESSION.storageKey);
  if (raw !== cachedRaw || !cachedState.ready) {
    cachedRaw = raw;
    cachedState = { ready: true, session: parseSession(raw) };
  }
  return cachedState;
}

const subscribeSession = subscribeTo(CHANGE_EVENT, SESSION.storageKey);

/** Current demo session. `ready` is false until the browser value has been read. */
export function useSession(): SessionState {
  return useSyncExternalStore(subscribeSession, sessionSnapshot, () => SERVER_STATE);
}

/** Read the session outside React (event handlers). */
export function getSession(): Session | null {
  return parseSession(readKey(SESSION.storageKey));
}

function saveSession(session: Session | null) {
  writeKey(SESSION.storageKey, session ? JSON.stringify(session) : null);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function signIn(name: string, role: Role): Session {
  const session = { name: name.trim(), role };
  saveSession(session);
  return session;
}

/** Change the role of the signed-in user (top bar switch). No-op when signed out. */
export function switchRole(role: Role): Session | null {
  const current = getSession();
  if (!current) return null;
  const next = { ...current, role };
  saveSession(next);
  return next;
}

export function signOut(): void {
  saveSession(null);
}

// ---------------------------------------------------------------- resident "my reports"

function parseIds(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [];
  } catch {
    return [];
  }
}

const NO_IDS: number[] = [];
let cachedIdsRaw: string | null | undefined;
let cachedIds: number[] = NO_IDS;

function idsSnapshot(): number[] {
  const raw = readKey(SESSION.myReportsKey);
  if (raw !== cachedIdsRaw) {
    cachedIdsRaw = raw;
    cachedIds = parseIds(raw);
  }
  return cachedIds;
}

const subscribeIds = subscribeTo(MY_REPORTS_EVENT, SESSION.myReportsKey);

/** Report ids sent from this browser, newest first. Empty on the server render. */
export function useMyReports(): number[] {
  return useSyncExternalStore(subscribeIds, idsSnapshot, () => NO_IDS);
}

export function getMyReports(): number[] {
  return parseIds(readKey(SESSION.myReportsKey));
}

export function addMyReport(id: number): void {
  const ids = [id, ...getMyReports().filter((x) => x !== id)];
  writeKey(SESSION.myReportsKey, JSON.stringify(ids));
  window.dispatchEvent(new Event(MY_REPORTS_EVENT));
}

export function clearMyReports(): void {
  writeKey(SESSION.myReportsKey, null);
  window.dispatchEvent(new Event(MY_REPORTS_EVENT));
}
