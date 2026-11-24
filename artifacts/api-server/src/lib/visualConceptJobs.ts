/**
 * Durable `fact_visual_concepts` queue (Slice 2A).
 *
 * One job per review cycle drafts THREE candidate Visual concepts and writes them
 * to the review's fact (`facts.visual_concept_candidates` + `visual_concept_status`).
 * Registered on the shared async-jobs worker.
 *
 * REVIEW-AWARE: the job reads the staging fact's text, its gags and its humor
 * note (the approved one, else the latest reading's draft: `humorNoteFor`),
 * so concepts reflect what the moderator is reviewing. The taxonomy is not an
 * input (Issue #1018, increment 1.2c-ii): ideas are written as soon as the
 * reading's draft note exists, whether or not the taxonomy run has finished.
 *
 * Lifecycle of `facts.visual_concept_status`:
 *   "pending"  — set by the enqueuer; the job is queued or retrying ("working").
 *   "ok"       — set by the handler when candidates land.
 *   "failed"   — set by onAbandon after the queue exhausts retries, and by the
 *                handler itself on a terminal failure (an unusable gag-writer
 *                engine), which the worker never passes to onAbandon.
 *
 * COST GUARD: concepts are only useful while the review is unresolved. If the
 * review is missing / resolved (approved/rejected) by the time the job runs, the
 * handler writes NOTHING and retires as a successful no-op — mirroring the
 * enrichment queue.
 *
 * GATING: Visual Ideas are the Gags step's "ideas generated"
 * artifact — a BLOCKING prep artifact, not best-effort. "approve-visual-concept"
 * refuses while the status is pending/failed/never-run (see routes/reviews.ts),
 * and re-prep/regenerate is blocked while the status is "pending" so a new cycle
 * can never coalesce onto a stale in-flight concept job. The generation itself is
 * still fire-and-poll (status drives the UI); "gating" means the moderator can't
 * approve the gag until it lands.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { factReadingsTable, factsTable, pendingReviewsTable, type AsyncJobRow } from "@workspace/db/schema";
import {
  isUnresolvedSubmissionStage,
  resolveRenderPolicy,
  visualConceptCandidatesBlobSchema,
  type ReviewWorkflowStage,
  type VisualConceptCandidatesBlob,
  type VisualConceptSource,
  type VisualConceptsResponse,
  type VisualConceptStaleReason,
  type VisualStrategyBubble,
} from "@workspace/api-zod";
import { lockFactRow } from "./reviewLocks";
import { loadGags, normaliseGagContent, openReviewForFact, primaryWorkingGag, type GagContent } from "./gags/resolver";
import { type Executor,
  claimConceptsForReview,
  ownedFact,
  reviewConceptOwner,
} from "./visualConceptOwner";
import { generateVisualConcepts, resolveVisualConceptsLLMSettings, VisualConceptsEngineUnusable, type ContextGag } from "./visualConcepts/generator";
import { buildVisualConceptInputHash, hashText } from "./visualConcepts/inputHash";
import { getVisualConceptsSystem } from "./visualConceptsConfig";
import {
  RESUMES_FROM_CHECKPOINTS,
  registerJobHandler,
  enqueueJob,
  type JobHandler,
  type HandlerResult,
  type EnqueueJobResult,
  terminalFailure,
} from "./asyncJobs";
import { logger } from "./logger";
import { applyHouseStyle } from "./templateGrammar";
import { assertJobOwnership, fencedTransaction } from "./jobFence";
import { enqueueGagPrefill, isUntouchedPrefill } from "./gags/prefill";

export const FACT_VISUAL_CONCEPTS_QUEUE = "fact_visual_concepts";

export interface FactVisualConceptsJobPayload {
  /** The review cycle. */
  reviewId: number;
  factId: number;
  /**
   * The generation's owner ('review:<id>:<generation>', migration 0140). A
   * job queued before owners existed has none and is its review's.
   */
  owner?: string | null;
  /** Regenerate: the moderator's unsaved draft, offered as distinct-alt context. */
  moderatorDraftScene?: string | null;
  /** Regenerate: the bubbles of that draft. */
  moderatorDraftBubbles?: Array<Pick<VisualStrategyBubble, "type" | "entity" | "text">> | null;
}

