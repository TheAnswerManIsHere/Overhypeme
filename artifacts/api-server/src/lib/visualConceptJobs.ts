/**
 * Durable `fact_visual_concepts` queue (Slice 2A).
 *
 * One job per review cycle drafts THREE candidate Visual concepts and writes them
 * to the review's fact (`facts.visual_concept_candidates` + `visual_concept_status`).
 * Registered on the shared async-jobs worker.
 *
 * REVIEW-AWARE: the job resolves `{text, enrichment}` through
 * `resolveReviewCycleEnrichment` — a first-time cycle reads the staging fact's own
 * `facts.enrichment`; a refresh cycle (candidateVersionId set) reads the candidate
 * version's enrichment. So concepts always reflect what the moderator is reviewing,
 * never a stale (active) enrichment during a refresh.
 *
 * Lifecycle of `facts.visual_concept_status`:
 *   "pending"  — set by the enqueuer; the job is queued or retrying ("working").
 *   "ok"       — set by the handler when candidates land.
 *   "failed"   — set ONLY by onAbandon after the queue exhausts retries.
 *
 * COST GUARD: concepts are only useful while the review is unresolved. If the
 * review is missing / resolved (approved/rejected) by the time the job runs, the
 * handler writes NOTHING and retires as a successful no-op — mirroring the
 * enrichment queue.
 *
 * GATING: Visual Ideas are the Step 2 (Visual Concept) gate's "ideas generated"
 * artifact — a BLOCKING prep artifact, not best-effort. "approve-visual-concept"
 * refuses while the status is pending/failed/never-run (see routes/reviews.ts),
 * and re-prep/regenerate is blocked while the status is "pending" so a new cycle
 * can never coalesce onto a stale in-flight concept job. The generation itself is
 * still fire-and-poll (status drives the UI); "gating" means the moderator can't
 * approve the gag until it lands.
 */

import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { factsTable, pendingReviewsTable, type AsyncJobRow } from "@workspace/db/schema";
import {
  isUnresolvedSubmissionStage,
  resolveRenderPolicy,
  validateEnrichment,
  visualConceptCandidatesBlobSchema,
  type FactEnrichment,
  type ReviewWorkflowStage,
  type VisualConceptCandidatesBlob,
  type VisualConceptSource,
  type VisualConceptsResponse,
  type VisualConceptStaleReason,
  type VisualStrategyBubble,
} from "@workspace/api-zod";
import { resolveReviewCycleEnrichment } from "./moderationStaging";
import { generateVisualConcepts, resolveVisualConceptsLLMSettings, VisualConceptsEngineUnusable, type ContextGag } from "./visualConcepts/generator";
import { buildVisualConceptInputHash, hashText } from "./visualConcepts/inputHash";
import { getVisualConceptsSystem } from "./visualConceptsConfig";
import {
  registerJobHandler,
  enqueueJob,
  type JobHandler,
  type HandlerResult,
  type EnqueueJobResult,
  terminalFailure,
} from "./asyncJobs";
import { logger } from "./logger";

export const FACT_VISUAL_CONCEPTS_QUEUE = "fact_visual_concepts";

export interface FactVisualConceptsJobPayload {
  reviewId: number;
  factId: number;
  candidateVersionId?: number | null;
  /** Regenerate: the moderator's unsaved draft, offered as distinct-alt context. */
  moderatorDraftScene?: string | null;
  /** Regenerate: the bubbles of that draft. */
  moderatorDraftBubbles?: Array<Pick<VisualStrategyBubble, "type" | "entity" | "text">> | null;
}

/** Review-scoped dedupe: an in-flight concept job for a review coalesces; a
 *  terminal one never blocks a fresh (Regenerate) run — the dedupe index only
 *  covers non-terminal rows. */
export function visualConceptsDedupeKey(reviewId: number): string {
  return `fact_visual_concepts:review:${reviewId}`;
}

/**
 * Enqueue concept generation for a review cycle and mark the fact "pending" so the
 * UI shows "working" immediately. Best-effort: the status write is what the UI
 * polls, the job is what does the work; a draft (Regenerate) rides the payload.
 */
