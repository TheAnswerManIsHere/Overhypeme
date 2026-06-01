/**
 * useEnrichmentDraft — the shared stateful wrapper around <EnrichmentEditor>.
 *
 * Both the moderation panel (pending reviews) and the Facts admin page edit the
 * same FactEnrichment blob through the same form. This hook owns the plumbing
 * that used to live inline in the moderation ReviewModal: debounced autosave
 * (via useFormDraft), dirty tracking, server-state polling, "re-run
 * classification", and "regenerate preview". It returns exactly the props
 * <EnrichmentEditor> expects, so a single editor + a single behavior power both
 * pages — change it here and both surfaces move together.
 *
 * Resource-aware, NOT page-aware: it knows only the resource kind + id and the
 * four endpoint URLs. It does not know about approve-gating, fact variants, or
 * any page concept — those stay in the pages.
 *
 * Guarantees:
 *  - Autosave only persists VALID enrichment. Invalid intermediate edits stay
 *    local (dirty, unsaved) and surface via `unsavedInvalid`; the editor itself
 *    renders the validation detail.
 *  - On id/resource change, the pending debounced save is cancelled and dirty
 *    state reset, and in-flight server responses for the previous id are dropped
 *    — an edit to one fact can never leak onto the next.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { validateEnrichment, type FactEnrichment } from "@workspace/api-zod";
import { useFormDraft, type UseFormDraftResult } from "@/hooks/use-form-draft";
import type { StorageAdapter } from "@/lib/form-draft-storage";

export type EnrichmentResource = "reviews" | "facts";

export interface EnrichmentSaveResponse {
  enrichment: FactEnrichment;
  /** Indexed projection columns the server re-synced (facts only). */
  projection?: {
    primaryArchetype: string;
    subtype: string;
    overhypeFit: string;
    adultSuitability: string;
  };
}

export interface UseEnrichmentDraftOptions {
  resource: EnrichmentResource;
  id: number;
  /** Seed value to avoid a load flash (e.g. moderation already has review.enrichment). */
  initialEnrichment?: FactEnrichment | null;
  initialStatus?: string | null;
  /**
   * Fetch the enrichment from the server on mount / id change. The Facts page
   * sets this (the facts list omits the heavy blob); moderation leaves it false
   * and seeds from the review it already has.
   */
  autoLoad?: boolean;
  /** Fired after a successful enrichment PATCH with the server response. */
  onSaved?: (resp: EnrichmentSaveResponse) => void;
}

export interface UseEnrichmentDraftResult {
  enrichment: FactEnrichment | null;
  status: string | null;
  loading: boolean;
  onChange: (next: FactEnrichment) => void;
  onRerun: () => Promise<void>;
  onRegeneratePreview: () => Promise<void>;
  saveNow: () => Promise<boolean>;
  /**
   * Update enrichment + status from a freshly-fetched server response WITHOUT
   * marking the field dirty. Safe to call on modal open to hydrate stale list
   * cache. No-ops if the user has already started editing (dirty flag guards it).
   */
  refreshFromServer: (enrichment: FactEnrichment | null, status: string | null) => void;
  busy: boolean;
  rerunBusy: boolean;
  previewBusy: boolean;
  dirty: boolean;
  /** True when there are unsaved local edits that fail validation (autosave suppressed). */
  unsavedInvalid: boolean;
  draft: UseFormDraftResult;
  error: string;
}

