/**
 * useFormDraft — the single, reusable autosave helper for human-fillable forms.
 *
 * Modeled on the (robust) fact-submission draft behavior and generalized so every
 * form in the app uses one code path: debounced save, restore-on-mount, a
 * self-refreshing "Saved X min ago" label, status/error exposure, and clear().
 *
 * The storage backend is pluggable via `StorageAdapter`: localStorage by default
 * (see `createLocalStorageAdapter`), or a custom async adapter for server-backed
 * forms (e.g. admin moderation's PATCH).
 *
 * Change detection is snapshot-based (a stable serialization), NOT React object
 * identity — so equivalent-value re-renders never trigger redundant saves and
 * callers need not memoize `value`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getRelativeTime,
  stableSerialize,
  type StorageAdapter,
} from "@/lib/form-draft-storage";

export type DraftStatus = "idle" | "saving" | "saved" | "error";

export interface UseFormDraftOptions<T> {
  /** Current form value (caller-controlled). */
  value: T;
  /** Persistence strategy. Default localStorage via `createLocalStorageAdapter`. */
  adapter: StorageAdapter<T>;
  /** Debounce before persisting after the last change. */
  debounceMs?: number;
  /** When false, autosave is suppressed entirely (e.g. after submit). Default true. */
  enabled?: boolean;
  /** When true for a value, the draft is cleared instead of saved (treated as "no draft"). */
  isEmpty?: (value: T) => boolean;
  /** Called once on mount with a restored draft. Apply it to your form state here. */
  onRestore?: (value: T, savedAt: number) => void;
  /** Whether to attempt restore-on-mount. Default true. Server-backed forms set false. */
  restoreOnMount?: boolean;
  /**
   * Optional explicit dirty gate. When provided, autosave only fires while true
   * (e.g. an admin "dirty" flag that distinguishes user edits from server syncs).
   * Omit it for the common case (save on any content change).
   */
  manualDirty?: boolean;
  /** Fired after a save that is still the latest issued — stale saves never call it. */
  onSaved?: () => void;
  /** Override the snapshot serializer (default: stable key-sorted JSON). */
  serialize?: (value: T) => string;
}

export interface UseFormDraftResult {
  status: DraftStatus;
  savedAt: number | null;
  savedLabel: string;
  error: string | null;
  /** Cancel any pending save and remove the persisted draft (submit / discard). */
  clear: () => void;
  /** Flush the latest value immediately (cancels debounce); resolves true on success. */
  saveNow: () => Promise<boolean>;
}

