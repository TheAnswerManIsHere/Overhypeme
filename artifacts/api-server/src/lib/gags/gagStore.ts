/**
 * @purpose Every write to a gag: create, save a change, discard it, approve one of its test renders as its example, remove it, and the refresh review's own operations applied at promotion or cancelled at decline.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_THREE_GAGS.md, sections C and D. One lifecycle for every
 * gag, whatever its slot:
 *   - a saved change becomes the gag's pending change; it never alters the
 *     approved version users get;
 *   - approving a finished, unstyled test render of exactly that content makes
 *     it the example and the content the approved version, in one
 *     compare-and-set; there is no waiver and no other way to approve;
 *   - inside a refresh review, example picks and removals belong to that review
 *     and apply only when it is promoted, atomically with its classification;
 *     a decline keeps draft content and cancels the review's picks and removals.
 *
 * Every function locks the fact row first, then its gags: the order activation,
 * refresh promotion and the live-fact trigger use, so they serialise and never
 * deadlock against each other.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  factsTable,
  factGagsTable,
  imagePromptAttemptsTable,
  pendingReviewsTable,
  type FactGag,
} from "@workspace/db";
import {
  MAX_GAGS_PER_FACT,
  overrideValuesEqual,
  visualPromptStrategyOverrideSchema,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import { validateVisualStrategyOverridePersistence } from "../imagePrompt/promptBudget";
import { findInFlightRefreshCandidate } from "../enrichmentVersioning";
import type { GagContent } from "./resolver";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type GagErrorCode =
  | "FACT_NOT_FOUND"
  | "GAG_NOT_FOUND"
  | "GAG_LIMIT"
  | "SLOT_TAKEN"
  | "CONTENT_INVALID"
  | "CONTENT_OVER_BUDGET"
  | "SCENE_REQUIRED"
  | "REFRESH_IN_REVIEW"
  | "REVIEW_NOT_EDITABLE"
  | "RENDER_NOT_APPROVABLE"
  | "CONTENT_CHANGED"
  | "LAST_APPROVED_GAG"
  | "NOTHING_PENDING";

export class GagError extends Error {
  constructor(public readonly code: GagErrorCode, message: string, public readonly status = 409, public readonly details?: unknown) {
    super(message);
    this.name = "GagError";
  }
}

/** Stages of a review in which its gags may be worked on: the gags step and Test Renders. */
const GAG_EDITABLE_STAGES = new Set(["concept_review", "production_review"]);

/**
 * Who is acting, and from where. `reviewId` names the review screen the action
 * came from; a live fact's Facts editor sends none.
 */
export interface GagActor {
  adminId: string;
  reviewId?: number | null;
}

/** Validate and canonicalize a gag's content: the visual-strategy override schema, a non-empty scene, the prompt budget. */
export function validateGagContent(raw: unknown): GagContent {
  const parsed = visualPromptStrategyOverrideSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GagError("CONTENT_INVALID", parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "), 400);
  }
  const content = parsed.data as VisualPromptStrategyOverride;
  if (!content.coreSceneOverride?.trim()) {
    throw new GagError("SCENE_REQUIRED", "A gag needs a scene: describe the picture.", 400);
  }
  const budget = validateVisualStrategyOverridePersistence(content);
  if (!budget.ok) {
    throw new GagError("CONTENT_OVER_BUDGET", "This gag is too long for the image prompt.", 400, budget);
  }
  return content;
}

async function lockFact(tx: Tx, factId: number) {
  const [fact] = await tx
    .select({ id: factsTable.id, isActive: factsTable.isActive })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .for("update")
    .limit(1);
  if (!fact) throw new GagError("FACT_NOT_FOUND", `Fact ${factId} not found.`, 404);
  return fact;
}

