/**
 * @purpose Fills a submission's gags from its gag ideas on the Gags step: gag 1 from the first idea when the fact has no gag, and, after a changed humor note, every gag still exactly the idea it was filled from.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, item 9 and 1C (Issue #1018,
 * increment 1.3b):
 *   - On arrival at Gags, gag 1 is pre-filled from the first idea. A gag the
 *     moderator saved first is never replaced: a fact that already has a gag
 *     gets none.
 *   - Saving a changed humor note writes fresh ideas (routes/reviews.ts); when
 *     they land, every gag whose draft is still exactly the idea it was filled
 *     from is replaced by the new idea in the same position, its cast read
 *     again and its draft picks dropped. A gag edited by hand is kept, judged
 *     as it stands when the ideas arrive.
 *
 * The record of which idea a gag came from is `fact_gags.prefilled_from`
 * (migration 0158): its scene, bubbles and the note it was written under. A
 * gag is "untouched" while its draft scene and bubbles equal that record.
 *
 * A durable job (`gag_prefill`), because a gag cannot be stored without a cast
 * and reading one is a model call (./castExtraction.ts), which never runs
 * inside a transaction. Enqueued when ideas are stored (lib/visualConceptJobs.ts),
 * when the reading is approved and when Test Renders goes back to Gags
 * (routes/reviews.ts). The job decides, reads casts, then writes under the
 * lock rule, checking again that nothing it decided on has changed; a job
 * whose decision is overtaken writes nothing and a later one acts. Each
 * request has its own key, so a request is never folded into an earlier job.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, factGagsTable, factsTable, pendingReviewsTable, type FactGag, type GagPrefilledFrom } from "@workspace/db";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  canApproveGags,
  isCandidateConceptPickable,
  visualConceptCandidatesBlobSchema,
  withCandidateConceptDraft,
  type ReviewWorkflowStage,
  type StoredCandidateConcept,
  type VisualConceptCandidatesBlob,
} from "@workspace/api-zod";
import { stableStringify } from "../factRenderScenarios";
import { RESUMES_FROM_CHECKPOINTS, enqueueJob, registerJobHandler, type EnqueueJobResult, type HandlerResult, type JobHandler } from "../asyncJobs";
import { assertJobOwnership, fencedTransaction } from "../jobFence";
import { logger } from "../logger";
import { lockFactRow, lockReview } from "../reviewLocks";
import { CastPreparationError, prepareDraftCast } from "./castPreparation";
import { clearPendingExamples } from "./examples";
import { normaliseGagContent, type GagContent } from "./resolver";
import { GagError, validateGagContent } from "./gagStore";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const GAG_PREFILL_QUEUE = "gag_prefill";

export interface GagPrefillPayload {
  reviewId: number;
  factId: number;
  /** The moderator whose action asked for it; recorded as the gag's author. Null for none. */
  adminId?: string | null;
}

/** Ask for the fact's gags to be filled from its ideas. Pass the caller's transaction, so it commits with it. */
export async function enqueueGagPrefill(args: GagPrefillPayload, executor?: Pick<typeof db, "insert">): Promise<EnqueueJobResult> {
  return enqueueJob({
    queue: GAG_PREFILL_QUEUE,
    payload: { reviewId: args.reviewId, factId: args.factId, adminId: args.adminId ?? null },
    dedupeKey: `${GAG_PREFILL_QUEUE}:${args.reviewId}:${randomUUID()}`,
  }, executor);
}

// ─── Untouched since pre-fill ─────────────────────────────────────────────────

type IdeaShape = Pick<GagPrefilledFrom, "scene" | "bubbles">;

function shapeKey(shape: IdeaShape): string {
  return stableStringify({
    scene: shape.scene.trim(),
    bubbles: shape.bubbles
      .filter((b) => b.text.trim())
      .map((b) => ({ type: b.type, entity: b.entity.trim(), text: b.text.trim() })),
  });
}

function contentShape(content: GagContent | null): IdeaShape | null {
  const scene = content?.coreSceneOverride?.trim() ?? "";
  if (!content || !scene) return null;
  return { scene, bubbles: (content.bubbles ?? []).map((b) => ({ type: b.type, entity: b.entity, text: b.text })) };
}

function ideaShape(idea: StoredCandidateConcept): IdeaShape {
  return { scene: idea.sceneDescription, bubbles: (idea.bubbles ?? []).map((b) => ({ type: b.type, entity: b.entity, text: b.text })) };
}

/**
 * Whether a gag is still exactly the idea it was pre-filled from: its draft
 * (pending content, else published) has the recorded scene and bubbles, and
 * the draft does not remove it.
 */
export function isUntouchedPrefill(gag: Pick<FactGag, "prefilledFrom" | "pendingContent" | "approvedContent" | "draftRemoved" | "removedAt">): boolean {
  if (!gag.prefilledFrom || gag.draftRemoved || gag.removedAt != null) return false;
  const shape = contentShape(normaliseGagContent(gag.pendingContent ?? gag.approvedContent));
  return shape != null && shapeKey(shape) === shapeKey(gag.prefilledFrom);
}

