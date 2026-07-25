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
  TaxonomyHealthSkipReason,
} from "@workspace/api-zod";

/** Human copy for a terminal handler-level (job-based) skip — see `JobView.skipReason`. */
const SKIP_REASON_MESSAGE: Record<TaxonomyHealthSkipReason, string> = {
  admin_edited: "Admin-edited enrichment is protected by default.",
  not_applicable: "Not applicable to this fact.",
  already_current: "Already current.",
  missing_required_data: "Missing required data.",
  already_in_review: "Refresh already in review.",
  not_active: "Only active facts can be sent back.",
};

// Near-real-time: re-poll every ~1s so each row + the summary update within a
// second of the backend changing.
const POLL_INTERVAL_MS = 1000;
// We NEVER time out a legitimately long-running job. Async jobs are meant to be
// long and robust — enriching 1000 facts can take an hour, and that's fine. We
// keep polling until every job is terminal (done/failed; the worker itself
// marks a crash-looping job `failed` after its retries). The ONLY reason to
// stop is a job making no progress for an extreme window — a stuck/dead worker
// — at which point we surface a loud "something's wrong" message. 24h.
const STALL_GIVE_UP_MS = 24 * 60 * 60 * 1000;

export type UiOpState =
  | "posting"
  | "queued"
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
  /**
   * Set only when a terminal `done` job's stored result was a sanitized
   * `{ skipped: true, reason }` — a race-condition guard caught inside the
   * handler (as opposed to a picker pre-skip, which arrives as an `outcome`).
   * Lets the UI render this as "Skipped", never a bare "Done".
   */
  skipped?: boolean;
  skipReason?: TaxonomyHealthSkipReason;
}

export interface OperationState {
  scope: string;
  action: TaxonomyHealthAction;
  jobs: JobView[];
  outcomes: ActionOutcome[];
  posting: boolean;
  startedAt: number;
  finishedAt?: number;
  /** Bulk send-back only: corpus-wide counts from the action response. */
  totalStale?: number;
  eligibleRemaining?: number;
  batchLimit?: number;
  /** Bulk send-back `all_stale` only: facts currently circuit-broken by repeated failures. */
  repeatedFailureCount?: number;
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
  /**
   * Per-fact state for a row's indicator. Reflects ANY operation touching the
   * fact — so a fact queued by a BULK run lights up its own row exactly like a
   * single-click re-enrich would.
   */
  rowState: (factId: number) => { state: UiOpState; outcome: ActionOutcome | null };
  /** Aggregate counts for a scope (used by the bulk progress line). */
  counts: (scope: string) => OpCounts | null;
  /** True while a scope's work is posting or actively running. */
  busy: (scope: string) => boolean;
  /** True while a specific fact has in-flight work from any operation. */
  factBusy: (factId: number) => boolean;
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
  // A terminal `done` job whose result was a handler-level skip counts as
  // skipped, never done — see `JobView.skipped`.
  const done =
    op.jobs.filter((j) => j.status === "done" && !j.skipped).length +
    op.outcomes.filter((o) => o.status === "done").length;
  const skipped =
    op.jobs.filter((j) => j.status === "done" && j.skipped).length +
    op.outcomes.filter((o) => o.status === "skipped").length;
  if (still > 0) return "still_running";
  if (failed > 0) return "failed";
  if (done > 0) return "done";
  if (skipped > 0) return "skipped";
  return "unknown";
}

/** State of a single fact within an operation (drives the per-row indicator). */
function deriveFactState(
  op: OperationState,
  job: JobView | null,
  outcome: ActionOutcome | null,
): UiOpState {
  if (job) {
    switch (job.status) {
      case "pending": return "queued";
      case "processing": return "processing";
      case "done": return job.skipped ? "skipped" : "done";
      case "failed": return "failed";
      case "still_running": return "still_running";
    }
  }
  if (outcome) {
    if (outcome.status === "done") return "done";
    if (outcome.status === "failed") return "failed";
    if (outcome.status === "skipped") return "skipped";
  }
  if (op.posting) return "posting";
  return "unknown";
}

