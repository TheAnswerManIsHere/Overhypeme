/**
 * useTaxonomyHealthActions — runs a Taxonomy Health action and makes the
 * underlying async-jobs work observable.
 *
 * Every action POST returns the shared `{ jobs, outcomes, summary }` contract:
 *   • `jobs`     — concrete async_jobs ids we poll (re-enrich / visual plan /
 *                  large projection repairs).
 *   • `outcomes` — work already resolved inline (small projection repairs) or
 *                  deliberately skipped (admin-edited rows). Terminal immediately.
 *
 * We poll `/job-status` by **jobId** (never by dedupe key) every couple seconds
 * until every job is terminal, or a bounded ceiling is hit — at which point the
 * remaining jobs are shown as "still running" (NOT failed). The hook tracks one
 * operation per scope ("bulk" or "row:<factId>") so a row spinner only disables
 * that row, never the whole panel.
 *
 * Note: a completed job is NOT proof the health issue is resolved. The caller
 * refreshes the summary + list (via `onChanged`) and that refreshed health data
 * remains the source of truth; this hook only reports operation progress.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  TaxonomyHealthAction,
  TaxonomyHealthActionResponse,
  ActionOutcome,
  AsyncJobStatusValue,
  JobStatusResponse,
} from "@workspace/api-zod";

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_TICKS = 45; // ~90s ceiling before we declare "still running".

export type UiOpState =
  | "posting"
  | "processing"
  | "done"
  | "failed"
  | "skipped"
  | "still_running"
  | "unknown";

interface JobView {
  factId: number;
  jobId: number;
  status: AsyncJobStatusValue | "still_running";
  error: string | null;
}

export interface OperationState {
  scope: string;
  action: TaxonomyHealthAction;
  jobs: JobView[];
  outcomes: ActionOutcome[];
  posting: boolean;
  startedAt: number;
  finishedAt?: number;
}

export interface OpCounts {
  requested: number;
  queued: number;
  done: number;
  failed: number;
  skipped: number;
  running: number;
  stillRunning: number;
}

export interface UseTaxonomyHealthActionsResult {
  /** Fire an action. `scope` is "bulk" or `row:<factId>`. */
  submit: (scope: string, action: TaxonomyHealthAction, url: string, body: Record<string, unknown>) => Promise<void>;
  error: string | null;
  /** State for a single row's action button. */
  rowState: (factId: number) => { state: UiOpState; outcome: ActionOutcome | null };
  /** Aggregate counts for a scope (used by the bulk progress line). */
  counts: (scope: string) => OpCounts | null;
  /** True while a scope's work is posting or actively running. */
  busy: (scope: string) => boolean;
  /** The most recent operation, for the last-action banner. */
  lastOp: OperationState | null;
  bannerDismissed: boolean;
  dismissBanner: () => void;
}

function deriveState(op: OperationState | undefined): UiOpState {
  if (!op) return "unknown";
  if (op.posting) return "posting";
  const running = op.jobs.filter((j) => j.status === "pending" || j.status === "processing").length;
  if (running > 0) return "processing";
  const still = op.jobs.filter((j) => j.status === "still_running").length;
  const failed =
    op.jobs.filter((j) => j.status === "failed").length +
    op.outcomes.filter((o) => o.status === "failed").length;
  const done =
    op.jobs.filter((j) => j.status === "done").length +
    op.outcomes.filter((o) => o.status === "done").length;
  const skipped = op.outcomes.filter((o) => o.status === "skipped").length;
  if (still > 0) return "still_running";
  if (failed > 0) return "failed";
  if (done > 0) return "done";
  if (skipped > 0) return "skipped";
  return "unknown";
}

function countsOf(op: OperationState | undefined): OpCounts | null {
  if (!op) return null;
  const running = op.jobs.filter((j) => j.status === "pending" || j.status === "processing").length;
  const stillRunning = op.jobs.filter((j) => j.status === "still_running").length;
  const done =
    op.jobs.filter((j) => j.status === "done").length +
    op.outcomes.filter((o) => o.status === "done").length;
  const failed =
    op.jobs.filter((j) => j.status === "failed").length +
    op.outcomes.filter((o) => o.status === "failed").length;
  const skipped = op.outcomes.filter((o) => o.status === "skipped").length;
  return {
    requested: op.jobs.length + op.outcomes.length,
    queued: op.jobs.length,
    done,
    failed,
    skipped,
    running,
    stillRunning,
  };
}

function mapJobs(
  ops: Record<string, OperationState>,
  fn: (j: JobView) => JobView,
): Record<string, OperationState> {
  const out: Record<string, OperationState> = {};
  for (const [scope, op] of Object.entries(ops)) {
    out[scope] = { ...op, jobs: op.jobs.map(fn) };
  }
  return out;
}