async function lockGag(tx: Tx, factId: number, gagId: number): Promise<FactGag> {
  const [gag] = await tx
    .select()
    .from(factGagsTable)
    .where(and(eq(factGagsTable.id, gagId), eq(factGagsTable.factId, factId), isNull(factGagsTable.removedAt)))
    .for("update")
    .limit(1);
  if (!gag) throw new GagError("GAG_NOT_FOUND", `Gag ${gagId} not found on fact ${factId}.`, 404);
  return gag;
}

/**
 * Where an action on this fact's gags may come from right now, and which review
 * owns what it does. An open refresh freezes the gags outside its own review
 * (decision 10); inside it, actions belong to that review. Any other open
 * review accepts actions from its own screen only at the gags step onward.
 */
async function resolveScope(tx: Tx, factId: number, actor: GagActor): Promise<{ refreshReviewId: number | null }> {
  const refresh = await findInFlightRefreshCandidate(factId, tx);
  const [open] = await tx
    .select({ id: pendingReviewsTable.id, stage: pendingReviewsTable.workflowStage, candidateVersionId: pendingReviewsTable.candidateVersionId })
    .from(pendingReviewsTable)
    .where(and(eq(pendingReviewsTable.stagingFactId, factId), eq(pendingReviewsTable.status, "pending")))
    .orderBy(sql`${pendingReviewsTable.id} DESC`)
    .limit(1);
  if (refresh) {
    if (actor.reviewId == null || actor.reviewId !== refresh.reviewId) {
      throw new GagError("REFRESH_IN_REVIEW", "This fact is being refreshed. Its gags are edited in the refresh's review.", 409, { reviewId: refresh.reviewId });
    }
  }
  if (open) {
    if (actor.reviewId != null && actor.reviewId !== open.id) {
      throw new GagError("REVIEW_NOT_EDITABLE", "That review is not this fact's open review.");
    }
    if (actor.reviewId === open.id && !GAG_EDITABLE_STAGES.has(open.stage)) {
      throw new GagError("REVIEW_NOT_EDITABLE", "Gags can be worked on from the gags step onward.");
    }
    if (actor.reviewId == null && open.candidateVersionId == null) {
      // A first-time submission in moderation: worked on from its review screen.
      throw new GagError("REVIEW_NOT_EDITABLE", "This fact is in moderation. Its gags are edited in its review.", 409, { reviewId: open.id });
    }
  } else if (actor.reviewId != null) {
    throw new GagError("REVIEW_NOT_EDITABLE", "That review is no longer open.");
  }
  return { refreshReviewId: refresh ? refresh.reviewId : null };
}

/**
 * Whether test renders of this gag may be run now, from where the actor is:
 * a fact in moderation renders from its review's Test Renders step; a live
 * fact with no review open renders from the Facts editor. Renders spend, so
 * they run only on a moderator's explicit action.
 */
export async function assertCanRunGagRenders(factId: number, gagId: number, actor: GagActor): Promise<void> {
  await db.transaction(async (tx) => {
    await lockFact(tx, factId);
    await resolveScope(tx, factId, actor);
    await lockGag(tx, factId, gagId);
    if (actor.reviewId != null) {
      const [r] = await tx.select({ stage: pendingReviewsTable.workflowStage }).from(pendingReviewsTable)
        .where(eq(pendingReviewsTable.id, actor.reviewId)).limit(1);
      if (r?.stage !== "production_review") {
        throw new GagError("REVIEW_NOT_EDITABLE", "Test renders run at the Test Renders step.");
      }
    }
  });
}

