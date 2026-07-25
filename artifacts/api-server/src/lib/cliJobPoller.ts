/**
 * Shared poll-to-terminal helper for CLI bulk-backfill scripts
 * (backfill-pexels.ts, backfill-fact-pexels.ts, backfill-ai-memes.ts).
 *
 * Enqueue is not completion (AGENTS.md's async-status rule, applied to a CLI
 * surface instead of an HTTP one) — a script that enqueues jobs and exits
 * immediately can't report real success/failure, and if the async-jobs worker
 * isn't running the enqueued jobs just sit `pending` forever with the script
 * having already exited looking "done". This polls each job's `async_jobs`
 * row directly by id (not a fact-level status column, which two other,
 * documented races can leave stale or coarser than the real outcome — see
 * factPexelsJobs.ts/aiMemeBackfillJobs.ts) until it reaches a terminal state
 * or the batch stalls.
 *
 * The stall ceiling is a ZERO-PROGRESS ceiling, not a fixed total-batch
 * duration: the pexels/ai_meme_backfill lanes are serialized
 * (maxConcurrency 1), so a large selection is processed strictly one job at a
 * time — a healthy worker steadily clearing a long queue can legitimately run
 * longer than any fixed cap sized for a small batch. Only give up once NO job
 * in the batch has resolved for `stallCeilingMs`.
 *
 * Per `docs/ai-context/agent-working-rules.md`'s "never surface a raw
 * internal ID" rule (a CLI script's console output is a log line a human is
 * expected to read), every log line uses each job's human-readable `label`
 * (a bounded text preview) instead of its numeric fact id.
 */

import { inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { asyncJobsTable } from "@workspace/db/schema";

export interface PollableJob {
  jobId: number;
  /** Human-readable label for log output — never the raw fact id. */
  label: string;
}

export interface PollJobsToTerminalResult {
  succeeded: number;
  skipped: number;
  failed: number;
  /** Still non-terminal when the stall ceiling was reached. */
  unresolved: PollableJob[];
}

export interface PollJobsToTerminalOptions {
  /** How often to re-check job statuses. Default 3s. */
  pollIntervalMs?: number;
  /** Give up once no job has resolved for this long. Default 15 minutes. */
  stallCeilingMs?: number;
  log?: (message: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSkipResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  return (result as { skipped?: unknown }).skipped === true;
}

/**
 * Poll a batch of enqueued jobs to a terminal state (`done`/`failed`) or
 * until the stall ceiling elapses with zero jobs resolving. Logs each job's
 * outcome as it resolves and returns the final tally.
 */
export async function pollJobsToTerminal(
  jobs: PollableJob[],
  opts: PollJobsToTerminalOptions = {},
): Promise<PollJobsToTerminalResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? 3_000;
  const stallCeilingMs = opts.stallCeilingMs ?? 15 * 60_000;
  const log = opts.log ?? ((msg: string) => console.log(msg));

  const byJobId = new Map(jobs.map((j) => [j.jobId, j]));
  const pending = new Set(jobs.map((j) => j.jobId));
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  let lastProgressAt = Date.now();

  while (pending.size > 0) {
    const rows = await db
      .select({ id: asyncJobsTable.id, status: asyncJobsTable.status, result: asyncJobsTable.result, lastError: asyncJobsTable.lastError })
      .from(asyncJobsTable)
      .where(inArray(asyncJobsTable.id, Array.from(pending)));

    let resolvedThisRound = false;
    for (const row of rows) {
      if (row.status !== "done" && row.status !== "failed") continue;
      const job = byJobId.get(row.id);
      if (!job) continue;
      pending.delete(row.id);
      resolvedThisRound = true;
      if (row.status === "failed") {
        failed++;
        log(`[FAILED] ${job.label}${row.lastError ? ` — ${row.lastError.split("\n")[0]}` : ""}`);
      } else if (isSkipResult(row.result)) {
        skipped++;
        log(`[SKIPPED] ${job.label}`);
      } else {
        succeeded++;
        log(`[OK] ${job.label}`);
      }
    }

    if (resolvedThisRound) lastProgressAt = Date.now();
    if (pending.size === 0) break;

    if (Date.now() - lastProgressAt >= stallCeilingMs) {
      log(`[STALLED] ${pending.size} job(s) still pending after ${Math.round(stallCeilingMs / 60_000)} minute(s) with no progress — is the async-jobs worker running?`);
      break;
    }

    await sleep(pollIntervalMs);
  }

  const unresolved = Array.from(pending)
    .map((id) => byJobId.get(id))
    .filter((j): j is PollableJob => j != null);

  return { succeeded, skipped, failed, unresolved };
}
