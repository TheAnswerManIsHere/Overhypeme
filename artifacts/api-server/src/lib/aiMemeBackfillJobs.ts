/**
 * Durable `fact_ai_meme_backfill` queue.
 *
 * Registered on the shared async-jobs worker (lib/asyncJobs.ts), on its own
 * dedicated `"ai_meme_backfill"` lane (maxConcurrency 1, matching the old
 * direct-call bulk route's "process sequentially so we don't hammer OpenAI
 * rate limits" behavior). One job per fact: it runs `generateAiMemeBackgrounds`
 * and writes `aiMemeImages` + `ai_meme_backfill_status` back to the fact,
 * surviving a process restart.
 *
 * `maxAttempts: 1` — `generateAiMemeBackgrounds` persists `aiMemeImages` only
 * once, after every slot (up to 9 paid image calls) succeeds; a failure on a
 * late slot loses everything from earlier successful slots, so automatic
 * retry would regenerate (and re-pay for) them. `suppressErrors: false` is
 * required — the `true` other call sites use catches internal errors and
 * returns normally, which would make this handler believe a fully-failed run
 * succeeded.
 *
 * Lifecycle of `facts.ai_meme_backfill_status`: "pending" | "processing" |
 * "ok" | "failed" | "skipped". Crash-recovery-safe entry guard: on entry, if
 * the marker is already "processing" OR already a terminal value, this run is
 * a `recoverStuckProcessing` replay of a job whose write already landed but
 * whose `async_jobs` row wasn't finalized — short-circuit without calling the
 * pipeline again (never re-running paid work). A pre-existing terminal marker
 * (ok/failed/skipped) resolves with the result that matches it. A
 * pre-existing "processing" marker is different: its outcome is genuinely
 * unconfirmed (the crashed attempt may or may not have finished), so this
 * moves it to "failed" rather than leaving it at "processing" — a stuck
 * "processing" marker is never reset by `enqueueFactAiMemeBackfill`'s
 * conditional write (deliberately, to protect a truly in-flight job), so
 * leaving it untouched here would strand the fact forever with no retry path
 * (Codex review, PR #256). Only past that guard, and an execution-time
 * `isActive` recheck, does the handler set "processing" immediately before
 * calling the pipeline.
 *
 * Known, deliberately deferred limitation (David, 2026-07-25 — tracked in
 * docs/engineering/deferred-work.md's "Async-queue enqueue-side status write
 * isn't transactional with enqueueJob" entry): the enqueue-side status write
 * and the `enqueueJob` call are sequential, not transactional —
 * `enqueueJob`'s own dedupe-conflict recovery isn't composable inside a
 * caller-managed transaction. A second, narrower race (a late enqueue landing
 * between this handler's terminal-marker write and its job row's
 * finalization) can also leave the marker orphaned at "pending" after the job
 * is already `done` — the underlying `aiMemeImages` data is unaffected either
 * way; only the status marker can go stale. Both are tracked in that
 * deferred-work entry, not fixed here.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { factsTable, type AsyncJobRow } from "@workspace/db/schema";
import { generateAiMemeBackgrounds } from "./aiMemePipeline";
import {
  registerJobHandler,
  enqueueJob,
  type JobHandler,
  type HandlerResult,
  type EnqueueJobResult,
} from "./asyncJobs";
import { logger } from "./logger";

export const FACT_AI_MEME_BACKFILL_QUEUE = "fact_ai_meme_backfill";

const NOT_ACTIVE_SKIP_RESULT = { skipped: true, reason: "not_active" as const };

export interface FactAiMemeBackfillJobPayload {
  factId: number;
}

/** Stable dedupe key so a re-enqueue can't double-run backfill for one fact. */
export function factAiMemeBackfillDedupeKey(factId: number): string {
  return `fact_ai_meme_backfill:fact:${factId}`;
}

/**
 * Enqueue durable AI-meme backfill for a fact. Writes the fact's status
 * BEFORE calling `enqueueJob`, not after — `enqueueJob` commits the
 * `async_jobs` row (immediately claimable) as part of its own insert, so a
 * write placed after it can race a worker that already claimed and set
 * "processing", clobbering it back to "pending". The write is conditional
 * (a no-op if a prior invocation is genuinely mid-flight, preserving the
 * crash-recovery guard) and committed as its own statement — sequential, not
 * wrapped in a shared transaction with the `enqueueJob` call (see module
 * docstring for why).
 */
