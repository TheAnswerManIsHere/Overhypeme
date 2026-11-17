/**
 * @purpose Every write to a gag: create, save a change, discard it, approve one of its test renders as its example, and remove it.
 * @subsystem visual-pipeline
 *
 * Plans docs/plans/PLAN_THREE_GAGS.md (sections C and D) and
 * docs/plans/PLAN_GAG_EXAMPLES.md (sections A and B). One lifecycle for every
 * gag, whatever its slot:
 *   - a saved change becomes the gag's pending change; it never alters the
 *     approved version users get, and it drops picks made for other content;
 *   - a gag's examples are one per subject kind (male, female, pet). Approving
 *     a finished, unstyled render of exactly the content being worked on
 *     records it as that kind's pick; the third pick applies the change: the
 *     content becomes the approved version and the picks its approved set
 *     (Q8). There is no waiver and no other way to approve.
 *
 * Every function locks the fact row first, then its gags: the order activation
 * and the live-fact trigger use, so they serialise and never
 * deadlock against each other.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  factsTable,
  factGagsTable,
  imagePromptAttemptsTable,
  type FactGag,
} from "@workspace/db";
import {
  MAX_GAGS_PER_FACT,
  joinWithAnd,
  kindForScenario,
  missingKinds,
  overrideValuesEqual,
  castIsCurrent,
  retiredArtDirectionFields,
  unboundSpeakers,
  type GagExampleKind,
  visualPromptStrategyOverrideSchema,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import { validateVisualStrategyOverridePersistence } from "../imagePrompt/promptBudget";
import { renderedGagProjection } from "../imagePrompt/directInput";
import { stableStringify } from "../factRenderScenarios";
import { openReviewForFact, type GagContent } from "./resolver";
import { CANONICAL_SUBJECT_NAME_FORMS_LC } from "../renderCanonical";
import { applyPendingSetIfComplete, clearPendingExamples, endGrandfatheringIfComplete, examplesFor, loadExamples, putExample } from "./examples";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type GagErrorCode =
  | "FACT_NOT_FOUND"
  | "GAG_NOT_FOUND"
  | "GAG_LIMIT"
  | "SLOT_TAKEN"
  | "CONTENT_INVALID"
  | "CONTENT_OVER_BUDGET"
  | "SCENE_REQUIRED"
  | "RETIRED_FIELD"
  | "REVIEW_NOT_EDITABLE"
  | "RENDER_NOT_APPROVABLE"
  | "CONTENT_CHANGED"
  | "LAST_APPROVED_GAG"
  | "NOTHING_PENDING"
  | "CAST_MISSING"
  | "CAST_STALE"
  | "CAST_INVALID"
  | "SPEAKER_NOT_IN_SCENE";

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

/**
 * Whether two gag contents are the same gag, as the schema reads them. A gag
 * the migration carried over is stored byte for byte in its legacy shape (no
 * defaulted lists, a retired `enabled` key), while a render's snapshot holds the
 * schema-normalised render input, so a raw comparison calls an unchanged gag
 * changed (Codex, PR #956 round 2). Content the schema refuses is never equal.
 * `overrideValuesEqual` itself stays raw: the enrichment audit shares it.
 */
export function gagContentEqual(a: unknown, b: unknown): boolean {
  const pa = visualPromptStrategyOverrideSchema.safeParse(a);
  const pb = visualPromptStrategyOverrideSchema.safeParse(b);
  return pa.success && pb.success && overrideValuesEqual(pa.data, pb.data);
}

/**
 * Whether a render of `drew` shows the gag `target` holds now: the same
 * comparison render freshness, reuse and the tile make
 * (`renderedGagProjection`): the scene, the complete bubbles and the cast
 * entries, which is everything of a gag a direct prompt reads (plan
 * PLAN_GAG_DIRECT_RENDER.md, D). The cast's extraction marker is left out, so
 * a cast read again with the same entries at a new time never makes an
 * unchanged picture unapprovable (Codex 4600565971; Fable's tie-break, PR
 * #1002 round 1); a cast whose entries changed is a different picture.
 */
