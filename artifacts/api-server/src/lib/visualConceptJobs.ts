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
 *   "failed"   — set by onAbandon after the queue exhausts retries, and by the
 *                handler itself on a terminal failure (an unusable gag-writer
 *                engine), which the worker never passes to onAbandon.
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

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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
import { loadGags, normaliseGagContent, openReviewForFact } from "./gags/resolver";
import { type Executor,
  claimConceptsForReview,
  liveConceptOwner,
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
import { assertJobOwnership, fencedTransaction } from "./jobFence";

export const FACT_VISUAL_CONCEPTS_QUEUE = "fact_visual_concepts";

export interface FactVisualConceptsJobPayload {
  /** The review cycle; null for a live draft (Draft more gags). */
  reviewId: number | null;
  factId: number;
  /**
   * The generation's owner ('review:<id>' or 'live:<id>', migration 0140). A
   * job queued before owners existed has none and is its review's.
   */
  owner?: string | null;
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
}, executor: Executor = db): Promise<EnqueueJobResult> {
  // The review takes the fact's candidate state (a live draft's is cleared)
  // and marks it working, in one write. Given a transaction, both the claim
  // and the job commit with the caller's write or not at all (Issue #1000 §F).
  await claimConceptsForReview(executor, args.factId, args.reviewId, { markPending: true });
  return enqueueJob({
    queue: FACT_VISUAL_CONCEPTS_QUEUE,
    payload: {
      reviewId: args.reviewId,
      factId: args.factId,
      owner: reviewConceptOwner(args.reviewId),
      candidateVersionId: args.candidateVersionId ?? null,
      moderatorDraftScene: args.moderatorDraftScene ?? null,
      moderatorDraftBubbles: args.moderatorDraftBubbles ?? null,
    },
    dedupeKey: visualConceptsDedupeKey(args.reviewId),
  }, executor);
}

/** Why a Draft more gags request is refused. */
export class LiveDraftRefused extends Error {
  constructor(readonly code: "FACT_NOT_FOUND" | "FACT_NOT_LIVE" | "REVIEW_OPEN" | "IDEAS_PENDING", message: string) {
    super(message);
    this.name = "LiveDraftRefused";
  }
}

/** One live draft, one job: keyed by the draft's owner, never shared across drafts (Codex, PR #958 round 1). */
export function liveConceptsDedupeKey(owner: string): string {
  return `fact_visual_concepts:${owner}`;
}

/**
 * Draft more gags on a live fact (plan PLAN_THREE_GAGS.md, increment 2): the
 * same gag writer, engine, prompt, validation and latest-only store, run
 * outside a review. Refused while a review is open (its own generation owns
 * the fact's ideas then) and while a generation is still working. The
 * request takes ownership; a review opened before it finishes takes it back,
 * and the draft then writes nothing.
 */
export async function enqueueLiveVisualConcepts(factId: number): Promise<EnqueueJobResult> {
  // One compare-and-set: the fact is live, no review is open and no live
  // draft is working, and this request takes ownership, all in a single write, so a
  // review opened or another draft started in between cannot be overwritten.
  // The claim and its job commit together, so a claim never stands without
  // the job that can end it (Codex, PR #958 round 2). The job's key is this
  // draft's own, so its insert cannot meet the queue's dedupe path, whose
  // conflict would abort the transaction.
  const owner = liveConceptOwner(randomUUID());
  const job = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(factsTable)
      .set({ visualConceptOwner: owner, visualConceptStatus: "pending" })
      .where(and(
        eq(factsTable.id, factId),
        eq(factsTable.isActive, true),
        // Only a live draft's "working" blocks another: a review's leftover
        // (its refresh declined while its ideas were queued) has no job that
        // will ever end it, and no review is open to own it.
        sql`(${factsTable.visualConceptStatus} IS DISTINCT FROM 'pending' OR ${factsTable.visualConceptOwner} IS NULL OR ${factsTable.visualConceptOwner} NOT LIKE 'live:%')`,
        sql`NOT EXISTS (SELECT 1 FROM ${pendingReviewsTable} WHERE ${pendingReviewsTable.stagingFactId} = ${factsTable.id} AND ${pendingReviewsTable.status} = 'pending')`,
      ))
      .returning({ id: factsTable.id });
    if (!claimed) return null;
    return enqueueJob({
      queue: FACT_VISUAL_CONCEPTS_QUEUE,
      payload: { reviewId: null, factId, owner, candidateVersionId: null, moderatorDraftScene: null, moderatorDraftBubbles: null },
      dedupeKey: liveConceptsDedupeKey(owner),
    }, tx);
  });
  if (!job) throw await liveDraftRefusal(factId);
  return job;
}

