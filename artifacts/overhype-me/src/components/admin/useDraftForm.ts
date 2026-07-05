/**
 * useDraftForm — the universal "edit locally, commit explicitly" form helper.
 *
 * Every admin edit form follows the same contract:
 *
 *   1. Edits autosave (debounced) to **localStorage only** — never the database.
 *      The UI shows "Draft changes saved" so the admin knows they are looking at
 *      locally-cached work, not the server source of truth.
 *   2. An explicit **Save** commits the draft to the server (`commit`). On success
 *      the committed value becomes the new baseline and the local draft is dropped.
 *   3. **Discard** throws the local draft away and reverts the form to the server
 *      baseline.
 *
 * Some forms commit through an external action instead of a Save button (e.g. the
 * moderation Approve/Reject decision sends the fields with the decision). Those
 * omit `commit` and call `clearDraft()` / `syncFromServer()` after the action.
 *
 * Background jobs (re-run classification, regenerate preview) rewrite one slice of
 * the record server-side; `adoptServerSlice` folds that slice into BOTH the value
 * and the baseline so other locally-edited slices survive.
 *
 * This builds on the same storage primitives as `useFormDraft`
 * (`createLocalStorageAdapter`, `stableSerialize`) but is a distinct concern: it
 * is storage-key reactive (re-restores when the bound entity changes, even without
 * a remount) and separates the local draft from the server commit.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DraftStatus } from "@/hooks/use-form-draft";
import {
  createLocalStorageAdapter,
  getRelativeTime,
  stableSerialize,
  type LoadedDraft,
} from "@/lib/form-draft-storage";

export interface UseDraftFormOptions<T, R = unknown> {
  /** Stable per-entity localStorage key (e.g. `fact-edit-draft::123`). */
  storageKey: string;
  /** Value used before the server load resolves and when there is no record. */
  emptyValue: T;
  /** Fetch the server record (source of truth). Return null when none exists. */
  fetchServer: () => Promise<R | null>;
  /** Extract the editable form value from a server record. */
  selectValue: (record: R) => T;
  /**
   * Commit the current value to the server. Resolves on success; throws (with a
   * user-facing message) on failure. Omit for forms whose commit happens
   * externally (e.g. the moderation decision buttons).
   */
  commit?: (value: T) => Promise<void>;
  /** Validate a restored localStorage draft's shape; invalid drafts are discarded. */
  isValidDraft?: (value: unknown) => value is T;
  /** Debounce before writing a draft to localStorage. Default 800ms. */
  debounceMs?: number;
  /** Bump to invalidate older drafts after a value-shape change. */
  schemaVersion?: number;
  /** Called after every server fetch (mount load, syncFromServer) with the raw record. */
  onServerRecord?: (record: R | null) => void;
}

export interface UseDraftFormResult<T, R = unknown> {
  value: T;
  /** Update the form value (autosaves a draft to localStorage). */
  setValue: (next: T | ((prev: T) => T)) => void;
  loading: boolean;
  /** localStorage autosave status. */
  draftStatus: DraftStatus;
  /** Ready-to-render label, e.g. "Draft changes saved · just now". Empty when no draft. */
  draftLabel: string;
  /** Epoch ms the local draft was last written, or null. */
  draftSavedAt: number | null;
  /** value differs from the server baseline (there is unsaved work). */
  hasUncommittedChanges: boolean;
  /** Synchronous, ref-based equivalent of `hasUncommittedChanges`. Reflects
   *  updates applied within the current tick (e.g. an `adoptServerSlice` from a
   *  just-awaited override write) that the memoized boolean hasn't re-rendered
   *  for yet — so async action handlers read true post-flush state, not the
   *  stale value captured in their closure. */
  isDirty: () => boolean;
  committing: boolean;
  commitError: string | null;
  /** Epoch ms of the last successful server commit (for a "Saved to server" hint). */
  committedAt: number | null;
  /** Commit to the server (Save button). No-op + false when no `commit` provided. */
  save: () => Promise<boolean>;
  /** Revert the form to the server baseline and clear the local draft. */
  discard: () => void;
  /**
   * Promote the current value to the baseline and drop the local draft WITHOUT
   * calling `commit` — for forms whose commit happens via an external action
   * (e.g. the moderation Approve/Reject decision already persisted these fields).
   */
  markCommitted: () => void;
  /**
   * Apply a partial server update to BOTH the value and the baseline (e.g. a
   * background job rewrote one slice). Other locally-edited slices are preserved;
   * the localStorage draft is re-reconciled (cleared if nothing differs now).
   */
  adoptServerSlice: (updater: (prev: T) => T) => void;
  /** Re-fetch the record and adopt it wholesale as the new baseline + value. */
  syncFromServer: () => Promise<R | null>;
  /** Remove the localStorage draft without touching value/baseline. */
  clearDraft: () => void;
}