// ─── The decision ─────────────────────────────────────────────────────────────

/** One gag to write: create it in slot 1, or replace an untouched pre-filled gag. */
export interface PrefillTarget {
  slot: number;
  /** The gag to replace; null to create gag 1. */
  gagId: number | null;
  idea: StoredCandidateConcept;
  /** The gag's recorded idea when it was decided on (replacements only). */
  expectedFrom: GagPrefilledFrom | null;
}

/**
 * What the ideas call for, given the fact's non-removed gags (slot order) and
 * its current approved note:
 *   - no gag: gag 1 from the first usable idea;
 *   - otherwise, each untouched pre-filled gag whose idea was written under a
 *     different note than these ideas: the idea in its position, when usable
 *     and different. A note that did not change replaces nothing, so asking
 *     for fresh ideas with the same note never overwrites a gag.
 */
export function decidePrefill(gags: FactGag[], blob: VisualConceptCandidatesBlob): PrefillTarget[] {
  const ideas = blob.candidates;
  const live = gags.filter((g) => g.removedAt == null);
  if (live.length === 0) {
    const idea = ideas.find((c) => isCandidateConceptPickable(c));
    return idea ? [{ slot: 1, gagId: null, idea, expectedFrom: null }] : [];
  }
  const note = blob.humorNoteUsed?.trim() || null;
  const out: PrefillTarget[] = [];
  for (const g of live) {
    if (!isUntouchedPrefill(g)) continue;
    if ((g.prefilledFrom!.humorNote?.trim() || null) === note) continue;
    const idea = ideas[g.slot - 1];
    if (!idea || !isCandidateConceptPickable(idea)) continue;
    if (shapeKey(ideaShape(idea)) === shapeKey(g.prefilledFrom!)) continue;
    out.push({ slot: g.slot, gagId: g.id, idea, expectedFrom: g.prefilledFrom });
  }
  return out;
}

// ─── The job ──────────────────────────────────────────────────────────────────

/** Test seam: the cast reader (a model call). */
export interface GagPrefillDeps {
  readCast: typeof prepareDraftCast;
}

interface ReadState {
  stage: string;
  status: string;
  blob: VisualConceptCandidatesBlob | null;
  savedNote: string | null;
  conceptStatus: string | null;
}

async function readState(reviewId: number, factId: number, executor: Executor = db): Promise<ReadState | null> {
  const [review] = await executor.select({ stage: pendingReviewsTable.workflowStage, status: pendingReviewsTable.status, stagingFactId: pendingReviewsTable.stagingFactId })
    .from(pendingReviewsTable).where(eq(pendingReviewsTable.id, reviewId)).limit(1);
  if (!review || review.stagingFactId !== factId) return null;
  const [fact] = await executor.select({ candidates: factsTable.visualConceptCandidates, status: factsTable.visualConceptStatus, humorNote: factsTable.humorNote })
    .from(factsTable).where(eq(factsTable.id, factId)).limit(1);
  if (!fact) return null;
  const parsed = visualConceptCandidatesBlobSchema.safeParse(fact.candidates);
  return {
    stage: review.stage,
    status: review.status,
    blob: parsed.success ? parsed.data : null,
    savedNote: fact.humorNote?.trim() || null,
    conceptStatus: fact.status,
  };
}

/** The ideas worth acting on: stored, finished, this review's, and written under the note as it is now. */
function usableIdeas(state: ReadState, reviewId: number): VisualConceptCandidatesBlob | null {
  const { blob } = state;
  if (!blob || state.conceptStatus !== "ok" || blob.reviewId !== reviewId) return null;
  if ((blob.humorNoteUsed?.trim() || null) !== state.savedNote) return null;
  return blob;
}

async function nonRemovedGags(factId: number, executor: Executor = db, forUpdate = false): Promise<FactGag[]> {
  const q = executor.select().from(factGagsTable)
    .where(and(eq(factGagsTable.factId, factId), isNull(factGagsTable.removedAt)))
    .orderBy(asc(factGagsTable.slot));
  return forUpdate ? q.for("update") : q;
}

/**
 * Whether the fact's gags are about to be filled from its ideas: its review is
 * on the Gags step and the ideas it holds call for a write. The Gags screen
 * shows that work as it happens and polls until it lands (the async-status
 * rule, docs/ai-context/async-ui-status.md).
 */
export async function prefillExpected(factId: number, review: { id: number; workflowStage: string }, gags: FactGag[]): Promise<boolean> {
  // Cheap exits first: the view is polled, and most calls are off the Gags
  // step or on a fact whose gags were all written by hand.
  if (review.workflowStage !== "gags") return false;
  const live = gags.filter((g) => g.removedAt == null);
  if (live.length > 0 && !live.some((g) => g.prefilledFrom)) return false;
  const reviewId = review.id;
  const state = await readState(reviewId, factId);
  if (!state || !canApproveGags(state.stage as ReviewWorkflowStage, state.status)) return false;
  const blob = usableIdeas(state, reviewId);
  return blob != null && decidePrefill(live, blob).length > 0;
}