/** Add a gag as a pending change, in the given slot or the lowest free one. */
export async function createGag(factId: number, rawContent: unknown, actor: GagActor, slot?: number): Promise<FactGag> {
  const content = validateGagContent(rawContent);
  return db.transaction(async (tx) => {
    await lockFact(tx, factId);
    const { refreshReviewId } = await resolveScope(tx, factId, actor);
    const live = await tx.select({ slot: factGagsTable.slot }).from(factGagsTable)
      .where(and(eq(factGagsTable.factId, factId), isNull(factGagsTable.removedAt)));
    if (live.length >= MAX_GAGS_PER_FACT) throw new GagError("GAG_LIMIT", `A fact has at most ${MAX_GAGS_PER_FACT} gags.`);
    const taken = new Set(live.map((g) => g.slot));
    const chosen = slot ?? [1, 2, 3].find((s) => !taken.has(s))!;
    if (chosen < 1 || chosen > MAX_GAGS_PER_FACT) throw new GagError("SLOT_TAKEN", "A gag's slot is 1, 2 or 3.", 400);
    if (taken.has(chosen)) throw new GagError("SLOT_TAKEN", `Slot ${chosen} already has a gag.`);
    const [gag] = await tx.insert(factGagsTable).values({
      factId,
      slot: chosen,
      pendingContent: content,
      pendingReviewId: refreshReviewId,
      pendingBy: actor.adminId,
      pendingAt: new Date(),
      createdBy: actor.adminId,
    }).returning();
    return gag!;
  });
}

/**
 * Save content to a gag as its pending change. Replaces any earlier pending
 * change and cancels a pick made for the content it replaces. Content equal to
 * the approved version clears the pending change instead.
 */
export async function saveGagContent(factId: number, gagId: number, rawContent: unknown, actor: GagActor): Promise<FactGag> {
  const content = validateGagContent(rawContent);
  return db.transaction(async (tx) => {
    await lockFact(tx, factId);
    const { refreshReviewId } = await resolveScope(tx, factId, actor);
    const gag = await lockGag(tx, factId, gagId);
    const sameAsApproved = gag.approvedContent != null && overrideValuesEqual(gag.approvedContent, content);
    const [updated] = await tx.update(factGagsTable).set(sameAsApproved
      ? { pendingContent: null, pendingExampleAttemptId: null, pendingReviewId: gag.pendingRemove ? gag.pendingReviewId : null, pendingBy: null, pendingAt: null, updatedAt: new Date() }
      : { pendingContent: content, pendingExampleAttemptId: null, pendingReviewId: refreshReviewId ?? (gag.pendingRemove ? gag.pendingReviewId : null), pendingBy: actor.adminId, pendingAt: new Date(), updatedAt: new Date() },
    ).where(eq(factGagsTable.id, gagId)).returning();
    if (!updated!.approvedContent && !updated!.pendingContent) {
      throw new GagError("SCENE_REQUIRED", "A gag needs content.", 400);
    }
    return updated!;
  });
}

/** Drop a gag's pending change; the approved version is untouched. A gag with nothing approved is removed instead. */
export async function discardGagChange(factId: number, gagId: number, actor: GagActor): Promise<FactGag> {
  return db.transaction(async (tx) => {
    await lockFact(tx, factId);
    await resolveScope(tx, factId, actor);
    const gag = await lockGag(tx, factId, gagId);
    if (gag.pendingContent == null && !gag.pendingRemove) throw new GagError("NOTHING_PENDING", "This gag has no pending change.");
    const [updated] = await tx.update(factGagsTable).set(gag.approvedContent == null
      ? { removedAt: new Date(), removedBy: actor.adminId, pendingExampleAttemptId: null, pendingRemove: false, updatedAt: new Date() }
      : { pendingContent: null, pendingExampleAttemptId: null, pendingRemove: false, pendingReviewId: null, pendingBy: null, pendingAt: null, updatedAt: new Date() },
    ).where(eq(factGagsTable.id, gagId)).returning();
    return updated!;
  });
}

/**
 * Approve one of a gag's test renders: that render becomes the example and the
 * content it drew becomes the approved version. Accepted only for a finished,
 * unstyled render of THIS gag whose frozen snapshot holds exactly the content
 * being approved (the pending change if there is one, else the approved
 * version, re-approved with a new example). Inside a refresh the pick waits for
 * promotion; elsewhere it takes effect at once.
 */