export async function enqueueVisualConceptsForReview(args: {
  reviewId: number;
  factId: number;
  candidateVersionId?: number | null;
  moderatorDraftScene?: string | null;
  moderatorDraftBubbles?: Array<Pick<VisualStrategyBubble, "type" | "entity" | "text">> | null;
}): Promise<EnqueueJobResult> {
  await db
    .update(factsTable)
    .set({ visualConceptStatus: "pending" })
    .where(eq(factsTable.id, args.factId));
  return enqueueJob({
    queue: FACT_VISUAL_CONCEPTS_QUEUE,
    payload: {
      reviewId: args.reviewId,
      factId: args.factId,
      candidateVersionId: args.candidateVersionId ?? null,
      moderatorDraftScene: args.moderatorDraftScene ?? null,
      moderatorDraftBubbles: args.moderatorDraftBubbles ?? null,
    },
    dedupeKey: visualConceptsDedupeKey(args.reviewId),
  });
}

// ─── Review-cycle resolution (shared by handler + endpoint staleness) ────────

export interface ResolvedConceptCycle {
  reviewId: number;
  stage: ReviewWorkflowStage;
  stagingFactId: number;
  candidateVersionId: number | null;
  factText: string;
  enrichment: FactEnrichment;
  source: VisualConceptSource;
}

type ConceptCycleResult =
  | { ok: true; cycle: ResolvedConceptCycle }
  | { ok: false; reason: string; stage?: ReviewWorkflowStage };

/**
 * Load the review + resolve the cycle's `{text, enrichment}` the way the render
 * path does — first-time cycle → staging fact enrichment; refresh cycle →
 * candidate-version enrichment. Pure read; no LLM.
 */
export async function resolveVisualConceptCycle(reviewId: number): Promise<ConceptCycleResult> {
  const [review] = await db
    .select({
      id: pendingReviewsTable.id,
      workflowStage: pendingReviewsTable.workflowStage,
      stagingFactId: pendingReviewsTable.stagingFactId,
      candidateVersionId: pendingReviewsTable.candidateVersionId,
    })
    .from(pendingReviewsTable)
    .where(eq(pendingReviewsTable.id, reviewId))
    .limit(1);
  if (!review) return { ok: false, reason: "review_not_found" };
  const stage = review.workflowStage as ReviewWorkflowStage;
  if (review.stagingFactId == null) return { ok: false, reason: "no_staging_fact", stage };
  const cycle = await resolveReviewCycleEnrichment(review);
  if (!cycle) return { ok: false, reason: "staging_fact_missing", stage };
  const ev = validateEnrichment(cycle.rawEnrichment);
  if (!ev.ok) return { ok: false, reason: `enrichment_invalid: ${ev.error}`, stage };
  return {
    ok: true,
    cycle: {
      reviewId,
      stage,
      stagingFactId: review.stagingFactId,
      candidateVersionId: review.candidateVersionId,
      factText: cycle.text,
      enrichment: ev.data,
      source: cycle.source,
    },
  };
}

/** Compute the CURRENT concept input hash for a cycle (no LLM). Shared by the
 *  handler (to stamp) and the endpoint (to test staleness). */
export async function computeCurrentInputHash(cycle: ResolvedConceptCycle): Promise<string> {
  const settings = await resolveVisualConceptsLLMSettings();
  const systemPromptHash = hashText(await getVisualConceptsSystem());
  return buildVisualConceptInputHash({
    reviewId: cycle.reviewId,
    candidateVersionId: cycle.candidateVersionId,
    source: cycle.source,
    factText: cycle.factText,
    enrichment: cycle.enrichment,
    systemPromptHash,
    engineId: settings.provenance.engineId,
    model: settings.provenance.model,
    reasoningEffort: settings.provenance.reasoningEffort,
  });
}

// ─── Handler ──────────────────────────────────────────────────────────────

