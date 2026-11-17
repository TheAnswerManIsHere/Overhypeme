/**
 * The durable `fact_ai_meme_backfill` queue, retired.
 *
 * It ran the legacy AI-background generator, which drew a fact with no photo.
 * The compiler review, Phase 2 (Issue #950 — every picture starts from a
 * photo) retired that generator: nothing enqueues here any more, and the
 * handler stays registered only so a job left in the queue ends without
 * starting a paid generation. Pictures it stored stay readable on the fact.
 */

import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { factsTable, type AsyncJobRow } from "@workspace/db/schema";
import { RESUMES_FROM_CHECKPOINTS, registerJobHandler, type JobHandler, type HandlerResult } from "./asyncJobs";
import { logger } from "./logger";
import { fencedTransaction } from "./jobFence";

export const FACT_AI_MEME_BACKFILL_QUEUE = "fact_ai_meme_backfill";

export const RETIRED_SKIP_RESULT = { skipped: true, reason: "retired" as const };

export interface FactAiMemeBackfillJobPayload {
  factId: number;
}

/**
 * A job still in the queue ends here without generating anything: the fact's
 * marker moves to "skipped" unless it already holds a terminal value.
 */
export async function runFactAiMemeBackfillJob(factId: number): Promise<HandlerResult> {
  const [factRow] = await db
    .select({ aiMemeBackfillStatus: factsTable.aiMemeBackfillStatus })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .limit(1);
  if (!factRow) return { ok: false, error: `fact ${factId} not found` };
  const existing = factRow.aiMemeBackfillStatus;
  if (existing !== "ok" && existing !== "failed" && existing !== "skipped") {
    await fencedTransaction(db, (tx) => tx.update(factsTable).set({ aiMemeBackfillStatus: "skipped" }).where(eq(factsTable.id, factId)));
  }
  logger.info({ factId }, "[fact_ai_meme_backfill] retired: the job ended without generating");
  return { ok: true, result: RETIRED_SKIP_RESULT };
}

export const factAiMemeBackfillJobHandler: JobHandler = {
  async run(payload: unknown): Promise<HandlerResult> {
    const { factId } = (payload ?? {}) as FactAiMemeBackfillJobPayload;
    if (typeof factId !== "number") {
      return { ok: false, error: "fact_ai_meme_backfill payload missing factId" };
    }
    return runFactAiMemeBackfillJob(factId);
  },

  async onAbandon(row: AsyncJobRow): Promise<void> {
    const { factId } = (row.payload ?? {}) as FactAiMemeBackfillJobPayload;
    if (typeof factId !== "number") return;
    logger.warn({ factId, jobId: row.id }, "[fact_ai_meme_backfill] abandoned");
  },
};

export function registerFactAiMemeBackfillHandler(): void {
  // Execution limit (Issue #1000): database only (retired queue).
  registerJobHandler(FACT_AI_MEME_BACKFILL_QUEUE, factAiMemeBackfillJobHandler, { lane: "ai_meme_backfill", executionLimitMs: 5 * 60_000, ...RESUMES_FROM_CHECKPOINTS });
}