export async function approveGagRender(factId: number, gagId: number, attemptId: number, actor: GagActor): Promise<FactGag> {
  return db.transaction(async (tx) => {
    await lockFact(tx, factId);
    const { refreshReviewId } = await resolveScope(tx, factId, actor);
    const gag = await lockGag(tx, factId, gagId);
    const [attempt] = await tx.select().from(imagePromptAttemptsTable)
      .where(and(eq(imagePromptAttemptsTable.id, attemptId), eq(imagePromptAttemptsTable.gagId, gagId)))
      .limit(1);
    if (!attempt) throw new GagError("RENDER_NOT_APPROVABLE", "That render is not one of this gag's.", 404);
    if (attempt.error || !attempt.generatedImageObjectPath) {
      throw new GagError("RENDER_NOT_APPROVABLE", "Only a finished render can be approved.");
    }
    const controls = attempt.renderControls as { styleId?: string | null; lookStyleId?: string | null } | null;
    if (controls?.styleId || controls?.lookStyleId) {
      throw new GagError("RENDER_NOT_APPROVABLE", "A gag's example is an unstyled render.");
    }
    const target = (gag.pendingContent ?? gag.approvedContent) as GagContent | null;
    const drew = (attempt.factEnrichmentSnapshot as { visualPromptStrategyOverride?: unknown } | null)?.visualPromptStrategyOverride;
    if (!target || drew == null || !overrideValuesEqual(drew, target)) {
      throw new GagError("CONTENT_CHANGED", "This render was made from different content than the gag holds now. Run its test renders again.");
    }
    const now = new Date();
    if (refreshReviewId != null) {
      // Inside a refresh: the pick belongs to the review and lands at promotion.
      const [updated] = await tx.update(factGagsTable).set({
        pendingContent: target,
        pendingExampleAttemptId: attemptId,
        pendingReviewId: refreshReviewId,
        pendingBy: actor.adminId,
        pendingAt: now,
        updatedAt: now,
      }).where(eq(factGagsTable.id, gagId)).returning();
      return updated!;
    }
    const [updated] = await tx.update(factGagsTable).set({
      approvedContent: target,
      approvedExampleAttemptId: attemptId,
      approvedCarriedOver: false,
      approvedBy: actor.adminId,
      approvedAt: now,
      pendingContent: null,
      pendingExampleAttemptId: null,
      pendingRemove: false,
      pendingReviewId: null,
      pendingBy: null,
      pendingAt: null,
      updatedAt: now,
    }).where(eq(factGagsTable.id, gagId)).returning();
    return updated!;
  });
}

/**
 * Remove a gag. Refused for the last approved gag of a live fact (the database
 * refuses it too). Inside a refresh the removal waits for promotion.
 */
export async function removeGag(factId: number, gagId: number, actor: GagActor): Promise<FactGag> {
  return db.transaction(async (tx) => {
    const fact = await lockFact(tx, factId);
    const { refreshReviewId } = await resolveScope(tx, factId, actor);
    const gag = await lockGag(tx, factId, gagId);
    const now = new Date();
    if (refreshReviewId != null) {
      const others = await tx.select({ id: factGagsTable.id }).from(factGagsTable).where(and(
        eq(factGagsTable.factId, factId), isNull(factGagsTable.removedAt), sql`${factGagsTable.id} <> ${gagId}`,
        sql`(${factGagsTable.approvedContent} IS NOT NULL OR ${factGagsTable.pendingExampleAttemptId} IS NOT NULL)`,
        sql`NOT ${factGagsTable.pendingRemove}`,
      ));
      if (others.length === 0) throw new GagError("LAST_APPROVED_GAG", "A live fact keeps at least one approved gag.");
      const [updated] = await tx.update(factGagsTable).set({
        pendingRemove: true, pendingReviewId: refreshReviewId, pendingBy: actor.adminId, pendingAt: now, updatedAt: now,
      }).where(eq(factGagsTable.id, gagId)).returning();
      return updated!;
    }
    if (fact.isActive && gag.approvedContent != null) {
      const others = await tx.select({ id: factGagsTable.id }).from(factGagsTable).where(and(
        eq(factGagsTable.factId, factId), isNull(factGagsTable.removedAt), sql`${factGagsTable.id} <> ${gagId}`,
        sql`${factGagsTable.approvedContent} IS NOT NULL`,
      ));
      if (others.length === 0) throw new GagError("LAST_APPROVED_GAG", "A live fact keeps at least one approved gag.");
    }
    const [updated] = await tx.update(factGagsTable).set({
      removedAt: now, removedBy: actor.adminId, pendingExampleAttemptId: null, pendingRemove: false, updatedAt: now,
    }).where(eq(factGagsTable.id, gagId)).returning();
    return updated!;
  });
}