export function useEnrichmentDraft(opts: UseEnrichmentDraftOptions): UseEnrichmentDraftResult {
  const { resource, id, onSaved } = opts;
  const base = `/api/admin/${resource}/${id}`;

  const [enrichment, setEnrichment] = useState<FactEnrichment | null>(opts.initialEnrichment ?? null);
  const [status, setStatus] = useState<string | null>(opts.initialStatus ?? null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [rerunBusy, setRerunBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewPolls, setPreviewPolls] = useState(0);

  // dirtyRef gates syncFromServer (a ref so callbacks see the latest); the
  // parallel `dirty` state gates the autosave hook's effect. Both reset together.
  const dirtyRef = useRef(false);
  const [dirty, setDirty] = useState(false);

  // The id this hook instance is currently bound to. Any async resolution
  // (autosave PATCH, syncFromServer GET) carrying a different id is stale and
  // must be dropped, so an edit/sync for fact A can never write onto fact B.
  const activeIdRef = useRef(id);

  // Tracks the latest enrichment.previewStatus from the server so the preview
  // polling interval (which closes over stale React state) can detect when the
  // job has landed without relying on a fixed tick count.
  const latestPreviewStatusRef = useRef<string | null | undefined>(opts.initialEnrichment?.previewStatus);

  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  // Keep a stable serialization for the validity gate.
  const isValid = enrichment != null && validateEnrichment(enrichment).ok;
  const unsavedInvalid = dirty && !isValid;

  // ── Reset + initial load whenever the bound resource/id changes ──
  useEffect(() => {
    activeIdRef.current = id;
    dirtyRef.current = false;
    setDirty(false);
    setEnrichment(opts.initialEnrichment ?? null);
    setStatus(opts.initialStatus ?? null);
    latestPreviewStatusRef.current = opts.initialEnrichment?.previewStatus;
    setErrorMsg("");
    setRerunBusy(false);
    setPreviewBusy(false);

    if (!opts.autoLoad) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const r = await fetch(base, { credentials: "include" });
        if (!r.ok) return;
        const fresh = (await r.json()) as { enrichment?: FactEnrichment | null; enrichmentStatus?: string | null };
        if (cancelled || activeIdRef.current !== id || dirtyRef.current) return;
        latestPreviewStatusRef.current = fresh.enrichment?.previewStatus;
        setEnrichment(fresh.enrichment ?? null);
        setStatus(fresh.enrichmentStatus ?? null);
      } catch {
        /* leave seeded/empty state in place */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // initialEnrichment/initialStatus are seeds read once per id; intentionally
    // not in deps so a parent re-render can't re-trigger a reload mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource, id]);

  // Pull the latest stored enrichment/status from the server (async jobs write
  // it out-of-band). Skipped while dirty or when the id has moved on.
  const syncFromServer = useCallback(async (): Promise<string | null> => {
    if (dirtyRef.current) return null;
    const reqId = id;
    try {
      const r = await fetch(base, { credentials: "include" });
      if (!r.ok || dirtyRef.current || activeIdRef.current !== reqId) return null;
      const fresh = (await r.json()) as { enrichment?: FactEnrichment | null; enrichmentStatus?: string | null };
      if (dirtyRef.current || activeIdRef.current !== reqId) return null;
      latestPreviewStatusRef.current = fresh.enrichment?.previewStatus;
      setEnrichment(fresh.enrichment ?? null);
      setStatus(fresh.enrichmentStatus ?? null);
      return fresh.enrichmentStatus ?? null;
    } catch {
      return null;
    }
  }, [base, id]);

  // Server-backed autosave adapter. Only fires for VALID enrichment (the
  // autosave effect is also gated by `manualDirty` below, so an invalid blob
  // never even schedules a save); the PATCH is the second, server-side gate.
  const adapter = useMemo<StorageAdapter<FactEnrichment | null>>(
    () => ({
      load: () => null,
      clear: () => {},
      save: async (toSave) => {
        const reqId = id;
        if (!toSave || !validateEnrichment(toSave).ok) {
          throw new Error("Resolve the validation errors before saving.");
        }
        let r: Response;
        try {
          r = await fetch(`${base}/enrichment`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ enrichment: toSave }),
          });
        } catch {
          throw new Error("Network error — could not save.");
        }
        if (!r.ok) {
          throw new Error(r.status === 503 ? "API unavailable — try again shortly." : `Save failed (${r.status}).`);
        }
        // Drop the response if the bound id moved on while in flight.
        if (activeIdRef.current === reqId) {
          try {
            const body = (await r.json()) as EnrichmentSaveResponse;
            if (body?.enrichment) onSavedRef.current?.(body);
          } catch {
            /* response body is best-effort; the save itself succeeded */
          }
        }
        return Date.now();
      },
    }),
    [base, id],
  );

  const draft = useFormDraft<FactEnrichment | null>({
    value: enrichment,
    adapter,
    debounceMs: 1500,
    restoreOnMount: false,
    // Suppress autosave unless the user has dirtied a VALID blob — invalid
    // intermediate edits stay local (req: valid-only autosave).
    manualDirty: dirty && isValid,
    isEmpty: (e) => e == null,
    onSaved: () => {
      dirtyRef.current = false;
      setDirty(false);
    },
  });

  const onChange = useCallback((next: FactEnrichment) => {
    dirtyRef.current = true;
    setDirty(true);
    setEnrichment(next);
  }, []);

  // Called by the parent (e.g. ReviewModal) after a fresh GET on modal open so
  // the editor shows the latest DB values instead of the stale list-cache entry.
  // No-ops when dirty so an in-progress edit is never clobbered.
  const refreshFromServer = useCallback((freshEnrichment: FactEnrichment | null, freshStatus: string | null) => {
    if (dirtyRef.current) return;
    latestPreviewStatusRef.current = freshEnrichment?.previewStatus;
    setEnrichment(freshEnrichment);
    setStatus(freshStatus);
  }, []);

  // While classification is running, poll until it lands.
  useEffect(() => {
    if (status !== "pending") {
      setRerunBusy(false);
      return;
    }
    let cancelled = false;
    const handle = setInterval(async () => {
      const s = await syncFromServer();
      if (cancelled) return;
      if (s && s !== "pending") {
        clearInterval(handle);
        setRerunBusy(false);
      }
    }, 2500);
    return () => { cancelled = true; clearInterval(handle); };
  }, [status, syncFromServer]);

  // Preview regeneration runs as a separate async job. Poll until the job lands
  // (previewStatus leaves "pending") or a 100s hard timeout expires.
  useEffect(() => {
    if (previewPolls === 0) return;
    setPreviewBusy(true);
    // Reset so the fresh "pending" written by the POST is detected as a change.
    latestPreviewStatusRef.current = "pending";
    let cancelled = false;
    let ticks = 0;
    const MAX_TICKS = 40; // 40 × 2500ms = 100s hard timeout
    const handle = setInterval(async () => {
      ticks += 1;
      await syncFromServer();
      if (cancelled) return;
      if (latestPreviewStatusRef.current !== "pending" || ticks >= MAX_TICKS) {
        clearInterval(handle);
        setPreviewBusy(false);
      }
    }, 2500);
    return () => { cancelled = true; clearInterval(handle); setPreviewBusy(false); };
  }, [previewPolls, syncFromServer]);

  const onRerun = useCallback(async () => {
    setLoading(true);
    setErrorMsg("");
    try {
      const r = await fetch(`${base}/enrich`, { method: "POST", credentials: "include" });
      if (r.ok) {
        dirtyRef.current = false;
        setDirty(false);
        setRerunBusy(true);
        setStatus("pending");
      } else {
        setErrorMsg(
          r.status === 503 ? "API unavailable — try again shortly." :
          r.status === 429 ? "Rate limited — wait a moment and retry." :
          `Re-run failed (${r.status}).`,
        );
      }
    } catch {
      setErrorMsg("Network error — could not reach the server.");
    }
    setLoading(false);
  }, [base]);

  const onRegeneratePreview = useCallback(async () => {
    if (!enrichment) return;
    setLoading(true);
    setErrorMsg("");
    // Save first so the preview is generated from the current enrichment
    // (including unsaved cultural references / semantic entities), and so the
    // preview-polling syncFromServer is not blocked by the dirty flag.
    const saved = await draft.saveNow();
    if (!saved) { setLoading(false); return; }
    try {
      const r = await fetch(`${base}/preview`, { method: "POST", credentials: "include" });
      if (r.ok) {
        setPreviewPolls((n) => n + 1);
      } else {
        setErrorMsg(
          r.status === 503 ? "API unavailable — try again shortly." :
          r.status === 429 ? "Rate limited — wait a moment and retry." :
          `Preview regeneration failed (${r.status}).`,
        );
      }
    } catch {
      setErrorMsg("Network error — could not reach the server.");
    }
    setLoading(false);
  }, [base, enrichment, draft]);

  return {
    enrichment,
    status,
    loading,
    onChange,
    onRerun,
    onRegeneratePreview,
    saveNow: draft.saveNow,
    refreshFromServer,
    busy: loading || rerunBusy || previewBusy,
    rerunBusy,
    previewBusy,
    dirty,
    unsavedInvalid,
    draft,
    error: errorMsg || draft.error || "",
  };
}
