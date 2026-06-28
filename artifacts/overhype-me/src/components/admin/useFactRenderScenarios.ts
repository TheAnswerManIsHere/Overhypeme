import { useCallback, useEffect, useRef, useState } from "react";
import {
  type RenderScenarioGrid,
  type RenderScenarioKey,
  type RenderScenarioStatus,
} from "@workspace/api-zod";

/**
 * Loads + polls the Step-2 "visual review" render-scenario grid for a review.
 *
 * Mirrors the rule-8 polling style of `useModerationRender` / `ModerationPexelsPanel`:
 * fetches `GET /api/admin/reviews/:id/render-scenarios`, then polls at ~1s with
 * **NO timeout** while any card is working. "Working" includes a REQUIRED card
 * still `missing`: when a review first enters production_review the backend only
 * enqueues the prepare job, so the first GET can win the race and see required
 * cards as `missing` before their attempts exist. We keep polling through that
 * so the auto-enqueued renders appear without a manual refresh. Stops once every
 * required card is terminal (done/failed/blocked) and no card is queued/rendering;
 * resumes automatically when a run pushes a card back to queued.
 *
 * Entity-agnostic name (`fact*`, not `review*`) so PR3 can reuse it; it currently
 * takes a `reviewId` because that's the only render-scenario surface that exists.
 */

const NON_TERMINAL_STATUSES: ReadonlySet<RenderScenarioStatus> = new Set<RenderScenarioStatus>([
  "queued",
  "rendering",
]);

/** True while at least one card is still working — the signal to keep polling. */
function gridIsActive(grid: RenderScenarioGrid | null): boolean {
  if (!grid) return false;
  return grid.cards.some(
    (c) =>
      NON_TERMINAL_STATUSES.has(c.status) ||
      // Required-but-missing = auto-render enqueued, attempt not created yet.
      (c.required && c.status === "missing"),
  );
}

interface UseFactRenderScenariosResult {
  grid: RenderScenarioGrid | null;
  loading: boolean;
  error: string | null;
  /** Enqueue render attempts for the given scenarios. `force` runs a non-applicable scenario. */
  runScenarios: (keys: RenderScenarioKey[], force?: boolean) => Promise<void>;
  /** Imperative one-shot refresh of the grid. */
  refresh: () => Promise<void>;
}

export function useFactRenderScenarios(
  reviewId: number,
  { enabled }: { enabled: boolean },
): UseFactRenderScenariosResult {
  const [grid, setGrid] = useState<RenderScenarioGrid | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Keep the latest grid for the poll loop without re-creating the interval.
  const gridRef = useRef<RenderScenarioGrid | null>(null);
  gridRef.current = grid;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const load = useCallback(
    async (opts?: { showSpinner?: boolean }) => {
      if (opts?.showSpinner) setLoading(true);
      try {
        const res = await fetch(`/api/admin/reviews/${reviewId}/render-scenarios`, {
          credentials: "include",
        });
        if (!res.ok) {
          // Transient while polling — keep what we have. Surface only on first load.
          if (gridRef.current === null) setError(`Failed to load render scenarios (${res.status})`);
          return;
        }
        const data = (await res.json()) as RenderScenarioGrid;
        setGrid(data);
        setError(null);
      } catch {
        if (gridRef.current === null) setError("Network error — could not load render scenarios.");
        // While polling, a network blip is ignored (no timeout).
      } finally {
        if (opts?.showSpinner) setLoading(false);
      }
    },
    [reviewId],
  );

  const refresh = useCallback(() => load({ showSpinner: false }), [load]);

  // Initial load (and reset) when enabled / review changes.
  useEffect(() => {
    clearTimer();
    if (!enabled) {
      setGrid(null);
      setError(null);
      return;
    }
    void load({ showSpinner: true });
    return clearTimer;
  }, [enabled, reviewId, load, clearTimer]);

  // Drive polling off the live grid: run a ~1s no-timeout poll while active,
  // stop when every card is terminal (rule 8). Resumes when a run re-activates.
  const active = gridIsActive(grid);
  useEffect(() => {
    if (!enabled) return;
    if (active) {
      if (!timerRef.current) {
        timerRef.current = setInterval(() => {
          void load({ showSpinner: false });
        }, 1000);
      }
    } else {
      clearTimer();
    }
    return clearTimer;
  }, [enabled, active, load, clearTimer]);

  const runScenarios = useCallback(
    async (keys: RenderScenarioKey[], force?: boolean) => {
      if (keys.length === 0) return;
      setError(null);
      try {
        const res = await fetch(`/api/admin/reviews/${reviewId}/render-scenarios`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scenarios: keys, ...(force ? { force: true } : {}) }),
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          setError(d.error ?? `Failed to start render (${res.status})`);
          return;
        }
        // Re-read immediately so the just-queued cards flip to queued and the
        // poll loop (driven by `active`) kicks in without waiting a tick.
        await load({ showSpinner: false });
      } catch {
        setError("Network error — could not start render.");
      }
    },
    [reviewId, load],
  );

  return { grid, loading, error, runScenarios, refresh };
}