export async function enqueueFactAiMemeBackfill(factId: number): Promise<EnqueueJobResult> {
  await db
    .update(factsTable)
    .set({ aiMemeBackfillStatus: "pending" })
    .where(and(
      eq(factsTable.id, factId),
      // NULL-safe "not processing": plain `ne()` compiles to `<> 'processing'`,
      // which is NULL on a never-enqueued fact (status NULL) and so silently
      // skips the write on every fact's first-ever enqueue.
      sql`${factsTable.aiMemeBackfillStatus} IS DISTINCT FROM 'processing'`,
    ));
  try {
    return await enqueueJob({
      queue: FACT_AI_MEME_BACKFILL_QUEUE,
      payload: { factId },
      dedupeKey: factAiMemeBackfillDedupeKey(factId),
      maxAttempts: 1,
    });
  } catch (err) {
    // The "pending" write above already landed; if enqueueJob's insert itself
    // rejects (a real DB error, not the dedupe-conflict path — that's caught
    // internally and never throws), no job row exists to ever finalize this
    // fact's status. Repair it to "failed" rather than stranding it at
    // "pending" forever with nothing left to run (Codex review, PR #256).
    await db.update(factsTable).set({ aiMemeBackfillStatus: "failed" }).where(eq(factsTable.id, factId));
    throw err;
  }
}

/**
 * Dependency seam for the handler: image generation is a network call
 * (OpenAI + fal.ai), so tests inject a deterministic stub.
 */
export interface FactAiMemeBackfillDeps {
  generate: typeof generateAiMemeBackgrounds;
}

/** Core handler logic, extracted so tests can inject `deps.generate`. */
export async function runFactAiMemeBackfillJob(
  factId: number,
  deps: FactAiMemeBackfillDeps = { generate: generateAiMemeBackgrounds },
): Promise<HandlerResult> {
  const [factRow] = await db
    .select({ text: factsTable.text, isActive: factsTable.isActive, aiMemeBackfillStatus: factsTable.aiMemeBackfillStatus })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .limit(1);
  if (!factRow) {
    return { ok: false, error: `fact ${factId} not found` };
  }

  // Crash-recovery replay guard: a pre-existing "processing" or terminal
  // marker at entry means this run's write already landed once before (the
  // job row just wasn't finalized) — resolve without repeating paid work.
  const existing = factRow.aiMemeBackfillStatus;
  if (existing === "processing") {
    // Conservatively resolve to "failed", not left at "processing": since
    // enqueueFactAiMemeBackfill's conditional write deliberately never resets
    // a "processing" marker (to protect a genuinely in-flight job), leaving it
    // untouched here would strand the fact forever — every future re-enqueue
    // preserves "processing", so every future run would hit this exact branch
    // again, permanently unretriable without manual DB intervention (Codex
    // review, PR #256). "failed" never claims unconfirmed success, but does
    // make the fact retryable again.
    await db.update(factsTable).set({ aiMemeBackfillStatus: "failed" }).where(eq(factsTable.id, factId));
    return { ok: false, error: "recovered replay: prior attempt's outcome is unconfirmed" };
  }
  if (existing === "ok") {
    return { ok: true };
  }
  if (existing === "failed") {
    return { ok: false, error: "recovered replay: prior attempt failed" };
  }
  if (existing === "skipped") {
    return { ok: true, result: NOT_ACTIVE_SKIP_RESULT };
  }

  // Execution-time inactive recheck: an enqueue-time check alone misses a
  // fact deactivated while its job waits in the serialized lane.
  if (!factRow.isActive) {
    await db.update(factsTable).set({ aiMemeBackfillStatus: "skipped" }).where(eq(factsTable.id, factId));
    return { ok: true, result: NOT_ACTIVE_SKIP_RESULT };
  }

  await db.update(factsTable).set({ aiMemeBackfillStatus: "processing" }).where(eq(factsTable.id, factId));

  try {
    await deps.generate(factId, factRow.text, { suppressErrors: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.update(factsTable).set({ aiMemeBackfillStatus: "failed" }).where(eq(factsTable.id, factId));
    return { ok: false, error: msg };
  }

  await db.update(factsTable).set({ aiMemeBackfillStatus: "ok" }).where(eq(factsTable.id, factId));
  return { ok: true };
}

export const factAiMemeBackfillJobHandler: JobHandler = {
  async run(payload: unknown): Promise<HandlerResult> {
    const { factId } = (payload ?? {}) as FactAiMemeBackfillJobPayload;
    if (typeof factId !== "number") {
      return { ok: false, error: "fact_ai_meme_backfill payload missing factId" };
    }
    return runFactAiMemeBackfillJob(factId);
  },

  // maxAttempts:1 means onAbandon fires on the very first failure too — but
  // the handler itself already writes "failed" onto the fact before
  // returning, so this is just the queue-level log line, not a second write.
  async onAbandon(row: AsyncJobRow): Promise<void> {
    const { factId } = (row.payload ?? {}) as FactAiMemeBackfillJobPayload;
    if (typeof factId !== "number") return;
    logger.warn({ factId, jobId: row.id }, "[fact_ai_meme_backfill] backfill abandoned");
  },
};

export function registerFactAiMemeBackfillHandler(): void {
  registerJobHandler(FACT_AI_MEME_BACKFILL_QUEUE, factAiMemeBackfillJobHandler, { lane: "ai_meme_backfill" });
}