/** Review-scoped dedupe: an in-flight concept job for a review coalesces; a
 *  terminal one never blocks a fresh (Regenerate) run — the dedupe index only
 *  covers non-terminal rows. */
/** One generation, one job: keyed by the generation's owner, never shared with an earlier one. */
export function visualConceptsDedupeKey(owner: string): string {
  return `fact_visual_concepts:${owner}`;
}

/**
 * Enqueue concept generation for a review cycle and mark the fact "pending" so the
 * UI shows "working" immediately. Each call is a new generation with its own
 * owner and its own job key, so it is never folded into an earlier job: one
 * that has already stored its ideas but is not yet marked done would otherwise
 * absorb the request and leave the fact "pending" with no job to finish it
 * (Codex, PR #1041 round 1). The earlier generation, if still running, stops
 * owning the fact and writes nothing. Callers hold the fact row lock and
 * decide whether a new generation is wanted (lib/reviewLocks.ts).
 */
export async function enqueueVisualConceptsForReview(args: {
  reviewId: number;
  factId: number;
  moderatorDraftScene?: string | null;
  moderatorDraftBubbles?: Array<Pick<VisualStrategyBubble, "type" | "entity" | "text">> | null;
}, executor: Executor = db): Promise<EnqueueJobResult> {
  // The review takes the fact's candidate state and marks it working, in one
  // write. Given a transaction, both the claim
  // and the job commit with the caller's write or not at all (Issue #1000 §F).
  const owner = reviewConceptOwner(args.reviewId, randomUUID());
  await claimConceptsForReview(executor, args.factId, args.reviewId, { markPending: true, owner });
  return enqueueJob({
    queue: FACT_VISUAL_CONCEPTS_QUEUE,
    payload: {
      reviewId: args.reviewId,
      factId: args.factId,
      owner,
      moderatorDraftScene: args.moderatorDraftScene ?? null,
      moderatorDraftBubbles: args.moderatorDraftBubbles ?? null,
    },
    dedupeKey: visualConceptsDedupeKey(owner),
  }, executor);
}

// ─── Review-cycle resolution (shared by handler + endpoint staleness) ────────

export interface ResolvedConceptCycle {
  reviewId: number;
  stage: ReviewWorkflowStage;
  stagingFactId: number;
  factText: string;
  source: VisualConceptSource;
  /**
   * The review's primary working gag (lib/gags/resolver.ts), whose violence and
   * text policy the writer is held to, as the render is. Null for a review with
   * no gag yet (the defaults apply).
   */
  primaryGag: GagContent | null;
}

type ConceptCycleResult =
  | { ok: true; cycle: ResolvedConceptCycle }
  | { ok: false; reason: string; stage?: ReviewWorkflowStage };

/**
 * Load the review and its staging fact's text. Pure read; no LLM. The
 * taxonomy is not read: the gag writer no longer receives it.
 */
export async function resolveVisualConceptCycle(reviewId: number): Promise<ConceptCycleResult> {
  const [review] = await db
    .select({
      id: pendingReviewsTable.id,
      workflowStage: pendingReviewsTable.workflowStage,
      stagingFactId: pendingReviewsTable.stagingFactId,
    })
    .from(pendingReviewsTable)
    .where(eq(pendingReviewsTable.id, reviewId))
    .limit(1);
  if (!review) return { ok: false, reason: "review_not_found" };
  const stage = review.workflowStage as ReviewWorkflowStage;
  if (review.stagingFactId == null) return { ok: false, reason: "no_staging_fact", stage };
  const [fact] = await db.select({ text: factsTable.text }).from(factsTable).where(eq(factsTable.id, review.stagingFactId)).limit(1);
  if (!fact) return { ok: false, reason: "staging_fact_missing", stage };
  const primary = await primaryWorkingGag(review.stagingFactId);
  return {
    ok: true,
    cycle: { reviewId, stage, stagingFactId: review.stagingFactId, factText: fact.text, source: "staging_fact", primaryGag: primary?.content ?? null },
  };
}

/**
 * The humor note the gag writer is given for a fact: the approved note, else
 * the latest finished reading's draft (Issue #1018, increment 1.2c-ii: ideas
 * are written from the draft as soon as it exists, and again from the approved
 * note when the moderator changes it). Null when neither exists.
 */
