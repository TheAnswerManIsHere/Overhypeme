/**
 * sessionStorage-backed capture/restore for `PendingBuilderState`.
 *
 * Why sessionStorage and not a server-side row?
 *   - Storage cost: zero. Lives in the user's browser tab.
 *   - Lifecycle: dies with the tab, which is exactly what we want.
 *   - The data is already client-only (in-progress UI state) and re-derivable
 *     from server resources after auth completes.
 *
 * Schema versioned so we can break shape later without crashing on stale tabs.
 * 1-hour TTL — anything older is treated as missing.
 */

import type { PendingBuilderState } from "../types";

const KEY_PREFIX = "pending_meme_builder_v1::";
const TTL_MS = 60 * 60 * 1000; // 1 hour

function key(factId: string): string {
  return `${KEY_PREFIX}${factId}`;
}

function isStorageAvailable(): boolean {
  try {
    return typeof window !== "undefined" && "sessionStorage" in window;
  } catch {
    return false;
  }
}

export function capturePendingState(state: PendingBuilderState): void {
  if (!isStorageAvailable()) return;
  try {
    window.sessionStorage.setItem(key(state.factId), JSON.stringify(state));
  } catch {
    // Quota / private mode — silently skip; user just loses their draft.
  }
}

export function restorePendingState(factId: string): PendingBuilderState | null {
  if (!isStorageAvailable()) return null;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(key(factId));
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearPendingState(factId);
    return null;
  }

  if (!isPendingBuilderState(parsed)) {
    clearPendingState(factId);
    return null;
  }

  if (Date.now() - parsed.capturedAt > TTL_MS) {
    clearPendingState(factId);
    return null;
  }

  return parsed;
}

export function clearPendingState(factId: string): void {
  if (!isStorageAvailable()) return;
  try {
    window.sessionStorage.removeItem(key(factId));
  } catch {
    // Ignore.
  }
}

function isPendingBuilderState(v: unknown): v is PendingBuilderState {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.schemaVersion === 1 &&
    typeof o.capturedAt === "number" &&
    typeof o.factId === "string" &&
    (o.mode === "stock" || o.mode === "self-upload") &&
    typeof o.entryFlow === "string"
  );
}
