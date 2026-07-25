/**
 * useBulkMediaBackfillActions — fires one of the three corpus-wide media
 * bulk-backfill routes (backfill-images, backfill-pexels, backfill-ai-memes)
 * and polls the returned jobs to a terminal state.
 *
 * Same reference pattern as `useTaxonomyHealthActions.ts` (poll
 * `/admin/taxonomy-health/job-status` by concrete jobId, never time out a
 * legitimately long-running job, only surface a stall after 24h of zero
 * progress) but deliberately NOT that hook: the three routes return a
 * different response shape (`{ jobs: [{factId,jobId,label,deduped}], outcomes:
 * [{factId,status,reason,label}], summary }`, no `TaxonomyHealthAction`
 * typing, no selection scope — they always target the whole corpus) and
 * there's no per-row Taxonomy Health list to drive, so the row-state/lastOp
 * machinery that hook carries doesn't apply here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type BulkBackfillActionKey = "backfill_images" | "backfill_pexels" | "backfill_ai_memes";

interface BulkBackfillJob {
  factId: number;
  jobId: number;
  deduped: boolean;
  label: string;
}
interface BulkBackfillSkip {
  factId: number;
  status: "skipped";
  reason: "not_active";
  label: string;
}
interface BulkBackfillResponse {
  success: true;
  jobs: BulkBackfillJob[];
  outcomes: BulkBackfillSkip[];
  summary: { requested: number; queued: number; skipped: number };
}

type PollableStatus = "pending" | "processing" | "done" | "failed" | "still_running";

interface JobView {
  factId: number;
  jobId: number;
  label: string;
  status: PollableStatus;
  error: string | null;
  /**
   * Set only when a terminal `done` job's stored result was a sanitized
   * `{ skipped: true, reason }` — a race-condition guard caught inside the
   * handler (e.g. the fact was deactivated while its job waited in the
   * serialized lane), as opposed to a route-level pre-skip, which arrives as
   * an `outcome`. Lets the UI render this as "Skipped", never a bare "Done".
   */
  skipped?: boolean;
}

interface OpState {
  jobs: JobView[];
  outcomes: BulkBackfillSkip[];
  posting: boolean;
  startedAt: number;
}

export interface BulkBackfillCounts {
  requested: number;
  queued: number;
  done: number;
  failed: number;
  skipped: number;
  running: number;
  stillRunning: number;
}

/** A single failed or skipped item, for per-fact display (never the raw factId). */
export interface BulkBackfillItemOutcome {
  label: string;
  status: "failed" | "skipped";
  error?: string | null;
}

const POLL_INTERVAL_MS = 2000;
// Same rationale as useTaxonomyHealthActions.ts: never time out a
// legitimately long-running backfill — only flag a genuinely stuck worker.
const STALL_GIVE_UP_MS = 24 * 60 * 60 * 1000;
// Same rationale as adminTaxonomyHealth.ts's GUARD_QUERY_CHUNK_SIZE: a
// corpus-wide backfill can have thousands of jobs in flight at once — an
// unchunked poll risks exceeding practical request/bind-parameter limits.
const POLL_CHUNK_SIZE = 200;