/**
 * Dependency seam for the handler: concept generation is a network call, so
 * tests inject a deterministic stub to exercise the cost-guard / success /
 * retryable-failure / write branches without hitting OpenAI.
 */
export interface VisualConceptsJobDeps {
  generate: typeof generateVisualConcepts;
}

export async function runVisualConceptsJob(
  payload: FactVisualConceptsJobPayload,
  deps: VisualConceptsJobDeps = { generate: generateVisualConcepts },
): Promise<HandlerResult> {
  const { reviewId, factId } = payload;
  if (typeof reviewId !== "number" || typeof factId !== "number") {
    return { ok: false, error: "fact_visual_concepts payload missing reviewId/factId" };
  }

  const resolved = await resolveVisualConceptCycle(reviewId);
  if (!resolved.ok) {
    // COST GUARD / no-op: review resolved or has no usable enrichment. Write
    // nothing and retire the job successfully (mirrors enrichment).
    logger.info({ reviewId, factId, reason: resolved.reason }, "[fact_visual_concepts] no-op (unresolvable cycle)");
    return { ok: true };
  }
  const cycle = resolved.cycle;

  // COST GUARD: only draft while the review is still unresolved (prep_pending /
  // concept_review / production_review). Once approved/rejected, concepts are
  // useless — no-op. concept_review is where these Visual Ideas actually gate.
  if (!isUnresolvedSubmissionStage(cycle.stage)) {
    logger.info({ reviewId, factId, stage: cycle.stage }, "[fact_visual_concepts] no-op (review resolved)");
    return { ok: true };
  }

  const draftScene = payload.moderatorDraftScene?.trim() ?? "";
  const draft: ContextGag | null = draftScene ? { scene: draftScene, bubbles: payload.moderatorDraftBubbles ?? [] } : null;

  // The fact row holds the approved humor note and the live, approved gag.
  // During a refresh the cycle's enrichment is the candidate version's, so the
  // saved gag is read from the fact itself, never from the candidate.
  const [fact] = await db
    .select({ humorNote: factsTable.humorNote, enrichment: factsTable.enrichment })
    .from(factsTable)
    .where(eq(factsTable.id, cycle.stagingFactId))
    .limit(1);
  const liveOverride = validateEnrichment(fact?.enrichment).ok
    ? (fact!.enrichment as FactEnrichment).visualPromptStrategyOverride
    : undefined;
  const savedScene = liveOverride?.coreSceneOverride?.trim() ?? "";
  const savedGag: ContextGag | null = savedScene ? { scene: savedScene, bubbles: liveOverride?.bubbles ?? [] } : null;
  const humorNote = fact?.humorNote?.trim() || null;

  let result;
  try {
    result = await deps.generate({
      factText: cycle.factText,
      enrichment: cycle.enrichment,
      renderPolicy: resolveRenderPolicy(cycle.enrichment),
      humorNote,
      savedGag,
      draft,
    });
  } catch (err) {
    // An unusable engine is a configuration fault: fail at once (no fallback
    // model, no ten hours of retries). Anything else keeps the queue's retries;
    // status stays "pending" (still running) and "failed" is onAbandon-only.
    if (err instanceof Error && err.name === "VisualConceptsEngineUnusable") return terminalFailure("gag_writer_engine_unusable", err.message);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const inputHash = await computeCurrentInputHash(cycle);
  const blob: VisualConceptCandidatesBlob = {
    candidates: result.candidates,
    generatedAt: new Date().toISOString(),
    provenance: result.provenance,
    reviewId: cycle.reviewId,
    candidateVersionId: cycle.candidateVersionId,
    source: cycle.source,
    inputHash,
    jokeRead: result.jokeRead,
    humorNoteUsed: humorNote,
  };

  await db
    .update(factsTable)
    .set({ visualConceptCandidates: blob, visualConceptStatus: "ok" })
    .where(eq(factsTable.id, factId));

  return { ok: true };
}

export const factVisualConceptsJobHandler: JobHandler = {
  async run(payload: unknown): Promise<HandlerResult> {
    return runVisualConceptsJob((payload ?? {}) as FactVisualConceptsJobPayload);
  },

  // Retries exhausted: mark "failed" so the prep UI shows concept gen as
  // terminally failed (distinct from "still running"). Never touches the
  // workflow stage — concepts never gate production review.
  async onAbandon(row: AsyncJobRow): Promise<void> {
    const { factId } = (row.payload ?? {}) as FactVisualConceptsJobPayload;
    if (typeof factId !== "number") return;
    await db
      .update(factsTable)
      .set({ visualConceptStatus: "failed" })
      .where(eq(factsTable.id, factId));
    logger.warn({ factId, jobId: row.id }, "[fact_visual_concepts] concept generation abandoned after retries");
  },
};

export function registerVisualConceptJobHandlers(): void {
  registerJobHandler(FACT_VISUAL_CONCEPTS_QUEUE, factVisualConceptsJobHandler);
}

// ─── Normalized review-detail response (server-computed `current`) ───────────

/**
 * Build the `visualConcepts` block the review-detail endpoint returns. The
 * server computes whether the stored candidates are CURRENT for the review by
 * comparing the stored reviewId / candidateVersionId / inputHash to the review's
 * live state — the FE never recomputes hashes.
 */
export async function buildVisualConceptsResponse(review: {
  id: number;
  candidateVersionId: number | null;
  visualConceptStatus: string | null;
  visualConceptCandidates: unknown;
  humorNote?: string | null;
  humorNoteApprovedBy?: string | null;
  humorNoteApprovedAt?: Date | null;
}): Promise<VisualConceptsResponse> {
  const status = (review.visualConceptStatus as VisualConceptsResponse["status"]) ?? null;
  const savedNote = review.humorNote?.trim() || null;
  const humorNote = savedNote
    ? { text: savedNote, approvedBy: review.humorNoteApprovedBy ?? null, approvedAt: (review.humorNoteApprovedAt ?? new Date(0)).toISOString() }
    : null;
  // A failure the moderator can act on: the gag writer's engine is unusable.
  // Resolving it is a read that never throws, so this screen keeps loading.
  let failureReason: string | undefined;
  if (status === "failed") {
    const settings = await resolveVisualConceptsLLMSettings();
    if (settings.unusableReason) {
      failureReason = new VisualConceptsEngineUnusable(settings.unusableReason, settings.provenance.engineId).message;
    }
  }

  const parsed = visualConceptCandidatesBlobSchema.safeParse(review.visualConceptCandidates);
  if (!parsed.success) {
    // No usable blob (never generated, or shape drift). Report status only.
    return { status, candidates: [], current: false, humorNote, ...(failureReason ? { failureReason } : {}) };
  }
  const blob = parsed.data;

  let staleReason: VisualConceptStaleReason | undefined;
  if (blob.reviewId !== review.id) {
    staleReason = "review_mismatch";
  } else if (blob.candidateVersionId !== review.candidateVersionId) {
    staleReason = "candidate_version_mismatch";
  } else {
    const resolved = await resolveVisualConceptCycle(review.id);
    if (!resolved.ok || blob.inputHash !== (await computeCurrentInputHash(resolved.cycle))) {
      staleReason = "input_hash_mismatch";
    }
  }
  // The approved note is kept out of the input hash, so confirming a correct
  // read does not stale the gags it was confirmed beside. A saved note that
  // differs from both the note these gags were written under and their own
  // joke read means they were written for another reading of the joke.
  if (staleReason === undefined && savedNote) {
    const under = blob.humorNoteUsed?.trim() ?? "";
    const read = blob.jokeRead?.trim() ?? "";
    if (savedNote !== under && savedNote !== read) staleReason = "humor_note_changed";
  }

  return {
    status,
    candidates: blob.candidates,
    current: staleReason === undefined,
    ...(staleReason ? { staleReason } : {}),
    generatedAt: blob.generatedAt,
    ...(blob.jokeRead ? { jokeRead: blob.jokeRead } : {}),
    humorNote,
    ...(failureReason ? { failureReason } : {}),
  };
}