export async function runGagPrefill(payload: GagPrefillPayload, deps: GagPrefillDeps = { readCast: prepareDraftCast }): Promise<HandlerResult> {
  const { reviewId, factId } = payload;
  if (typeof reviewId !== "number" || typeof factId !== "number") {
    return { ok: false, error: "gag_prefill payload missing its review or fact" };
  }
  const state = await readState(reviewId, factId);
  if (!state || !canApproveGags(state.stage as ReviewWorkflowStage, state.status)) {
    logger.info({ reviewId, factId }, "[gag_prefill] no-op (the review is not on the Gags step)");
    return { ok: true };
  }
  const blob = usableIdeas(state, reviewId);
  if (!blob) {
    logger.info({ reviewId, factId }, "[gag_prefill] no-op (no current ideas; their arrival asks again)");
    return { ok: true };
  }
  const targets = decidePrefill(await nonRemovedGags(factId), blob);
  if (targets.length === 0) return { ok: true };

  // Read each idea's cast before the write: a model call per idea, at most
  // three, independent, so read together.
  const outcomes = await Promise.all(targets.map(async (target) => {
    const shape = ideaShape(target.idea);
    try {
      await assertJobOwnership(); // a paid call: only while this run owns its job
      const cast = await deps.readCast(factId, { scene: shape.scene, bubbles: shape.bubbles });
      const content = validateGagContent({ ...withCandidateConceptDraft(EMPTY_VISUAL_STRATEGY_OVERRIDE, target.idea), cast: cast.cast, castExtraction: cast.castExtraction });
      return { target, content };
    } catch (err) {
      if (err instanceof GagError) {
        // The idea cannot be a gag as it stands (a speaker the scene does not
        // show, say): left for the moderator, who sees the idea.
        logger.info({ reviewId, factId, slot: target.slot, code: err.code }, "[gag_prefill] idea not usable as a gag; skipped");
        return null;
      }
      return { error: err };
    }
  }));
  const failed = outcomes.find((o): o is { error: unknown } => o != null && "error" in o);
  if (failed) {
    if (failed.error instanceof CastPreparationError && failed.error.code === "FACT_NOT_FOUND") return { ok: true };
    return { ok: false, error: failed.error instanceof Error ? failed.error.message : String(failed.error) };
  }
  const prepared = outcomes.filter((o): o is { target: PrefillTarget; content: GagContent } => o != null && "content" in o);
  if (prepared.length === 0) return { ok: true };

  const written = await fencedTransaction(db, async (tx) => {
    // The lock rule (lib/reviewLocks.ts): the review, the fact, then its gags.
    const review = await lockReview(tx, reviewId);
    if (!review || !canApproveGags(review.workflowStage as ReviewWorkflowStage, review.status)) return 0;
    if (!(await lockFactRow(tx, factId))) return 0;
    const now = await readState(reviewId, factId, tx);
    const nowBlob = now ? usableIdeas(now, reviewId) : null;
    // Overtaken: other ideas, or another note, since this run decided.
    if (!nowBlob || nowBlob.generatedAt !== blob.generatedAt) return 0;
    const gags = await nonRemovedGags(factId, tx, true);
    let count = 0;
    for (const { target, content } of prepared) {
      const from: GagPrefilledFrom = { ...ideaShape(target.idea), humorNote: blob.humorNoteUsed?.trim() || null };
      if (target.gagId == null) {
        if (gags.length > 0) continue; // the moderator saved a gag first
        await tx.insert(factGagsTable).values({
          factId,
          slot: 1,
          pendingContent: content,
          pendingBy: payload.adminId ?? null,
          pendingAt: new Date(),
          createdBy: payload.adminId ?? null,
          prefilledFrom: from,
        });
        count++;
        continue;
      }
      const gag = gags.find((g) => g.id === target.gagId);
      // Edited by hand, removed or refilled since the decision: kept as it is.
      if (!gag || !isUntouchedPrefill(gag) || stableStringify(gag.prefilledFrom) !== stableStringify(target.expectedFrom)) continue;
      await clearPendingExamples(tx, [gag.id]);
      await tx.update(factGagsTable).set({
        pendingContent: content,
        pendingBy: payload.adminId ?? null,
        pendingAt: new Date(),
        prefilledFrom: from,
        updatedAt: new Date(),
      }).where(eq(factGagsTable.id, gag.id));
      count++;
    }
    return count;
  });
  logger.info({ reviewId, factId, written, decided: targets.length }, "[gag_prefill] gags filled from ideas");
  return { ok: true };
}

export const gagPrefillJobHandler: JobHandler = {
  async run(payload: unknown): Promise<HandlerResult> {
    return runGagPrefill((payload ?? {}) as GagPrefillPayload);
  },
};

export function registerGagPrefillJobHandler(): void {
  // Execution limit (Issue #1000): up to three cast reads (utility model) and one write, with margin.
  registerJobHandler(GAG_PREFILL_QUEUE, gagPrefillJobHandler, { executionLimitMs: 10 * 60_000, ...RESUMES_FROM_CHECKPOINTS });
}
