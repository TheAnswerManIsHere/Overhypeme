import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Drives "Render AI background" during fact moderation.
 *
 * Kicks a t2i render through the real Nano-Banana-2 pipeline
 * (`POST /api/admin/reviews/:id/render`) and polls the admin-gated status route
 * (`GET /api/admin/reviews/:id/renders/:renderJobId`) at ~1s with **no timeout**
 * (rule 8) until each attempt reaches a terminal state. A moderator can fire
 * several renders while tuning assumptions; each is tracked independently with
 * its own live status. Attempts persist (review-scoped) so reopening the modal
 * shows recent renders — restored TERMINAL rows do not resume polling.
 */

export type RenderAttemptStatus =
  | "queued"
  | "pending"
  | "prompt_ready"
  | "image_ready"
  | "failed"
  | "blocked";

const TERMINAL: ReadonlySet<RenderAttemptStatus> = new Set(["image_ready", "failed", "blocked"]);
export const isTerminalRenderStatus = (s: RenderAttemptStatus): boolean => TERMINAL.has(s);

export interface RenderAttemptMeta {
  name: string;
  pronouns: string;
  aspectRatio: string;
  fallbackGender: string;
  style: string;
  contentMode: string;
}

export interface RenderAttempt {
  renderJobId: string;
  attemptId: number | null;
  status: RenderAttemptStatus;
  generatedImageObjectPath: string | null;
  error: string | null;
  blockReason: string | null;
  /** Recommended fallback when the render was blocked (poor subject↔fact fit). */
  recommendedFallback: string | null;
  meta: RenderAttemptMeta;
}

/** Controls the render endpoint accepts — mirrors the prompt-preview body. */
export interface RenderControlsBody {
  lookStyleId: string | null;
  previewName?: string;
  previewPronouns?: string;
  renderControls: {
    aspectRatio: string;
    contentMode: string;
    negativeSpacePreference: string;
    fallbackSubjectGender: string;
  };
  identityPolicyOverrides: { preservePhysique: boolean };
  meta: RenderAttemptMeta;
}

const STORAGE_PREFIX = "overhype:rpp:v1:review-render-attempts:";
const attemptsKey = (reviewId: number) => `${STORAGE_PREFIX}${reviewId}`;

/** Object-storage path → served API url (generated render images only). */
export function objectPathToApiUrl(path: string): string {
  return `/api/storage/objects${path.replace(/^\/objects/, "")}`;
}

interface PollPayload {
  status: RenderAttemptStatus;
  attemptId: number;
  generatedImageObjectPath: string | null;
  blocked: boolean;
  blockReason: string | null;
  error: string | null;
  subjectFactCompatibility?: { recommendedFallback?: string | null } | null;
}

export function useModerationRender(reviewId: number | undefined) {
  const [attempts, setAttempts] = useState<RenderAttempt[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live interval handles per renderJobId so we can clear precisely.
  const timersRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const reviewIdRef = useRef(reviewId);
  reviewIdRef.current = reviewId;

  const clearTimer = useCallback((renderJobId: string) => {
    const t = timersRef.current.get(renderJobId);
    if (t) { clearInterval(t); timersRef.current.delete(renderJobId); }
  }, []);

  const clearAllTimers = useCallback(() => {
    for (const t of timersRef.current.values()) clearInterval(t);
    timersRef.current.clear();
  }, []);

  const persist = useCallback((rows: RenderAttempt[]) => {
    if (reviewId === undefined) return;
    try { localStorage.setItem(attemptsKey(reviewId), JSON.stringify(rows)); } catch { /* ignore */ }
  }, [reviewId]);

  const patchAttempt = useCallback((renderJobId: string, patch: Partial<RenderAttempt>) => {
    setAttempts((prev) => {
      const next = prev.map((a) => (a.renderJobId === renderJobId ? { ...a, ...patch } : a));
      persist(next);
      return next;
    });
  }, [persist]);

  const startPolling = useCallback((renderJobId: string) => {
    if (reviewIdRef.current === undefined) return;
    if (timersRef.current.has(renderJobId)) return;
    const tick = async () => {
      const rid = reviewIdRef.current;
      if (rid === undefined) return;
      try {
        const res = await fetch(`/api/admin/reviews/${rid}/renders/${renderJobId}`, { credentials: "include" });
        if (!res.ok) return; // transient; keep polling (no timeout)
        const data = (await res.json()) as PollPayload;
        patchAttempt(renderJobId, {
          status: data.status,
          attemptId: data.attemptId,
          generatedImageObjectPath: data.generatedImageObjectPath,
          error: data.error,
          blockReason: data.blockReason,
          recommendedFallback: data.subjectFactCompatibility?.recommendedFallback ?? null,
        });
        if (isTerminalRenderStatus(data.status)) clearTimer(renderJobId);
      } catch { /* network blip — keep polling */ }
    };
    const handle = setInterval(() => { void tick(); }, 1000);
    timersRef.current.set(renderJobId, handle);
    void tick();
  }, [patchAttempt, clearTimer]);

  // Restore persisted attempts when the review changes; resume polling only for
  // NON-terminal rows (rule 8: status must be live without a refresh), never for
  // terminal ones.
  useEffect(() => {
    clearAllTimers();
    if (reviewId === undefined) { setAttempts([]); return; }
    let restored: RenderAttempt[] = [];
    try {
      const raw = localStorage.getItem(attemptsKey(reviewId));
      if (raw) restored = JSON.parse(raw) as RenderAttempt[];
    } catch { restored = []; }
    setAttempts(restored);
    setError(null);
    for (const a of restored) {
      if (!isTerminalRenderStatus(a.status)) startPolling(a.renderJobId);
    }
    return () => clearAllTimers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewId]);

  const render = useCallback(async (body: RenderControlsBody) => {
    if (reviewId === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const { meta, ...payload } = body;
      const res = await fetch(`/api/admin/reviews/${reviewId}/render`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subjectRenderMode: "t2i_fallback", ...payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.message ?? data?.error ?? `Render failed (${res.status})`);
        return;
      }
      const row: RenderAttempt = {
        renderJobId: data.renderJobId,
        attemptId: data.attemptId ?? null,
        status: "queued",
        generatedImageObjectPath: null,
        error: null,
        blockReason: null,
        recommendedFallback: null,
        meta,
      };
      setAttempts((prev) => {
        const next = [row, ...prev];
        persist(next);
        return next;
      });
      startPolling(row.renderJobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Render request failed");
    } finally {
      setBusy(false);
    }
  }, [reviewId, persist, startPolling]);

  return { attempts, render, busy, error };
}