export function useTaxonomyHealthActions(
  onChanged: () => void,
): UseTaxonomyHealthActionsResult {
  const [ops, setOps] = useState<Record<string, OperationState>>({});
  const [error, setError] = useState<string | null>(null);
  const [lastScope, setLastScope] = useState<string | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const opsRef = useRef(ops);
  opsRef.current = ops;
  const tickRef = useRef(0);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const hasInflight = useMemo(
    () =>
      Object.values(ops).some((op) =>
        op.jobs.some((j) => j.status === "pending" || j.status === "processing"),
      ),
    [ops],
  );

  const pollTick = useCallback(async () => {
    tickRef.current += 1;
    const inflight: number[] = [];
    for (const op of Object.values(opsRef.current)) {
      for (const j of op.jobs) {
        if (j.status === "pending" || j.status === "processing") inflight.push(j.jobId);
      }
    }
    if (inflight.length === 0) return;
    // Ceiling hit: declare the stragglers "still running" rather than failed.
    if (tickRef.current > MAX_POLL_TICKS) {
      setOps((prev) =>
        mapJobs(prev, (j) =>
          j.status === "pending" || j.status === "processing"
            ? { ...j, status: "still_running" }
            : j,
        ),
      );
      onChangedRef.current();
      return;
    }
    try {
      const r = await fetch("/api/admin/taxonomy-health/job-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ jobs: inflight.map((jobId) => ({ jobId })) }),
      });
      if (!r.ok) return;
      const data = (await r.json()) as JobStatusResponse;
      const byId = new Map(data.jobs.map((j) => [j.jobId, j]));
      let anyTerminalNow = false;
      setOps((prev) =>
        mapJobs(prev, (j) => {
          const fresh = byId.get(j.jobId);
          if (!fresh) return j;
          if (
            (fresh.status === "done" || fresh.status === "failed") &&
            (j.status === "pending" || j.status === "processing")
          ) {
            anyTerminalNow = true;
          }
          return { ...j, status: fresh.status, error: fresh.error };
        }),
      );
      if (anyTerminalNow) onChangedRef.current();
    } catch {
      /* transient — try again next tick */
    }
  }, []);

  useEffect(() => {
    if (!hasInflight) {
      tickRef.current = 0;
      return;
    }
    const handle = setInterval(() => {
      void pollTick();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [hasInflight, pollTick]);

  const submit = useCallback(
    async (scope: string, action: TaxonomyHealthAction, url: string, body: Record<string, unknown>) => {
      setError(null);
      setBannerDismissed(false);
      setLastScope(scope);
      const startedAt = Date.now();
      setOps((prev) => ({
        ...prev,
        [scope]: { scope, action, jobs: [], outcomes: [], posting: true, startedAt },
      }));
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          setOps((prev) => ({
            ...prev,
            [scope]: { ...prev[scope]!, posting: false, finishedAt: Date.now() },
          }));
          setError(r.status === 401 || r.status === 403 ? "Not authorized." : `Action failed (${r.status}).`);
          return;
        }
        const data = (await r.json()) as TaxonomyHealthActionResponse;
        const jobs: JobView[] = data.jobs.map((j) => ({
          factId: j.factId,
          jobId: j.jobId,
          status: j.status,
          error: null,
        }));
        setOps((prev) => ({
          ...prev,
          [scope]: {
            scope,
            action,
            jobs,
            outcomes: data.outcomes,
            posting: false,
            startedAt: prev[scope]?.startedAt ?? startedAt,
            finishedAt: jobs.length === 0 ? Date.now() : undefined,
          },
        }));
        // Inline-only (no queued jobs) is terminal right away — refresh now.
        if (jobs.length === 0) onChangedRef.current();
      } catch {
        setOps((prev) => ({
          ...prev,
          [scope]: { ...prev[scope]!, posting: false, finishedAt: Date.now() },
        }));
        setError("Network error — could not reach the server.");
      }
    },
    [],
  );

  const rowState = useCallback(
    (factId: number) => {
      const op = ops[`row:${factId}`];
      const outcome = op?.outcomes.find((o) => o.factId === factId) ?? null;
      return { state: deriveState(op), outcome };
    },
    [ops],
  );

  const counts = useCallback((scope: string) => countsOf(ops[scope]), [ops]);
  const busy = useCallback(
    (scope: string) => {
      const s = deriveState(ops[scope]);
      return s === "posting" || s === "processing";
    },
    [ops],
  );

  const lastOp = lastScope ? ops[lastScope] ?? null : null;
  const dismissBanner = useCallback(() => setBannerDismissed(true), []);

  return { submit, error, rowState, counts, busy, lastOp, bannerDismissed, dismissBanner };
}