function countsOf(op: OpState | undefined): BulkBackfillCounts | null {
  if (!op) return null;
  const running = op.jobs.filter((j) => j.status === "pending" || j.status === "processing").length;
  const stillRunning = op.jobs.filter((j) => j.status === "still_running").length;
  const done = op.jobs.filter((j) => j.status === "done" && !j.skipped).length;
  const failed = op.jobs.filter((j) => j.status === "failed").length;
  const skipped = op.jobs.filter((j) => j.status === "done" && j.skipped).length + op.outcomes.length;
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

function itemOutcomesOf(op: OpState | undefined): BulkBackfillItemOutcome[] {
  if (!op) return [];
  const fromJobs: BulkBackfillItemOutcome[] = op.jobs
    .filter((j) => j.status === "failed" || (j.status === "done" && j.skipped))
    .map((j) => ({ label: j.label, status: j.status === "failed" ? "failed" : "skipped", error: j.error }));
  const fromOutcomes: BulkBackfillItemOutcome[] = op.outcomes.map((o) => ({ label: o.label, status: "skipped" }));
  return [...fromJobs, ...fromOutcomes];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface UseBulkMediaBackfillActionsResult {
  submit: (key: BulkBackfillActionKey, url: string) => Promise<void>;
  counts: (key: BulkBackfillActionKey) => BulkBackfillCounts | null;
  /** Failed/skipped items for this action, labeled — never the raw factId. */
  itemOutcomes: (key: BulkBackfillActionKey) => BulkBackfillItemOutcome[];
  busy: (key: BulkBackfillActionKey) => boolean;
  error: string | null;
}

export function useBulkMediaBackfillActions(): UseBulkMediaBackfillActionsResult {
  const [ops, setOps] = useState<Partial<Record<BulkBackfillActionKey, OpState>>>({});
  const [error, setError] = useState<string | null>(null);
  const opsRef = useRef(ops);
  opsRef.current = ops;
  const lastProgressRef = useRef(Date.now());

  const hasInflight = useMemo(
    () => Object.values(ops).some((op) => op?.jobs.some((j) => j.status === "pending" || j.status === "processing")),
    [ops],
  );

  const pollTick = useCallback(async () => {
    const inflight: number[] = [];
    for (const op of Object.values(opsRef.current)) {
      if (!op) continue;
      for (const j of op.jobs) if (j.status === "pending" || j.status === "processing") inflight.push(j.jobId);
    }
    if (inflight.length === 0) return;
    try {
      const chunks = chunk(inflight, POLL_CHUNK_SIZE);
      const responses = await Promise.all(
        chunks.map((jobIds) =>
          fetch("/api/admin/taxonomy-health/job-status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ jobs: jobIds.map((jobId) => ({ jobId })) }),
          }),
        ),
      );
      if (responses.some((r) => !r.ok)) return; // transient — keep polling, don't count as a stall
      const parsed = await Promise.all(
        responses.map(
          (r) => r.json() as Promise<{ jobs: Array<{ jobId: number; status: PollableStatus; error: string | null; skipped?: boolean }> }>,
        ),
      );
      const byId = new Map(parsed.flatMap((p) => p.jobs).map((j) => [j.jobId, j]));

      let progressed = false;
      for (const op of Object.values(opsRef.current)) {
        if (!op) continue;
        for (const j of op.jobs) {
          const fresh = byId.get(j.jobId);
          if (fresh && (fresh.status !== j.status || !!fresh.skipped !== !!j.skipped)) { progressed = true; break; }
        }
        if (progressed) break;
      }

      setOps((prev) => {
        const out: typeof prev = { ...prev };
        for (const key of Object.keys(out) as BulkBackfillActionKey[]) {
          const op = out[key];
          if (!op) continue;
          out[key] = {
            ...op,
            jobs: op.jobs.map((j) => {
              const fresh = byId.get(j.jobId);
              return fresh ? { ...j, status: fresh.status, error: fresh.error, skipped: fresh.skipped } : j;
            }),
          };
        }
        return out;
      });

      if (progressed) {
        lastProgressRef.current = Date.now();
        return;
      }
      // No change this poll — that's fine, the worker may just be between
      // batches. Keep polling indefinitely unless it's been stuck for ~24h.
      if (Date.now() - lastProgressRef.current >= STALL_GIVE_UP_MS) {
        setOps((prev) => {
          const out: typeof prev = { ...prev };
          for (const key of Object.keys(out) as BulkBackfillActionKey[]) {
            const op = out[key];
            if (!op) continue;
            out[key] = {
              ...op,
              jobs: op.jobs.map((j) =>
                j.status === "pending" || j.status === "processing" ? { ...j, status: "still_running" } : j,
              ),
            };
          }
          return out;
        });
        setError("Stopped monitoring after 24h with no progress — the job queue worker may be stuck.");
      }
    } catch {
      /* transient — try again next tick */
    }
  }, []);

  useEffect(() => {
    if (!hasInflight) {
      lastProgressRef.current = Date.now();
      return;
    }
    const handle = setInterval(() => { void pollTick(); }, POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [hasInflight, pollTick]);

  const submit = useCallback(async (key: BulkBackfillActionKey, url: string) => {
    setError(null);
    const startedAt = Date.now();
    lastProgressRef.current = Date.now();
    setOps((prev) => ({ ...prev, [key]: { jobs: [], outcomes: [], posting: true, startedAt } }));
    try {
      const r = await fetch(url, { method: "POST", credentials: "include" });
      if (!r.ok) {
        setOps((prev) => ({ ...prev, [key]: { ...prev[key]!, posting: false } }));
        setError(r.status === 401 || r.status === 403 ? "Not authorized." : `Action failed (${r.status}).`);
        return;
      }
      const data = (await r.json()) as BulkBackfillResponse;
      // A job just enqueued (or deduped onto an existing in-flight job) is
      // never terminal — a terminal job drops out of the dedupe index, so
      // "deduped" always means "still pending/processing somewhere".
      const jobs: JobView[] = data.jobs.map((j) => ({ factId: j.factId, jobId: j.jobId, label: j.label, status: "pending", error: null }));
      setOps((prev) => ({ ...prev, [key]: { jobs, outcomes: data.outcomes, posting: false, startedAt } }));
    } catch {
      setOps((prev) => ({ ...prev, [key]: { ...prev[key]!, posting: false } }));
      setError("Network error — could not reach the server.");
    }
  }, []);

  const counts = useCallback((key: BulkBackfillActionKey) => countsOf(ops[key]), [ops]);
  const itemOutcomes = useCallback((key: BulkBackfillActionKey) => itemOutcomesOf(ops[key]), [ops]);
  const busy = useCallback(
    (key: BulkBackfillActionKey) => {
      const op = ops[key];
      if (!op) return false;
      if (op.posting) return true;
      return op.jobs.some((j) => j.status === "pending" || j.status === "processing");
    },
    [ops],
  );

  return { submit, counts, itemOutcomes, busy, error };
}
