/**
 * @purpose The reading of a fact in moderation: research its references with web lookup, then draft its humor note; the durable `fact_reading` queue that runs it and starts gag ideas from the draft.
 * @subsystem moderation
 *
 * Plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, 1B (Issue #1018, increment
 * 1.2c-ii). Provisional approval starts a run (`startReading`, in its own
 * transaction, so a review never reaches the Reading step without one); the
 * Reading step's "Try again" starts another. Each run is a `fact_readings` row:
 *
 *   pending — queued or running; the Reading step shows "Reading the fact…"
 *   ok      — research and draft note stored (no references found is a result)
 *   failed  — the queue gave up (onAbandon); the step offers "Try again"
 *
 * On success, while the review still waits at Reading and this is the fact's
 * latest run, gag ideas are queued from the draft note in the same commit
 * (humorNoteFor), so they are ready, or nearly, when the moderator approves
 * the note. The taxonomy run is not waited for and never consulted.
 *
 * COST GUARD: a run whose review has closed (rejected, or approved) by the time
 * it starts makes no paid call and is marked failed as cancelled.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { factReadingsTable, factsTable, pendingReviewsTable, type AsyncJobRow } from "@workspace/db/schema";
import {
  PREPARING_STAGE_VALUES,
  factReadingResultSchema,
  type FactReadingResearch,
  type FactReadingResult,
  type FactReadingView,
  type ReviewReadingView,
  type ReviewWorkflowStage,
} from "@workspace/api-zod";
import { enqueueJob, registerJobHandler, type HandlerResult, type JobHandler } from "./asyncJobs";
import { assertJobOwnership, fencedTransaction } from "./jobFence";
import { logger } from "./logger";
import { renderCanonical } from "./renderCanonical";
import { lockFactRow, lockReview } from "./reviewLocks";
import { enqueueVisualConceptsForReview } from "./visualConceptJobs";
import type { Executor } from "./visualConceptOwner";
import { buildWebSearchRequest, callWebSearchModel, REFERENCE_RESEARCH_MODEL } from "./referenceResearch/openaiResponses";
import { getReadingSystem, READING_PROMPT_VERSION } from "./readingConfig";

export const READING_QUEUE = "fact_reading";

export interface ReadingJobPayload {
  readingId: number;
}

/**
 * Start a reading run for a fact: a pending row and its job, in the caller's
 * transaction (so a review moved to Reading always has a run behind it).
 */
export async function startReading(
  tx: Executor,
  args: { factId: number; reviewId: number | null; requestedBy: string | null },
): Promise<{ readingId: number }> {
  const [row] = await tx
    .insert(factReadingsTable)
    .values({ factId: args.factId, reviewId: args.reviewId, status: "pending", requestedBy: args.requestedBy })
    .returning({ id: factReadingsTable.id });
  await enqueueJob({
    queue: READING_QUEUE,
    payload: { readingId: row!.id } satisfies ReadingJobPayload,
    dedupeKey: `${READING_QUEUE}:${row!.id}`,
  }, tx);
  return { readingId: row!.id };
}

/** The fact's latest reading run, or null when none was ever started. */
export async function latestReading(factId: number, executor: Executor = db) {
  const [row] = await executor
    .select()
    .from(factReadingsTable)
    .where(eq(factReadingsTable.factId, factId))
    .orderBy(desc(factReadingsTable.id))
    .limit(1);
  return row ?? null;
}

function toView(row: typeof factReadingsTable.$inferSelect): FactReadingView {
  return {
    id: row.id,
    status: row.status,
    research: (row.research as FactReadingResearch | null) ?? null,
    draftNote: row.draftNote ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** What the Reading step shows: the fact's latest run and its approved note, from rows the caller read. */
export function readingView(
  latest: typeof factReadingsTable.$inferSelect | null,
  fact: { humorNote: string | null; humorNoteReadingId: number | null; humorNoteApprovedBy: string | null; humorNoteApprovedAt: Date | null },
): ReviewReadingView {
  const text = fact.humorNote?.trim();
  return {
    latest: latest ? toView(latest) : null,
    approved: text
      ? { text, readingId: fact.humorNoteReadingId, approvedBy: fact.humorNoteApprovedBy, approvedAt: (fact.humorNoteApprovedAt ?? new Date(0)).toISOString() }
      : null,
  };
}

// ─── The model call ─────────────────────────────────────────────────────────

/** Visible-output budget: up to a dozen references with sources, and the note. */
const READING_MAX_OUTPUT_TOKENS = 4000;

/** Mirror of factReadingResultSchema for Structured Outputs (strict JSON Schema). Keep in lockstep. */
const READING_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["references", "humorNote"],
  properties: {
    references: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["phrase", "meaning", "pictureImplication", "sources"],
        properties: {
          phrase: { type: "string" },
          meaning: { type: "string" },
          pictureImplication: { type: "string" },
          sources: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "url"],
              properties: { title: { type: "string" }, url: { type: "string" } },
            },
          },
        },
      },
    },
    humorNote: { type: "string" },
  },
};

export interface ReadingCallResult {
  result: FactReadingResult;
  provenance: Record<string, unknown>;
}

/** The output did not parse or did not validate: retryable, like any model fault. */
export class ReadingOutputInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadingOutputInvalid";
  }
}