function countsOf(op: OperationState | undefined): OpCounts | null {
  if (!op) return null;
  const running = op.jobs.filter((j) => j.status === "pending" || j.status === "processing").length;
  const stillRunning = op.jobs.filter((j) => j.status === "still_running").length;
  const done =
    op.jobs.filter((j) => j.status === "done" && !j.skipped).length +
    op.outcomes.filter((o) => o.status === "done").length;
  const failed =
    op.jobs.filter((j) => j.status === "failed").length +
    op.outcomes.filter((o) => o.status === "failed").length;
  const skipped =
    op.jobs.filter((j) => j.status === "done" && j.skipped).length +
    op.outcomes.filter((o) => o.status === "skipped").length;
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
  // Wall-clock of the last observed status change. Used ONLY to detect a
  // genuinely stuck worker (no progress for STALL_GIVE_UP_MS) — never to stop
  // polling a run that's still making progress, however long it takes.
  const lastProgressRef = useRef(Date.now());
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  // Scopes we've already refreshed for. We refresh the summary+list ONCE an
  // operation fully completes — never per-job — so a bulk run's rows stay put
  // (each showing its own spinner → ✓) instead of vanishing mid-run.
  const finalizedRef = useRef<Set<string>>(new Set());

  const hasInflight = useMemo(
    () =>
      Object.values(ops).some((op) =>
        op.jobs.some((j) => j.status === "pending" || j.status === "processing"),
      ),
    [ops],
  );

  // Refresh once for every operation that has just become fully terminal.
  // `statusFor(jobId)` returns the post-update status of an in-flight job.
  const finalizeCompletedOps = useCallback(
    (statusFor: (jobId: number) => AsyncJobStatusValue | "still_running" | undefined) => {
      for (const op of Object.values(opsRef.current)) {
        if (op.jobs.length === 0) continue;
        const inflight = op.jobs.some((j) => {
          const s = statusFor(j.jobId) ?? j.status;
          return s === "pending" || s === "processing";
        });
        if (!inflight && !finalizedRef.current.has(op.scope)) {
          finalizedRef.current.add(op.scope);
          onChangedRef.current();
        }
      }
    },
    [],
  );

  const pollTick = useCallback(async () => {
    const inflight: number[] = [];
    for (const op of Object.values(opsRef.current)) {
      for (const j of op.jobs) {
        if (j.status === "pending" || j.status === "processing") inflight.push(j.jobId);
      }
    }
    if (inflight.length === 0) return;
    try {
      const r = await fetch("/api/admin/taxonomy-health/job-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ jobs: inflight.map((jobId) => ({ jobId })) }),
      });
      if (!r.ok) return; // transient — keep polling, don't count as a stall
      const data = (await r.json()) as JobStatusResponse;
      const byId = new Map(data.jobs.map((j) => [j.jobId, j]));

      // Did anything actually change since last poll?
      let progressed = false;
      for (const op of Object.values(opsRef.current)) {
        for (const j of op.jobs) {
          const fresh = byId.get(j.jobId);
          if (fresh && fresh.status !== j.status) { progressed = true; break; }
        }
        if (progressed) break;
      }

      // Functional update so a concurrently-submitted op is never clobbered.
      setOps((prev) =>
        mapJobs(prev, (j) => {
          const fresh = byId.get(j.jobId);
          return fresh
            ? { ...j, status: fresh.status, error: fresh.error, skipped: fresh.skipped, skipReason: fresh.skipReason }
            : j;
        }),
      );
      finalizeCompletedOps((jobId) => byId.get(jobId)?.status);

      if (progressed) {
        lastProgressRef.current = Date.now();
        return;
      }
      // No change this poll — that's fine, the worker may just be between
      // batches. Keep polling indefinitely unless it's been stuck for ~24h,
      // which means the worker is dead/crash-looping and won't finish.
      if (Date.now() - lastProgressRef.current >= STALL_GIVE_UP_MS) {
        setOps((prev) =>
          mapJobs(prev, (j) =>
            j.status === "pending" || j.status === "processing"
              ? { ...j, status: "still_running" }
              : j,
          ),
        );
        finalizeCompletedOps(() => "still_running");
        setError(
          "Stopped monitoring after 24h with no progress — the job queue worker may be stuck. Check the async jobs queue; something went wrong.",
        );
      }
    } catch {
      /* transient — try again next tick */
    }
  }, [finalizeCompletedOps]);

  useEffect(() => {
    if (!hasInflight) {
      lastProgressRef.current = Date.now();
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
      finalizedRef.current.delete(scope); // this scope is starting fresh
      lastProgressRef.current = Date.now(); // reset the stuck-worker watchdog
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
            totalStale: data.totalStale,
            eligibleRemaining: data.eligibleRemaining,
            batchLimit: data.batchLimit,
            repeatedFailureCount: data.repeatedFailureCount,
          },
        }));
        // Inline-only (no queued jobs) is terminal right away — refresh now.
        if (jobs.length === 0) {
          finalizedRef.current.add(scope);
          onChangedRef.current();
        }
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

  // Find the most-recent operation touching this fact (bulk OR single-click)
  // and report just that fact's state, so every queued fact animates its row.
  const factOp = useCallback(
    (factId: number): { op: OperationState; job: JobView | null; outcome: ActionOutcome | null } | null => {
      const candidates = Object.values(ops).filter(
        (op) =>
          op.jobs.some((j) => j.factId === factId) ||
          op.outcomes.some((o) => o.factId === factId) ||
          (op.posting && op.scope === `row:${factId}`),
      );
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => b.startedAt - a.startedAt);
      const op = candidates[0]!;
      return {
        op,
        job: op.jobs.find((j) => j.factId === factId) ?? null,
        outcome: op.outcomes.find((o) => o.factId === factId) ?? null,
      };
    },
    [ops],
  );

  const rowState = useCallback(
    (factId: number) => {
      const found = factOp(factId);
      if (!found) return { state: "unknown" as UiOpState, outcome: null };
      const state = deriveFactState(found.op, found.job, found.outcome);
      // A handler-level (job-based) skip has no picker `outcome` — synthesize
      // one so `ActionIndicator` (outcome-driven) can render its reason exactly
      // like a picker pre-skip would.
      if (state === "skipped" && !found.outcome && found.job?.skipReason) {
        const reason = found.job.skipReason;
        const synthesized: ActionOutcome = {
          factId,
          action: found.op.action,
          status: "skipped",
          reason,
          message: SKIP_REASON_MESSAGE[reason],
        };
        return { state, outcome: synthesized };
      }
      return { state, outcome: found.outcome };
    },
    [factOp],
  );

  const factBusy = useCallback(
    (factId: number) => {
      const s = rowState(factId).state;
      return s === "posting" || s === "queued" || s === "processing";
    },
    [rowState],
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

  return { submit, error, rowState, counts, busy, factBusy, lastOp, bannerDismissed, dismissBanner };
}