/**
 * Apply a refresh review's gag operations: its example picks become approved
 * versions and its removals take effect. Runs inside the promotion transaction,
 * after the fact row is locked, so they land atomically with the classification.
 * Pending content the review saved without a pick stays pending, no longer owned.
 */
export async function applyReviewGagOps(tx: Tx, factId: number, reviewId: number, adminId: string): Promise<{ approved: number; removed: number }> {
  const gags = await tx.select().from(factGagsTable)
    .where(and(eq(factGagsTable.factId, factId), isNull(factGagsTable.removedAt), eq(factGagsTable.pendingReviewId, reviewId)))
    .orderBy(asc(factGagsTable.slot))
    .for("update");
  const now = new Date();
  let approved = 0;
  let removed = 0;
  for (const g of gags) {
    if (g.pendingRemove) {
      await tx.update(factGagsTable).set({
        removedAt: now, removedBy: g.pendingBy ?? adminId, pendingRemove: false, pendingExampleAttemptId: null, pendingReviewId: null, updatedAt: now,
      }).where(eq(factGagsTable.id, g.id));
      removed++;
    } else if (g.pendingExampleAttemptId != null && g.pendingContent != null) {
      await tx.update(factGagsTable).set({
        approvedContent: g.pendingContent,
        approvedExampleAttemptId: g.pendingExampleAttemptId,
        approvedCarriedOver: false,
        approvedBy: g.pendingBy ?? adminId,
        approvedAt: now,
        pendingContent: null, pendingExampleAttemptId: null, pendingReviewId: null, pendingBy: null, pendingAt: null,
        updatedAt: now,
      }).where(eq(factGagsTable.id, g.id));
      approved++;
    } else {
      await tx.update(factGagsTable).set({ pendingReviewId: null, updatedAt: now }).where(eq(factGagsTable.id, g.id));
    }
  }
  return { approved, removed };
}

/**
 * Cancel a declined refresh review's picks and removals. Draft content it saved
 * is kept, no longer owned, so a later review cannot apply this one's decisions.
 */
export async function cancelReviewGagOps(tx: Tx, reviewId: number): Promise<number> {
  const rows = await tx.update(factGagsTable).set({
    pendingExampleAttemptId: null, pendingRemove: false, pendingReviewId: null, updatedAt: new Date(),
  }).where(and(eq(factGagsTable.pendingReviewId, reviewId), isNull(factGagsTable.removedAt))).returning({ id: factGagsTable.id });
  return rows.length;
}

/**
 * Whether a fact will still have an approved gag once this refresh review is
 * promoted: counting the review's own picks, leaving out its removals.
 */
export async function refreshLeavesApprovedGag(factId: number, reviewId: number, executor: typeof db | Tx = db): Promise<boolean> {
  const [row] = await executor.select({ id: factGagsTable.id }).from(factGagsTable).where(and(
    eq(factGagsTable.factId, factId),
    isNull(factGagsTable.removedAt),
    sql`NOT (${factGagsTable.pendingRemove} AND ${factGagsTable.pendingReviewId} = ${reviewId})`,
    sql`(${factGagsTable.approvedContent} IS NOT NULL OR (${factGagsTable.pendingExampleAttemptId} IS NOT NULL AND ${factGagsTable.pendingReviewId} = ${reviewId}))`,
  )).limit(1);
  return !!row;
}