export function sameRenderedGag(drew: unknown, target: unknown): boolean {
  const pa = visualPromptStrategyOverrideSchema.safeParse(drew);
  const pb = visualPromptStrategyOverrideSchema.safeParse(target);
  return pa.success && pb.success
    && stableStringify(renderedGagProjection(pa.data)) === stableStringify(renderedGagProjection(pb.data));
}

/**
 * The cast a save carries (PLAN_GAG_DIRECT_RENDER.md, C and F): read by cast
 * extraction from this content's own scene and speakers, before the save, and
 * binding every bubble speaker. The server does not extract here; it checks
 * that what it is given was extracted for this content, which catches a scene
 * edited after its cast was read.
 */
export function assertGagCast(content: VisualPromptStrategyOverride): void {
  if (!content.castExtraction || !content.cast) {
    throw new GagError("CAST_MISSING", "Read who is in the scene before saving: the gag has no cast.", 400);
  }
  if (!castIsCurrent(content)) {
    throw new GagError("CAST_STALE", "The scene or a bubble's speaker changed after its cast was read. Read the scene again before saving.", 400);
  }
  const seen = new Set<string>();
  for (const entry of content.cast) {
    const key = entry.label.trim().toLowerCase();
    if (!key || entry.label.includes("{") || key === "subject" || CANONICAL_SUBJECT_NAME_FORMS_LC.has(key) || seen.has(key) || !entry.description.trim()) {
      throw new GagError("CAST_INVALID", `The cast entry "${entry.label}" is not a usable character label.`, 400);
    }
    seen.add(key);
  }
  const missing = unboundSpeakers(content.bubbles, content.cast);
  if (missing.length) {
    throw new GagError(
      "SPEAKER_NOT_IN_SCENE",
      `The scene does not show ${missing.map((m) => `"${m}"`).join(", ")}, who speaks in a bubble. Pick another speaker or say in the scene that they are there.`,
      400,
      { speakers: missing },
    );
  }
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
  // The eleven "More art direction" fields left the accepted input at the
  // switch (plan PLAN_GAG_DIRECT_RENDER.md, D; Q1: 1): nothing reads them, so
  // a value sent in one is refused rather than stored unseen.
  const retired = retiredArtDirectionFields(content);
  if (retired.length) {
    throw new GagError(
      "RETIRED_FIELD",
      `These fields are no longer part of a gag; write what they said into the scene: ${retired.join(", ")}.`,
      400,
      { fields: retired },
    );
  }
  assertGagCast(content);
  const budget = validateVisualStrategyOverridePersistence(content);
  if (!budget.ok) {
    throw new GagError("CONTENT_OVER_BUDGET", "This gag is too long for the image prompt.", 400, budget.errors);
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
 * Where an action on this fact's gags may come from right now. An open review
 * accepts actions from its own screen only, at the gags step onward; a fact
 * with no open review is worked on from the Facts editor.
 */
async function resolveScope(tx: Tx, factId: number, actor: GagActor): Promise<void> {
  const open = await openReviewForFact(factId, tx);
  if (open) {
    if (actor.reviewId != null && actor.reviewId !== open.id) {
      throw new GagError("REVIEW_NOT_EDITABLE", "That review is not this fact's open review.");
    }
    if (actor.reviewId === open.id && !GAG_EDITABLE_STAGES.has(open.workflowStage)) {
      throw new GagError("REVIEW_NOT_EDITABLE", "Gags can be worked on from the gags step onward.");
    }
    if (actor.reviewId == null) {
      // A submission in moderation: worked on from its review screen.
      throw new GagError("REVIEW_NOT_EDITABLE", "This fact is in moderation. Its gags are edited in its review.", 409, { reviewId: open.id });
    }
  } else if (actor.reviewId != null) {
    throw new GagError("REVIEW_NOT_EDITABLE", "That review is no longer open.");
  }
}

/**
 * Whether test renders of this gag may be drawn now, from where the actor is:
 * a fact in moderation, from its review's Gags or Test Renders step; a live
 * fact with no review open, from the Facts editor. Renders spend, so they run
 * only on a moderator's action (plan PLAN_GAG_EXAMPLES.md, section C).
 */
export async function assertCanRunGagRenders(factId: number, gagId: number, actor: GagActor): Promise<void> {
  await db.transaction(async (tx) => {
    await lockFact(tx, factId);
    await resolveScope(tx, factId, actor);
    await lockGag(tx, factId, gagId);
  });
}

/** Add a gag as a pending change, in the given slot or the lowest free one. */
export async function createGag(factId: number, rawContent: unknown, actor: GagActor, slot?: number): Promise<FactGag> {
  const content = validateGagContent(rawContent);
  return db.transaction(async (tx) => {
    await lockFact(tx, factId);
    await resolveScope(tx, factId, actor);
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
    await resolveScope(tx, factId, actor);
    const gag = await lockGag(tx, factId, gagId);
    // Saving what is already pending changes nothing (no spurious timestamp bump).
    if (gag.pendingContent != null && gagContentEqual(gag.pendingContent, content)) return gag;
    const sameAsApproved = gag.approvedContent != null && gagContentEqual(gag.approvedContent, content);
    // Picks were made for the content being replaced: they no longer show the gag.
    await clearPendingExamples(tx, [gagId]);
    const [updated] = await tx.update(factGagsTable).set(sameAsApproved
      ? { pendingContent: null, pendingBy: null, pendingAt: null, updatedAt: new Date() }
      : { pendingContent: content, pendingBy: actor.adminId, pendingAt: new Date(), updatedAt: new Date() },
    ).where(eq(factGagsTable.id, gagId)).returning();
    if (!updated!.approvedContent && !updated!.pendingContent) {
      throw new GagError("SCENE_REQUIRED", "A gag needs content.", 400);
    }
    return updated!;
  });
}

/**
 * Drop a gag's pending change (and its picked example); the approved version
 * is untouched. A gag with nothing approved is removed instead.
 */
export async function discardGagChange(factId: number, gagId: number, actor: GagActor): Promise<FactGag> {
  return db.transaction(async (tx) => {
    await lockFact(tx, factId);
    await resolveScope(tx, factId, actor);
    const gag = await lockGag(tx, factId, gagId);
    if (gag.pendingContent == null) throw new GagError("NOTHING_PENDING", "This gag has no pending change.");
    await clearPendingExamples(tx, [gagId]);
    const now = new Date();
    const [updated] = await tx.update(factGagsTable).set(gag.approvedContent == null
      ? { removedAt: now, removedBy: actor.adminId, updatedAt: now }
      : { pendingContent: null, pendingBy: null, pendingAt: null, updatedAt: now },
    ).where(eq(factGagsTable.id, gagId)).returning();
    return updated!;
  });
}

/**
 * Approve one of a gag's test renders as its example for the subject kind the
 * render drew (male, female or pet). Accepted only for a finished, unstyled
 * render of THIS gag, of one of those kinds, whose frozen snapshot holds
 * exactly the content being worked on (the pending change if there is one,
 * else the approved version).
 *
 * - A pending change: the pick is recorded, and the third pick applies the
 *   change (the content becomes approved, the picks its set).
 * - No pending change: the content is already approved, so the pick replaces
 *   that kind's approved example; a grandfathered gag whose set this completes
 *   stops being grandfathered.
 */
export async function approveGagRender(factId: number, gagId: number, attemptId: number, actor: GagActor): Promise<FactGag> {
  return db.transaction(async (tx) => {
    await lockFact(tx, factId);
    await resolveScope(tx, factId, actor);
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
    const kind = kindForScenario(attempt.reviewRenderScenarioKey);
    if (!kind) {
      throw new GagError("RENDER_NOT_APPROVABLE", "A gag's examples are its male, female and pet renders.");
    }
    const target = (gag.pendingContent ?? gag.approvedContent) as GagContent | null;
    const drew = (attempt.factEnrichmentSnapshot as { visualPromptStrategyOverride?: unknown } | null)?.visualPromptStrategyOverride;
    if (!target || drew == null || !sameRenderedGag(drew, target)) {
      throw new GagError("CONTENT_CHANGED", "This render was made from different content than the gag holds now. Run its test renders again.");
    }
    const now = new Date();
    if (gag.pendingContent == null) {
      // The approved version itself: the pick is its example for this kind.
      await putExample(tx, gagId, kind, "approved", attemptId, actor.adminId);
      return endGrandfatheringIfComplete(tx, gag);
    }
    await putExample(tx, gagId, kind, "pending", attemptId, actor.adminId);
    const [touched] = await tx.update(factGagsTable).set({ pendingBy: actor.adminId, pendingAt: now, updatedAt: now })
      .where(eq(factGagsTable.id, gagId)).returning();
    return (await applyPendingSetIfComplete(tx, touched!, actor.adminId)) ?? touched!;
  });
}

/**
 * Remove a gag. Refused for the last approved gag of a live fact (the database
 * refuses it too).
 */
export async function removeGag(factId: number, gagId: number, actor: GagActor): Promise<FactGag> {
  return db.transaction(async (tx) => {
    const fact = await lockFact(tx, factId);
    await resolveScope(tx, factId, actor);
    const gag = await lockGag(tx, factId, gagId);
    const now = new Date();
    if (fact.isActive && gag.approvedContent != null) {
      const others = await tx.select({ id: factGagsTable.id }).from(factGagsTable).where(and(
        eq(factGagsTable.factId, factId), isNull(factGagsTable.removedAt), sql`${factGagsTable.id} <> ${gagId}`,
        sql`${factGagsTable.approvedContent} IS NOT NULL`,
      ));
      if (others.length === 0) throw new GagError("LAST_APPROVED_GAG", "A live fact keeps at least one approved gag.");
    }
    const [updated] = await tx.update(factGagsTable).set({
      removedAt: now, removedBy: actor.adminId, updatedAt: now,
    }).where(eq(factGagsTable.id, gagId)).returning();
    return updated!;
  });
}

/** A gag that would not be offered after approval, and the kinds its set still lacks. */
export interface ExampleSetGap {
  slot: number;
  missing: GagExampleKind[];
}

/**
 * The gags that will not be offered after this approval, with the kinds each
 * still needs (plan PLAN_GAG_EXAMPLES.md, section D): every surviving gag with
 * no approved version.
 * The production gate names these when no gag would be offered.
 */
export async function exampleSetGaps(factId: number, executor: typeof db | Tx = db): Promise<ExampleSetGap[]> {
  const gags = await executor.select().from(factGagsTable)
    .where(and(eq(factGagsTable.factId, factId), isNull(factGagsTable.removedAt)))
    .orderBy(asc(factGagsTable.slot));
  const examples = await loadExamples(gags.map((g) => g.id), executor);
  const gaps: ExampleSetGap[] = [];
  for (const g of gags) {
    if (g.approvedContent != null) continue;
    const set = examplesFor(examples, g.id).pending;
    const missing = missingKinds(set);
    if (missing.length) gaps.push({ slot: g.slot, missing });
  }
  return gaps;
}

/** The gaps in words, for a refused approval: "Gag 1 needs female and pet examples." */
export function describeExampleSetGaps(gaps: ExampleSetGap[]): string {
  if (gaps.length === 0) return "Approve each gag's male, female and pet examples before approving for production.";
  return gaps.map((g) => `Gag ${g.slot} needs ${joinWithAnd(g.missing)} example${g.missing.length > 1 ? "s" : ""}.`).join(" ");
}