export function useDraftForm<T, R = unknown>(opts: UseDraftFormOptions<T, R>): UseDraftFormResult<T, R> {
  const { storageKey, debounceMs = 800, schemaVersion } = opts;

  const [value, setValueState] = useState<T>(opts.emptyValue);
  const [baseline, setBaseline] = useState<T>(opts.emptyValue);
  const [loading, setLoading] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [committedAt, setCommittedAt] = useState<number | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const [draftStatus, setDraftStatus] = useState<DraftStatus>("idle");
  const [draftLabel, setDraftLabel] = useState("");

  const optsRef = useRef(opts);
  optsRef.current = opts;
  const valueRef = useRef(value);
  valueRef.current = value;
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;
  const lastPersistedRef = useRef<string | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const adapter = useMemo(
    () => createLocalStorageAdapter<T>({ key: storageKey, schemaVersion, isValid: optsRef.current.isValidDraft }),
    [storageKey, schemaVersion],
  );
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;

  const clearDraft = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    lastPersistedRef.current = null;
    try {
      adapterRef.current.clear();
    } catch {
      /* ignore */
    }
    setDraftSavedAt(null);
    setDraftStatus("idle");
  }, []);

  // Restore the local draft + load the server baseline whenever the bound entity
  // (storageKey) changes. A restored draft wins over the server value, so the
  // admin always sees their unsaved work; the server value is still the baseline.
  useEffect(() => {
    // The adapter bound to THIS entity, captured so the cleanup flushes the
    // pending draft to the correct (old) key when the entity switches.
    const activeAdapter = adapterRef.current;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    let cancelled = false;
    let draftRestored = false;

    let restored: LoadedDraft<T> | null = null;
    try {
      restored = adapterRef.current.load() as LoadedDraft<T> | null;
    } catch {
      restored = null;
    }
    if (restored) {
      draftRestored = true;
      lastPersistedRef.current = stableSerialize(restored.value);
      setValueState(restored.value);
      valueRef.current = restored.value;
      setDraftSavedAt(restored.savedAt);
      setDraftStatus("saved");
    } else {
      lastPersistedRef.current = null;
      setValueState(optsRef.current.emptyValue);
      valueRef.current = optsRef.current.emptyValue;
      setDraftSavedAt(null);
      setDraftStatus("idle");
    }
    setCommitError(null);
    setCommittedAt(null);

    setLoading(true);
    void (async () => {
      let record: R | null = null;
      try {
        record = await optsRef.current.fetchServer();
      } catch {
        record = null;
      }
      if (cancelled) return;
      const serverValue = record != null ? optsRef.current.selectValue(record) : optsRef.current.emptyValue;
      setBaseline(serverValue);
      baselineRef.current = serverValue;
      if (!draftRestored) {
        setValueState(serverValue);
        valueRef.current = serverValue;
      }
      setLoading(false);
      optsRef.current.onServerRecord?.(record);
    })();

    return () => {
      cancelled = true;
      // Flush a still-pending draft so edits made within the debounce window
      // (e.g. typing then immediately closing the modal or switching entities)
      // are not lost. Writes to the entity that owned this effect.
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        if (stableSerialize(valueRef.current) !== stableSerialize(baselineRef.current)) {
          try {
            activeAdapter.save(valueRef.current);
          } catch {
            /* ignore */
          }
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // Persist drafts to localStorage (debounced) while the value diverges from the
  // server baseline; drop the draft once it matches (nothing left to keep).
  useEffect(() => {
    const snap = stableSerialize(value);
    if (snap === stableSerialize(baseline)) {
      if (lastPersistedRef.current !== null) clearDraft();
      return;
    }
    if (snap === lastPersistedRef.current) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    setDraftStatus("saving");
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      void (async () => {
        const ts = await adapterRef.current.save(valueRef.current);
        lastPersistedRef.current = stableSerialize(valueRef.current);
        setDraftSavedAt(ts);
        setDraftStatus("saved");
      })();
    }, debounceMs);
  }, [value, baseline, debounceMs, clearDraft]);

  // Keep the human-readable draft label fresh.
  useEffect(() => {
    if (draftStatus === "saving") {
      setDraftLabel("Saving draft…");
      return undefined;
    }
    if (draftStatus === "saved" && draftSavedAt !== null) {
      const render = () =>
        setDraftLabel(`Draft changes saved · ${getRelativeTime(draftSavedAt).replace(/^Saved /, "")}`);
      render();
      const id = setInterval(render, 30_000);
      return () => clearInterval(id);
    }
    setDraftLabel("");
    return undefined;
  }, [draftStatus, draftSavedAt]);

  const setValue = useCallback((next: T | ((prev: T) => T)) => {
    setValueState((prev) => (typeof next === "function" ? (next as (p: T) => T)(prev) : next));
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    const commit = optsRef.current.commit;
    if (!commit) return false;
    setCommitting(true);
    setCommitError(null);
    try {
      const toSave = valueRef.current;
      await commit(toSave);
      setBaseline(toSave);
      baselineRef.current = toSave;
      clearDraft();
      setCommittedAt(Date.now());
      return true;
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : "Save failed");
      return false;
    } finally {
      setCommitting(false);
    }
  }, [clearDraft]);

  const discard = useCallback(() => {
    const b = baselineRef.current;
    setValueState(b);
    valueRef.current = b;
    clearDraft();
    setCommitError(null);
  }, [clearDraft]);

  // Finalize the current value as committed WITHOUT calling `commit` — for forms
  // whose commit happens through an external action (e.g. the moderation
  // Approve/Reject decision already persisted these fields). Promotes the value
  // to the baseline and drops the local draft, so the unmount flush can't
  // resurrect an obsolete draft after the entity is decided.
  const markCommitted = useCallback(() => {
    const v = valueRef.current;
    setBaseline(v);
    baselineRef.current = v;
    clearDraft();
    setCommittedAt(Date.now());
  }, [clearDraft]);

  const adoptServerSlice = useCallback((updater: (prev: T) => T) => {
    const newBaseline = updater(baselineRef.current);
    const newValue = updater(valueRef.current);
    setBaseline(newBaseline);
    baselineRef.current = newBaseline;
    setValueState(newValue);
    valueRef.current = newValue;
  }, []);

  const syncFromServer = useCallback(async (): Promise<R | null> => {
    let record: R | null = null;
    try {
      record = await optsRef.current.fetchServer();
    } catch {
      record = null;
    }
    const serverValue = record != null ? optsRef.current.selectValue(record) : optsRef.current.emptyValue;
    setBaseline(serverValue);
    baselineRef.current = serverValue;
    setValueState(serverValue);
    valueRef.current = serverValue;
    clearDraft();
    optsRef.current.onServerRecord?.(record);
    return record;
  }, [clearDraft]);

  const hasUncommittedChanges = useMemo(
    () => stableSerialize(value) !== stableSerialize(baseline),
    [value, baseline],
  );

  const isDirty = useCallback(
    () => stableSerialize(valueRef.current) !== stableSerialize(baselineRef.current),
    [],
  );

  return {
    value,
    setValue,
    loading,
    draftStatus,
    draftLabel,
    draftSavedAt,
    hasUncommittedChanges,
    isDirty,
    committing,
    commitError,
    committedAt,
    save,
    discard,
    markCommitted,
    adoptServerSlice,
    syncFromServer,
    clearDraft,
  };
}