export async function humorNoteFor(factId: number, executor: Executor = db): Promise<string | null> {
  const [fact] = await executor.select({ humorNote: factsTable.humorNote }).from(factsTable).where(eq(factsTable.id, factId)).limit(1);
  const approved = fact?.humorNote?.trim();
  if (approved) return approved;
  const [reading] = await executor
    .select({ draftNote: factReadingsTable.draftNote })
    .from(factReadingsTable)
    .where(and(eq(factReadingsTable.factId, factId), eq(factReadingsTable.status, "ok")))
    .orderBy(desc(factReadingsTable.id))
    .limit(1);
  return reading?.draftNote?.trim() || null;
}

/**
 * Every gag the fact already has, as the gag writer is shown it (plan
 * PLAN_THREE_GAGS.md, increment 2): slot order, each gag's working version
 * (its pending change, else its approved version). The request and its input hash use one call's result, so they
 * describe the same frozen list.
 *
 * A gag still exactly the idea it was pre-filled from is left out (Issue
 * #1018, increment 1.3b): it is one of the ideas, not the moderator's, so it
 * neither marks those ideas out of date nor steers the next ones away from
 * itself; a changed note replaces it (lib/gags/prefill.ts).
 */
export async function contextGagsFor(factId: number): Promise<ContextGag[]> {
  const out: ContextGag[] = [];
  for (const g of await loadGags(factId)) {
    if (g.draftRemoved || isUntouchedPrefill(g)) continue;
    const content = normaliseGagContent(g.pendingContent ?? g.approvedContent);
    const scene = content?.coreSceneOverride?.trim() ?? "";
    if (!scene) continue;
    out.push({ scene, bubbles: (content?.bubbles ?? []).map((b) => ({ type: b.type, entity: b.entity, text: b.text })) });
  }
  return out;
}

/**
 * The wording an idea set's freshness is judged against (plan
 * PLAN_FACT_HOUSE_STYLE.md, R1): the wording the set records it was drafted
 * for, while the fact's wording is exactly that wording in the house style;
 * otherwise the fact's own wording. A capital and a period added by the house
 * style therefore leave the set current, and any other change stales it.
 */
export function factTextForFreshness(current: string, recorded: string | undefined): string {
  if (recorded === undefined || recorded === current) return current;
  return applyHouseStyle(recorded) === current ? recorded : current;
}

/** Compute the CURRENT concept input hash for a cycle (no LLM). Shared by the
 *  handler (to stamp, with the gags it sent) and the endpoint (to test
 *  staleness, against the gags as they are now). */