export function useFormDraft<T>(opts: UseFormDraftOptions<T>): UseFormDraftResult {
  const {
    value,
    debounceMs = 500,
    enabled = true,
    restoreOnMount = true,
    manualDirty,
  } = opts;

  const serialize = opts.serialize ?? stableSerialize;
  // Computed every render (cheap for small drafts); drives the autosave effect by
  // value, so identity-only re-renders are no-ops.
  const snapshot = serialize(value);

  // Latest inputs, read inside the stable flush()/clear() to avoid stale closures.
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const valueRef = useRef(value);
  valueRef.current = value;
  const serializeRef = useRef(serialize);
  serializeRef.current = serialize;

  const [status, setStatus] = useState<DraftStatus>("idle");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [savedLabel, setSavedLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Gate autosave until restore-on-mount has run, so the initial (empty) form
  // state can never clobber or clear a valid restored draft.
  const [restored, setRestored] = useState(!restoreOnMount);

  // Monotonic sequence so out-of-order async resolutions and clear-vs-save races
  // are resolved deterministically: only the latest-issued op may mutate state.
  const seqRef = useRef(0);
  const lastOpRef = useRef<"save" | "clear">("save");
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Distinct refs: what has been persisted vs. what is already scheduled. Keeping
  // them separate means equivalent-value re-renders don't keep resetting the
  // debounce before the first save lands.
  const lastPersistedSnapshotRef = useRef<string | null>(null);
  const lastScheduledSnapshotRef = useRef<string | null>(null);

  const flush = useCallback(async (): Promise<boolean> => {
    const v = valueRef.current;
    const { adapter, isEmpty, onSaved } = optsRef.current;
    const snap = serializeRef.current(v);
    const seq = ++seqRef.current;
    lastOpRef.current = "save";

    if (isEmpty?.(v)) {
      lastPersistedSnapshotRef.current = snap;
      try {
        await Promise.resolve(adapter.clear());
      } catch {
        /* ignore */
      }
      if (seq === seqRef.current) {
        setSavedAt(null);
        setStatus("idle");
        setError(null);
      }
      return true;
    }

    setStatus("saving");
    try {
      const ts = await Promise.resolve(adapter.save(v));
      if (seq !== seqRef.current) {
        // Superseded mid-flight. If a clear() won the race, keep storage cleared.
        // (Cast defeats TS's narrowing: the ref can be mutated during the await.)
        if ((lastOpRef.current as "save" | "clear") === "clear") {
          try {
            await Promise.resolve(adapter.clear());
          } catch {
            /* ignore */
          }
        }
        return false;
      }
      lastPersistedSnapshotRef.current = snap;
      setSavedAt(ts);
      setSavedLabel(getRelativeTime(ts));
      setStatus("saved");
      setError(null);
      onSaved?.();
      return true;
    } catch (e) {
      // A stale (superseded) save must not flip a newer-saved form into error.
      if (seq !== seqRef.current) return false;
      setStatus("error");
      setError(e instanceof Error ? e.message : "Save failed");
      return false;
    }
  }, []);

  // Restore-on-mount. Never clears a valid restored draft.
  //
  // Race-safety: a consumer-initiated clear() or saveNow() during the load()
  // await bumps `seqRef`, signalling "the form has been touched, don't replay
  // the persisted draft over it." We capture the starting seq and skip
  // applying the loaded value when anything happened during the await.
  // setRestored(true) still fires in `finally` so the autosave gate opens.
  useEffect(() => {
    let cancelled = false;
    if (!restoreOnMount) {
      setRestored(true);
      return;
    }
    const seqAtStart = seqRef.current;
    void (async () => {
      try {
        let loaded: Awaited<ReturnType<StorageAdapter<T>["load"]>> = null;
        try {
          loaded = await Promise.resolve(optsRef.current.adapter.load());
        } catch {
          loaded = null;
        }
        if (cancelled || !loaded) return;
        // Consumer touched the form (clear / saveNow) during the load await —
        // their intent wins. Don't replay the persisted draft.
        if (seqRef.current !== seqAtStart) return;
        lastPersistedSnapshotRef.current = serializeRef.current(loaded.value);
        setSavedAt(loaded.savedAt);
        setSavedLabel(getRelativeTime(loaded.savedAt));
        setStatus("saved");
        optsRef.current.onRestore?.(loaded.value, loaded.savedAt);
      } finally {
        if (!cancelled) setRestored(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced autosave on content change.
  useEffect(() => {
    if (!restored || !enabled || manualDirty === false) {
      // Suppressed: cancel any in-flight debounce so a disabled form never saves.
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      return;
    }
    if (snapshot === lastPersistedSnapshotRef.current) return;
    // Already scheduled for this exact content — let the pending timer fire rather
    // than resetting it (an equivalent-value re-render must not delay the save).
    if (snapshot === lastScheduledSnapshotRef.current) return;

    lastScheduledSnapshotRef.current = snapshot;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      void flush();
    }, debounceMs);
  }, [snapshot, enabled, manualDirty, restored, debounceMs, flush]);

  // Cancel any pending save on unmount.
  useEffect(
    () => () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    },
    [],
  );

  // Keep the relative-time label fresh.
  useEffect(() => {
    if (savedAt === null) {
      setSavedLabel("");
      return;
    }
    setSavedLabel(getRelativeTime(savedAt));
    const id = setInterval(() => setSavedLabel(getRelativeTime(savedAt)), 30_000);
    return () => clearInterval(id);
  }, [savedAt]);

  const clear = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    // Bump the sequence so any in-flight save is treated as stale; if it resolves
    // after this clear(), flush() re-clears storage rather than re-persisting.
    seqRef.current += 1;
    lastOpRef.current = "clear";
    lastScheduledSnapshotRef.current = null;
    lastPersistedSnapshotRef.current = null;
    try {
      void Promise.resolve(optsRef.current.adapter.clear());
    } catch {
      /* ignore */
    }
    setSavedAt(null);
    setStatus("idle");
    setError(null);
  }, []);

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    lastScheduledSnapshotRef.current = serializeRef.current(valueRef.current);
    return flush();
  }, [flush]);

  return { status, savedAt, savedLabel, error, clear, saveNow };
}