/** Why a live draft could not take the fact, read after the refused claim. */
async function liveDraftRefusal(factId: number): Promise<LiveDraftRefused> {
  const [fact] = await db
    .select({ isActive: factsTable.isActive, status: factsTable.visualConceptStatus })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .limit(1);
  if (!fact) return new LiveDraftRefused("FACT_NOT_FOUND", "Fact not found.");
  if (!fact.isActive) return new LiveDraftRefused("FACT_NOT_LIVE", "Draft more gags is for a live fact. A fact in moderation gets its ideas in its review.");
  if (await openReviewForFact(factId)) return new LiveDraftRefused("REVIEW_OPEN", "This fact has an open review. Draft its gags in the review.");
  return new LiveDraftRefused("IDEAS_PENDING", "Gag ideas are already being drafted for this fact.");
}

// ─── Review-cycle resolution (shared by handler + endpoint staleness) ────────

export interface ResolvedConceptCycle {
  /** Null for a live draft. */
  reviewId: number | null;
  /** Null for a live draft. */
  stage: ReviewWorkflowStage | null;
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

/**
 * A live fact's `{text, enrichment}` for Draft more gags: the fact must be
 * live with no open review (a review's own cycle owns its ideas). Pure read.
 */
export async function resolveLiveConceptCycle(factId: number): Promise<ConceptCycleResult> {
  const [fact] = await db
    .select({ id: factsTable.id, text: factsTable.text, enrichment: factsTable.enrichment, isActive: factsTable.isActive })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .limit(1);
  if (!fact) return { ok: false, reason: "fact_not_found" };
  if (!fact.isActive) return { ok: false, reason: "fact_not_live" };
  if (await openReviewForFact(factId)) return { ok: false, reason: "review_open" };
  const ev = validateEnrichment(fact.enrichment);
  if (!ev.ok) return { ok: false, reason: `enrichment_invalid: ${ev.error}` };
  return {
    ok: true,
    cycle: { reviewId: null, stage: null, stagingFactId: factId, candidateVersionId: null, factText: fact.text, enrichment: ev.data, source: "live_fact" },
  };
}

/**
 * Every gag the fact already has, as the gag writer is shown it (plan
 * PLAN_THREE_GAGS.md, increment 2): slot order, each gag's working version
 * (its pending change, else its approved version), a gag marked for removal
 * left out. The request and its input hash use one call's result, so they
 * describe the same frozen list.
 */
export async function contextGagsFor(factId: number): Promise<ContextGag[]> {
  const out: ContextGag[] = [];
  for (const g of await loadGags(factId)) {
    if (g.pendingRemove) continue;
    const content = normaliseGagContent(g.pendingContent ?? g.approvedContent);
    const scene = content?.coreSceneOverride?.trim() ?? "";
    if (!scene) continue;
    out.push({ scene, bubbles: (content?.bubbles ?? []).map((b) => ({ type: b.type, entity: b.entity, text: b.text })) });
  }
  return out;
}

/** Compute the CURRENT concept input hash for a cycle (no LLM). Shared by the
 *  handler (to stamp, with the gags it sent) and the endpoint (to test
 *  staleness, against the gags as they are now). */
export async function computeCurrentInputHash(cycle: ResolvedConceptCycle, gags?: ContextGag[]): Promise<string> {
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
  if (typeof factId !== "number" || owner == null) {
    return { ok: false, error: "fact_visual_concepts payload missing its fact or owner" };
  }
  const live = reviewId == null;

  const resolved = live ? await resolveLiveConceptCycle(factId) : await resolveVisualConceptCycle(reviewId);
  if (!resolved.ok) {
    // COST GUARD / no-op: review resolved or has no usable enrichment. Write
    // nothing and retire the job successfully (mirrors enrichment). A live
    // draft whose fact went out of reach (deactivated, or a review opened)
    // clears its own "pending", if it still owns it, so nothing reads as
    // working with no job behind it.
    if (live) {
      await fencedTransaction(db, (tx) => tx.update(factsTable).set({ visualConceptStatus: null }).where(ownedFact(factId, owner)));
    }
    logger.info({ reviewId, factId, reason: resolved.reason }, "[fact_visual_concepts] no-op (unresolvable cycle)");
    return { ok: true };
  }
  const cycle = resolved.cycle;

  // COST GUARD: only draft while the review is still unresolved (prep_pending /
  // concept_review / production_review). Once approved/rejected, concepts are
  // useless — no-op. concept_review is where these Visual Ideas actually gate.
  if (cycle.stage != null && !isUnresolvedSubmissionStage(cycle.stage)) {
    logger.info({ reviewId, factId, stage: cycle.stage }, "[fact_visual_concepts] no-op (review resolved)");
    return { ok: true };
  }

  const draftScene = payload.moderatorDraftScene?.trim() ?? "";
  const draft: ContextGag | null = draftScene ? { scene: draftScene, bubbles: payload.moderatorDraftBubbles ?? [] } : null;

  // The fact row holds the approved humor note; the request lists every gag
  // the fact already has (plan PLAN_THREE_GAGS.md, increment 2). One read,
  // used for both the request and the input hash.
  const [fact] = await db
    .select({ humorNote: factsTable.humorNote })
    .from(factsTable)
    .where(eq(factsTable.id, cycle.stagingFactId))
    .limit(1);
  const existingGags = await contextGagsFor(cycle.stagingFactId);
  const humorNote = fact?.humorNote?.trim() || null;

  let result;
  try {
    await assertJobOwnership(); // paid AI call: only while this run owns its job (Issue #1000)
    result = await deps.generate({
      factText: cycle.factText,
      enrichment: cycle.enrichment,
      renderPolicy: resolveRenderPolicy(cycle.enrichment),
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
    candidateVersionId: cycle.candidateVersionId,
    source: cycle.source,
    inputHash,
    jokeRead: result.jokeRead,
    humorNoteUsed: humorNote,
  };

  // Written only while this generation still owns the fact: a live draft
  // that finishes after a review opened, or a review's generation after a
  // later one took over, writes nothing (plan section F).
  const written = await fencedTransaction(db, (tx) => tx
    .update(factsTable)
    .set({ visualConceptCandidates: blob, visualConceptStatus: "ok" })
    .where(ownedFact(factId, owner))
    .returning({ id: factsTable.id }));
  if (written.length === 0) {
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
 * comparing the stored reviewId / candidateVersionId / inputHash to the review's
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
 * The `visualConcepts` block, shared by a review and by a live fact's Draft
 * more gags: everything but the one question that differs between them,
 * whether the stored candidates were drafted for this cycle and its inputs,
 * which `staleness` answers.
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

export async function buildVisualConceptsResponse(review: ConceptsRow & { id: number; candidateVersionId: number | null }): Promise<VisualConceptsResponse> {
  return assembleConceptsResponse(review, async (blob) => {
    if (blob.reviewId !== review.id) return "review_mismatch";
    if (blob.candidateVersionId !== review.candidateVersionId) return "candidate_version_mismatch";
    const resolved = await resolveVisualConceptCycle(review.id);
    if (!resolved.ok || blob.inputHash !== (await computeCurrentInputHash(resolved.cycle))) return "input_hash_mismatch";
    return undefined;
  });
}

/**
 * The `visualConcepts` block for a live fact's Draft more gags (plan
 * PLAN_THREE_GAGS.md, increment 2). Candidates are current only when a live
 * draft wrote them and its inputs (the fact, its classification, every gag,
 * the engine) are unchanged; a review's leftover candidates read as stale.
 */
export async function buildLiveVisualConceptsResponse(fact: ConceptsRow & { id: number; visualConceptOwner: string | null }): Promise<VisualConceptsResponse> {
  // "Working" on the live fact means a live draft is: a review's leftover
  // pending has no job that will end it (Codex, PR #958 round 1).
  const liveWorking = fact.visualConceptStatus !== "pending" || (fact.visualConceptOwner?.startsWith("live:") ?? false);
  const row = liveWorking ? fact : { ...fact, visualConceptStatus: null };
  return assembleConceptsResponse(row, async (blob) => {
    if (blob.source !== "live_fact" || blob.reviewId != null) return "review_mismatch";
    const resolved = await resolveLiveConceptCycle(fact.id);
    if (!resolved.ok || blob.inputHash !== (await computeCurrentInputHash(resolved.cycle))) return "input_hash_mismatch";
    return undefined;
  });
}

/** A live fact's drafted ideas, or null when the fact does not exist. */
export async function liveVisualConcepts(factId: number): Promise<VisualConceptsResponse | null> {
  const [fact] = await db
    .select({
      id: factsTable.id,
      visualConceptStatus: factsTable.visualConceptStatus,
      visualConceptCandidates: factsTable.visualConceptCandidates,
      visualConceptOwner: factsTable.visualConceptOwner,
      humorNote: factsTable.humorNote,
      humorNoteApprovedBy: factsTable.humorNoteApprovedBy,
      humorNoteApprovedAt: factsTable.humorNoteApprovedAt,
    })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .limit(1);
  return fact ? buildLiveVisualConceptsResponse(fact) : null;
}