export async function computeCurrentInputHash(cycle: ResolvedConceptCycle, gags?: ContextGag[]): Promise<string> {
  const settings = await resolveVisualConceptsLLMSettings();
  const systemPromptHash = hashText(await getVisualConceptsSystem());
  return buildVisualConceptInputHash({
    reviewId: cycle.reviewId,
    source: cycle.source,
    factText: cycle.factText,
    systemPromptHash,
    engineId: settings.provenance.engineId,
    model: settings.provenance.model,
    reasoningEffort: settings.provenance.reasoningEffort,
    gags: gags ?? (await contextGagsFor(cycle.stagingFactId)),
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
  const owner = jobOwner(payload);
  if (typeof factId !== "number" || typeof reviewId !== "number" || owner == null) {
    return { ok: false, error: "fact_visual_concepts payload missing its review, fact or owner" };
  }

  const resolved = await resolveVisualConceptCycle(reviewId);
  if (!resolved.ok) {
    // COST GUARD / no-op: review resolved or gone. Write nothing and retire
    // the job successfully (mirrors enrichment).
    logger.info({ reviewId, factId, reason: resolved.reason }, "[fact_visual_concepts] no-op (unresolvable cycle)");
    return { ok: true };
  }
  const cycle = resolved.cycle;

  // COST GUARD: only draft while the review is still unresolved (Reading, Gags
  // or Test Renders). Once approved/rejected, concepts are useless — no-op.
  // Gags is where these Visual Ideas actually gate.
  if (!isUnresolvedSubmissionStage(cycle.stage)) {
    logger.info({ reviewId, factId, stage: cycle.stage }, "[fact_visual_concepts] no-op (review resolved)");
    return { ok: true };
  }

  const draftScene = payload.moderatorDraftScene?.trim() ?? "";
  const draft: ContextGag | null = draftScene ? { scene: draftScene, bubbles: payload.moderatorDraftBubbles ?? [] } : null;

  // The humor note (approved, else the reading's draft); the request lists
  // every gag the fact already has (plan PLAN_THREE_GAGS.md, increment 2). One
  // read, used for both the request and the input hash.
  const existingGags = await contextGagsFor(cycle.stagingFactId);
  const humorNote = await humorNoteFor(cycle.stagingFactId);

  // COST GUARD: a later request for this review's ideas is its own generation
  // and has taken the fact; this one could write nothing, so it pays for nothing.
  const [holder] = await db.select({ owner: factsTable.visualConceptOwner }).from(factsTable).where(eq(factsTable.id, factId)).limit(1);
  if (holder?.owner !== owner) {
    logger.info({ reviewId, factId, owner }, "[fact_visual_concepts] no-op (a later generation owns the fact)");
    return { ok: true };
  }

  let result;
  try {
    await assertJobOwnership(); // paid AI call: only while this run owns its job (Issue #1000)
    result = await deps.generate({
      factText: cycle.factText,
      renderPolicy: resolveRenderPolicy(cycle.primaryGag ? { visualPromptStrategyOverride: cycle.primaryGag } : null),
      humorNote,
      existingGags,
      draft,
    });
  } catch (err) {
    // An unusable engine is a configuration fault: fail at once (no fallback
    // model, no ten hours of retries). The worker does not call onAbandon for a
    // terminal failure, so the handler writes "failed" itself; otherwise the
    // fact would stay "pending" with Regenerate and approval refusing it.
    // Anything else keeps the queue's retries with status "pending".
    if (err instanceof VisualConceptsEngineUnusable) {
      await fencedTransaction(db, (tx) => tx.update(factsTable).set({ visualConceptStatus: "failed" }).where(ownedFact(factId, owner)));
      return terminalFailure("gag_writer_engine_unusable", err.message);
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const inputHash = await computeCurrentInputHash(cycle, existingGags);
  const blob: VisualConceptCandidatesBlob = {
    candidates: result.candidates,
    generatedAt: new Date().toISOString(),
    provenance: result.provenance,
    reviewId: cycle.reviewId,
    source: cycle.source,
    inputHash,
    humorNoteUsed: humorNote,
    factTextUsed: cycle.factText,
  };

  // Written only while this generation still owns the fact: a review's
  // generation that finishes after a later one took over writes nothing
  // (plan section F). Ideas written from a
  // note the moderator has since replaced (approving an edited draft while
  // they were being written) are not stored: the job runs again, from the
  // note as it is now (Issue #1018, increment 1.2c-ii).
  const outcome = await fencedTransaction(db, async (tx) => {
    // The fact's lock first (level 2 of the lock rule, lib/reviewLocks.ts), so
    // an approval of another note cannot commit between this comparison and
    // the write below (Fable, PR #1041 round 1).
    await lockFactRow(tx, factId);
    if ((await humorNoteFor(factId, tx)) !== humorNote) return "note_changed" as const;
    const rows = await tx
      .update(factsTable)
      .set({ visualConceptCandidates: blob, visualConceptStatus: "ok" })
      .where(ownedFact(factId, owner))
      .returning({ id: factsTable.id });
    if (rows.length === 0) return "not_owner" as const;
    // Gag 1 from the first idea, or untouched pre-filled gags replaced after a
    // changed note (lib/gags/prefill.ts); a no-op off the Gags step.
    await enqueueGagPrefill({ reviewId, factId }, tx);
    return "written" as const;
  });
  if (outcome === "note_changed") {
    return { ok: false, error: "the humor note changed while the ideas were being written; writing them again from the new note" };
  }
  if (outcome === "not_owner") {
    logger.info({ reviewId, factId, owner }, "[fact_visual_concepts] result dropped (another generation owns the fact)");
  }

  return { ok: true };
}

/** A job's owner: its own, or, for one queued before owners existed, its review's. */
function jobOwner(payload: FactVisualConceptsJobPayload): string | null {
  if (payload.owner) return payload.owner;
  return typeof payload.reviewId === "number" ? reviewConceptOwner(payload.reviewId) : null;
}

export const factVisualConceptsJobHandler: JobHandler = {
  async run(payload: unknown): Promise<HandlerResult> {
    return runVisualConceptsJob((payload ?? {}) as FactVisualConceptsJobPayload);
  },

  // Retries exhausted: mark "failed" so the prep UI shows concept gen as
  // terminally failed (distinct from "still running"). Never touches the
  // workflow stage — concepts never gate production review.
  async onAbandon(row: AsyncJobRow): Promise<void> {
    const payload = (row.payload ?? {}) as FactVisualConceptsJobPayload;
    const { factId } = payload;
    const owner = jobOwner(payload);
    if (typeof factId !== "number" || owner == null) return;
    await db
      .update(factsTable)
      .set({ visualConceptStatus: "failed" })
      .where(ownedFact(factId, owner));
    logger.warn({ factId, jobId: row.id }, "[fact_visual_concepts] concept generation abandoned after retries");
  },
};

export function registerVisualConceptJobHandlers(): void {
  // Execution limit (Issue #1000): two 360 s concept calls and their name conversions, each up to 3 tries (about 39 min), plus margin.
  registerJobHandler(FACT_VISUAL_CONCEPTS_QUEUE, factVisualConceptsJobHandler, { executionLimitMs: 45 * 60_000, ...RESUMES_FROM_CHECKPOINTS });
}

// ─── Normalized review-detail response (server-computed `current`) ───────────

/**
 * Build the `visualConcepts` block the review-detail endpoint returns. The
 * server computes whether the stored candidates are CURRENT for the review by
 * comparing the stored reviewId / inputHash to the review's
 * live state — the FE never recomputes hashes.
 */
/** The fact columns a `visualConcepts` block is built from. */
export interface ConceptsRow {
  visualConceptStatus: string | null;
  visualConceptCandidates: unknown;
  humorNote?: string | null;
  humorNoteApprovedBy?: string | null;
  humorNoteApprovedAt?: Date | null;
}

/**
 * The `visualConcepts` block: everything but whether the stored candidates
 * were drafted for this cycle and its inputs, which `staleness` answers.
 */
async function assembleConceptsResponse(
  row: ConceptsRow,
  staleness: (blob: VisualConceptCandidatesBlob) => Promise<VisualConceptStaleReason | undefined>,
): Promise<VisualConceptsResponse> {
  const status = (row.visualConceptStatus as VisualConceptsResponse["status"]) ?? null;
  const savedNote = row.humorNote?.trim() || null;
  const humorNote = savedNote
    ? { text: savedNote, approvedBy: row.humorNoteApprovedBy ?? null, approvedAt: (row.humorNoteApprovedAt ?? new Date(0)).toISOString() }
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

  const parsed = visualConceptCandidatesBlobSchema.safeParse(row.visualConceptCandidates);
  if (!parsed.success) {
    // No usable blob (never generated, or shape drift). Report status only.
    return { status, candidates: [], current: false, humorNote, ...(failureReason ? { failureReason } : {}) };
  }
  const blob = parsed.data;

  let staleReason = await staleness(blob);
  // The approved note is kept out of the input hash and compared here: a
  // saved note that differs from the one these gags were written under means
  // they were written for another reading of the joke.
  if (staleReason === undefined && savedNote) {
    const under = blob.humorNoteUsed?.trim() ?? "";
    if (savedNote !== under) staleReason = "humor_note_changed";
  }

  return {
    status,
    candidates: blob.candidates,
    current: staleReason === undefined,
    ...(staleReason ? { staleReason } : {}),
    generatedAt: blob.generatedAt,
    humorNote,
    ...(failureReason ? { failureReason } : {}),
  };
}

export async function buildVisualConceptsResponse(review: ConceptsRow & { id: number }): Promise<VisualConceptsResponse> {
  return assembleConceptsResponse(review, async (blob) => {
    if (blob.reviewId !== review.id) return "review_mismatch";
    const resolved = await resolveVisualConceptCycle(review.id);
    if (!resolved.ok) return "input_hash_mismatch";
    const cycle = { ...resolved.cycle, factText: factTextForFreshness(resolved.cycle.factText, blob.factTextUsed) };
    if (blob.inputHash !== (await computeCurrentInputHash(cycle))) return "input_hash_mismatch";
    return undefined;
  });
}