/** The reading's request body: the web-search call with its schema and budget. Pure; the AI settings page reads it too. */
export function buildReadingRequest(systemPrompt: string, factText: string) {
  return buildWebSearchRequest({
    systemPrompt,
    userMessage: `FACT:\n${factText.trim()}`,
    schemaName: "fact_reading",
    schema: READING_JSON_SCHEMA,
    maxOutputTokens: READING_MAX_OUTPUT_TOKENS,
  });
}

/** Read one fact: one web-search call returning the research and the draft note. */
export async function readFact(factText: string): Promise<ReadingCallResult> {
  const started = Date.now();
  const raw = await callWebSearchModel(buildReadingRequest(await getReadingSystem(), factText));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReadingOutputInvalid(`the model returned something other than JSON: ${raw.slice(0, 120)}`);
  }
  const v = factReadingResultSchema.safeParse(parsed);
  if (!v.success) throw new ReadingOutputInvalid(`the model's answer did not validate: ${v.error.issues[0]?.message ?? "unknown"}`);
  return {
    result: v.data,
    provenance: { model: REFERENCE_RESEARCH_MODEL, promptVersion: READING_PROMPT_VERSION, durationMs: Date.now() - started },
  };
}

// ─── The handler ────────────────────────────────────────────────────────────

export interface ReadingJobDeps {
  read: (factText: string) => Promise<ReadingCallResult>;
}

/** Shown on the Reading step when a run ends without a note. */
const CANCELLED = "The submission was closed before the reading ran.";

async function failRun(readingId: number, error: string): Promise<void> {
  await db.update(factReadingsTable)
    .set({ status: "failed", error: error.slice(0, 500), completedAt: new Date() })
    .where(and(eq(factReadingsTable.id, readingId), eq(factReadingsTable.status, "pending")));
}

export async function runReadingJob(payload: ReadingJobPayload, deps: ReadingJobDeps = { read: readFact }): Promise<HandlerResult> {
  const readingId = payload?.readingId;
  if (typeof readingId !== "number") return { ok: false, error: "fact_reading payload missing readingId" };
  const [run] = await db.select().from(factReadingsTable).where(eq(factReadingsTable.id, readingId)).limit(1);
  if (!run || run.status !== "pending") return { ok: true }; // already finished, or gone with its fact

  if (run.reviewId != null && !(await reviewIsPreparing(run.reviewId))) {
    await failRun(readingId, CANCELLED);
    logger.info({ readingId, reviewId: run.reviewId }, "[reading] no-op (review closed)");
    return { ok: true };
  }
  const [fact] = await db.select({ text: factsTable.text }).from(factsTable).where(eq(factsTable.id, run.factId)).limit(1);
  if (!fact) return { ok: true };

  let answer: ReadingCallResult;
  try {
    await assertJobOwnership(); // paid AI call: only while this run owns its job (Issue #1000)
    answer = await deps.read(renderCanonical(fact.text));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // The lock rule (lib/reviewLocks.ts): the review, then the fact. Ideas start
  // only while the review still waits at Reading and this is the fact's latest
  // run, so a stale run never overwrites the ideas of a newer one.
  await fencedTransaction(db, async (tx) => {
    const review = run.reviewId != null ? await lockReview(tx, run.reviewId) : null;
    const [stored] = await tx.update(factReadingsTable)
      .set({
        status: "ok",
        research: { references: answer.result.references } satisfies FactReadingResearch,
        draftNote: answer.result.humorNote,
        provenance: answer.provenance,
        error: null,
        completedAt: new Date(),
      })
      .where(and(eq(factReadingsTable.id, readingId), eq(factReadingsTable.status, "pending")))
      .returning({ id: factReadingsTable.id });
    if (!stored || !review || review.status !== "pending" || review.workflowStage !== "reading") return;
    const latest = await latestReading(run.factId, tx);
    if (latest?.id !== readingId) return;
    await lockFactRow(tx, run.factId);
    await enqueueVisualConceptsForReview({ reviewId: review.id, factId: run.factId }, tx);
  });
  logger.info({ readingId, factId: run.factId, references: answer.result.references.length }, "[reading] stored");
  return { ok: true };
}

async function reviewIsPreparing(reviewId: number): Promise<boolean> {
  const [review] = await db
    .select({ status: pendingReviewsTable.status, workflowStage: pendingReviewsTable.workflowStage })
    .from(pendingReviewsTable)
    .where(eq(pendingReviewsTable.id, reviewId))
    .limit(1);
  return !!review && review.status === "pending"
    && (PREPARING_STAGE_VALUES as readonly ReviewWorkflowStage[]).includes(review.workflowStage);
}

export const readingJobHandler: JobHandler = {
  async run(payload: unknown): Promise<HandlerResult> {
    return runReadingJob((payload ?? {}) as ReadingJobPayload);
  },
  // Retries exhausted: the run fails visibly, and the Reading step offers
  // "Try again" (async-ui-status.md: a failure shows on the step that waits).
  async onAbandon(row: AsyncJobRow): Promise<void> {
    const readingId = (row.payload as ReadingJobPayload | null)?.readingId;
    if (typeof readingId !== "number") return;
    await failRun(readingId, `The reading could not be written: ${row.lastError ?? "the model did not answer"}`);
  },
};

export function registerReadingJobHandlers(): void {
  // Execution limit (Issue #1000): one web-search call of up to 120 s, plus database work and margin.
  registerJobHandler(READING_QUEUE, readingJobHandler, { executionLimitMs: 5 * 60_000 });
}
