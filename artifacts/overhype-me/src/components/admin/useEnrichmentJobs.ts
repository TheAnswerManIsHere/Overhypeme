/**
 * useEnrichmentJobs — the enrichment *actions* hook (NOT an autosave method).
 *
 * Autosave for every form (note, rejection reason, enrichment, …) goes through
 * the ONE universal `useFormDraft` helper. This hook owns only the things that
 * are genuinely enrichment-specific and are NOT autosave:
 *
 *   • re-run classification        (POST /enrich)
 *   • regenerate the visual preview (POST /preview, after flushing the draft)
 *   • polling server-side job state and syncing it back into the form
 *
 * It deliberately does NOT own the enrichment form state. The page owns
 * `enrichment` + `enrichmentStatus` (so the universal `useFormDraft` can read
 * them as its value); this hook reaches into that state through the callbacks
 * below. That keeps "how the form autosaves" and "how background jobs mutate the
 * form" cleanly separated, and identical for both the moderation modal and the
 * facts admin page (only the resource segment of the URL differs).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { FactEnrichment } from "@workspace/api-zod";

export type EnrichmentResource = "reviews" | "facts";

export interface UseEnrichmentJobsOptions {
  resource: EnrichmentResource;
  id: number;
  /**
   * Latest enrichment status from the form. Drives re-run polling: while it is
   * "pending" the hook polls the server until the job resolves.
   */
  status: string | null;
  /** Read the current form enrichment (used only for the preview null-guard). */
  getEnrichment: () => FactEnrichment | null;
  /**
   * True while the admin has unsaved local edits. Polling is skipped whenever
   * this is true so a background sync can never clobber an in-progress edit.
   */
  isDirty: () => boolean;
  /**
   * Apply server-fetched enrichment + status to the form. The page's
   * implementation MUST clear its dirty flag (the form now matches the server,
   * so the universal autosave stays quiet) and refresh its "last saved" snapshot.
   */
  applyServerState: (enrichment: FactEnrichment | null, status: string | null) => void;
  /**
   * Flush the autosave draft now, so a regenerated preview runs against the
   * freshly-saved enrichment. Resolves false if the save failed.
   */
  saveNow: () => Promise<boolean>;
}

export interface UseEnrichmentJobsResult {
  /** A re-run or preview request is in flight (the POST itself). */
  loading: boolean;
  /** A re-run classification job is running server-side. */
  rerunBusy: boolean;
  /** A preview-regeneration job is running server-side. */
  previewBusy: boolean;
  error: string;
  onRerun: () => Promise<void>;
  onRegeneratePreview: () => Promise<void>;
}

const POLL_INTERVAL_MS = 2500;
const PREVIEW_MAX_TICKS = 40; // ~100s ceiling so a stuck job never polls forever.

function describeHttpError(status: number): string {
  if (status === 503) return "API unavailable — try again shortly.";
  if (status === 401 || status === 403) return "Not authorized.";
  return `Request failed (${status}).`;
}

export function useEnrichmentJobs(opts: UseEnrichmentJobsOptions): UseEnrichmentJobsResult {
  const { resource, id, status } = opts;
  const base = `/api/admin/${resource}/${id}`;

  const [loading, setLoading] = useState(false);
  const [rerunBusy, setRerunBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState("");
  // Bumped to (re)start a bounded preview-polling loop after POST /preview.
  const [previewPolls, setPreviewPolls] = useState(0);

  // Latest callbacks/values, read through refs so the polling effects depend
  // only on stable primitives (base/status) and never churn when the page
  // re-creates inline callbacks.
  const getEnrichmentRef = useRef(opts.getEnrichment);
  getEnrichmentRef.current = opts.getEnrichment;
  const isDirtyRef = useRef(opts.isDirty);
  isDirtyRef.current = opts.isDirty;
  const applyRef = useRef(opts.applyServerState);
  applyRef.current = opts.applyServerState;
  const saveNowRef = useRef(opts.saveNow);
  saveNowRef.current = opts.saveNow;
  // Tracks the server's previewStatus seen by the latest sync so preview polling
  // knows when the job has left "pending".
  const latestPreviewStatusRef = useRef<string | null | undefined>(undefined);

  /**
   * Pull fresh enrichment + status from the server and apply it — but only while
   * the admin has no unsaved edits (checked before AND after the await, since the
   * admin can start typing mid-request). Returns the fetched status, or null when
   * the sync was skipped/failed.
   */
  const syncFromServer = useCallback(async (): Promise<string | null> => {
    if (isDirtyRef.current()) return null;
    try {
      const r = await fetch(base, { credentials: "include" });
      if (!r.ok || isDirtyRef.current()) return null;
      const fresh = (await r.json()) as {
        enrichment?: FactEnrichment | null;
        enrichmentStatus?: string | null;
      };
      if (isDirtyRef.current()) return null;
      latestPreviewStatusRef.current = (fresh.enrichment as { previewStatus?: string } | null)?.previewStatus;
      applyRef.current(fresh.enrichment ?? null, fresh.enrichmentStatus ?? null);
      return fresh.enrichmentStatus ?? null;
    } catch {
      return null;
    }
  }, [base]);

  // Re-run polling: while status is "pending", poll until it resolves.
  useEffect(() => {
    if (status !== "pending") {
      setRerunBusy(false);
      return;
    }
    setRerunBusy(true);
    let cancelled = false;
    const handle = setInterval(() => {
      void (async () => {
        const next = await syncFromServer();
        if (cancelled) return;
        if (next !== null && next !== "pending") {
          clearInterval(handle);
          setRerunBusy(false);
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [status, syncFromServer]);

  // Preview polling: bounded loop kicked off by onRegeneratePreview.
  useEffect(() => {
    if (previewPolls === 0) return;
    setPreviewBusy(true);
    latestPreviewStatusRef.current = "pending";
    let cancelled = false;
    let ticks = 0;
    const handle = setInterval(() => {
      void (async () => {
        ticks += 1;
        await syncFromServer();
        if (cancelled) return;
        if (latestPreviewStatusRef.current !== "pending" || ticks >= PREVIEW_MAX_TICKS) {
          clearInterval(handle);
          setPreviewBusy(false);
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [previewPolls, syncFromServer]);

  const onRerun = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r = await fetch(`${base}/enrich`, { method: "POST", credentials: "include" });
      if (r.ok) {
        // Re-running discards local edits and recomputes from scratch: mark the
        // form as server-synced (clears dirty) and flip status to "pending",
        // which starts the re-run polling effect above.
        setRerunBusy(true);
        applyRef.current(getEnrichmentRef.current(), "pending");
      } else {
        setError(describeHttpError(r.status));
      }
    } catch {
      setError("Network error — could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, [base]);

  const onRegeneratePreview = useCallback(async () => {
    if (!getEnrichmentRef.current()) return;
    setLoading(true);
    setError("");
    // Persist the current enrichment first so the preview is generated from what
    // the admin sees, not a stale server copy.
    const saved = await saveNowRef.current();
    if (!saved) {
      setError("Could not save enrichment before regenerating the preview.");
      setLoading(false);
      return;
    }
    try {
      const r = await fetch(`${base}/preview`, { method: "POST", credentials: "include" });
      if (r.ok) {
        setPreviewPolls((n) => n + 1);
      } else {
        let msg = describeHttpError(r.status);
        try {
          const b = (await r.json()) as { error?: string };
          if (b?.error) msg = b.error;
        } catch {
          /* keep generic message */
        }
        setError(msg);
      }
    } catch {
      setError("Network error — could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, [base]);

  return { loading, rerunBusy, previewBusy, error, onRerun, onRegeneratePreview };
}
