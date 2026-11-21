/**
 * @purpose Every write to a gag, all of it to the fact's draft set: create, save a change, discard it, approve one of its test renders as its example, and remove it.
 * @subsystem visual-pipeline
 *
 * Plans docs/plans/PLAN_THREE_GAGS.md (sections C and D),
 * docs/plans/PLAN_GAG_EXAMPLES.md (sections A and B) and
 * docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md (1F). Every write here changes the
 * fact's DRAFT set only (lib/db/src/schema/factGags.ts); nothing a member is
 * offered changes until the draft is published (./publish.ts):
 *   - a saved change becomes the gag's pending content and drops picks made
 *     for other content;
 *   - a gag's examples are one per subject kind (male, female, pet). Approving
 *     a finished, unstyled render of exactly the content being worked on
 *     records it as that kind's draft pick, and never publishes anything;
 *   - removing a gag removes it from the draft; a published gag stays
 *     offered until the draft is published.
 * A gag has no approved or hidden state of its own: whether a fact may go
 * live is one rule over its whole set (./goLive.ts).
 *
 * Every function locks the fact row first, then its gags, and a fact in
 * moderation has its review locked before the fact: the one lock rule every
 * moderation transition, activation and the live-fact trigger follow
 * (lib/reviewLocks.ts), so they serialise and never deadlock.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  factGagsTable,
  imagePromptAttemptsTable,
  type FactGag,
} from "@workspace/db";
import {
  MAX_GAGS_PER_FACT,
  kindForScenario,
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
import { lockFactRow, lockReview } from "../reviewLocks";
import { clearPendingExamples, copyPublishedExamplesToDraft, putExample } from "./examples";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type GagErrorCode =
  | "FACT_NOT_FOUND"
  | "GAG_NOT_FOUND"
  | "GAGS_STEP"
  | "GAG_LIMIT"
  | "SLOT_TAKEN"
  | "CONTENT_INVALID"
  | "CONTENT_OVER_BUDGET"
  | "SCENE_REQUIRED"
  | "RETIRED_FIELD"
  | "REVIEW_NOT_EDITABLE"
  | "RENDER_NOT_APPROVABLE"
  | "CONTENT_CHANGED"
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
const GAG_EDITABLE_STAGES = new Set(["gags", "test_renders"]);

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
 */
export function gagContentEqual(a: unknown, b: unknown): boolean {
  const pa = visualPromptStrategyOverrideSchema.safeParse(a);
  const pb = visualPromptStrategyOverrideSchema.safeParse(b);
  return pa.success && pb.success && canonicalJson(pa.data) === canonicalJson(pb.data);
}

/**
 * Deterministic JSON for comparing two parsed gags: object keys sorted, a key
 * whose value is `undefined` left out (so an absent optional field and one
 * parsed as `undefined` compare equal), array order kept. It moved here from
 * the override module when that module was deleted (Issue #1018, 2.1c), with
 * its behaviour unchanged; `stableStringify` differs on `undefined` keys.
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
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

/** The gag a render drew: the gag content frozen in its attempt's snapshot. */
export function drewGagOf(snapshot: unknown): unknown {
  return (snapshot as { visualPromptStrategyOverride?: unknown } | null)?.visualPromptStrategyOverride;
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

/**
 * Lock the fact row, under the lock rule (lib/reviewLocks.ts): a fact in
 * moderation has its open review's row locked first, so a gag action and a
 * moderation transition on the same submission serialise on the review.
 */
async function lockFact(tx: Tx, factId: number) {
  const open = await openReviewForFact(factId, tx);
  if (open) await lockReview(tx, open.id);
  const fact = await lockFactRow(tx, factId);
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
async function resolveScope(tx: Tx, factId: number, actor: GagActor): Promise<{ workflowStage: string } | null> {
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
  return open;
}

/**
 * Whether test renders of this gag may be drawn now, from where the actor is:
 * a fact in moderation, from its review's Test Renders step; a live fact with
 * no review open, from the Facts editor. Renders spend, so they run only on a
 * moderator's action (plan PLAN_GAG_EXAMPLES.md, section C), and never while
 * the review is on its Gags step, which shows none: the male render starts on
 * arrival at Test Renders (plan PLAN_FACT_LIFECYCLE_REBUILD.md, 1E).
 */
export async function assertCanRunGagRenders(factId: number, gagId: number, actor: GagActor): Promise<void> {
  await db.transaction(async (tx) => {
    await lockFact(tx, factId);
    const open = await resolveScope(tx, factId, actor);
    if (open?.workflowStage === "gags") {
      throw new GagError("GAGS_STEP", "Renders are drawn from the Test Renders step.", 409);
    }
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
 * Save content to a gag in the draft. Replaces any earlier draft change and
 * cancels picks made for the content it replaces. Content equal to the
 * published version clears the draft change instead. Saving a gag the draft
 * removed puts it back.
 */
export async function saveGagContent(factId: number, gagId: number, rawContent: unknown, actor: GagActor): Promise<FactGag> {
  const content = validateGagContent(rawContent);
  return db.transaction(async (tx) => {
    await lockFact(tx, factId);
    await resolveScope(tx, factId, actor);
    const gag = await lockGag(tx, factId, gagId);
    // Saving what the draft already holds changes nothing (no spurious timestamp bump).
    if (gag.pendingContent != null && gagContentEqual(gag.pendingContent, content)) return gag;
    const sameAsPublished = gag.approvedContent != null && gagContentEqual(gag.approvedContent, content);
    if (sameAsPublished && gag.pendingContent == null && !gag.draftRemoved) return gag;
    // Picks were made for the content being replaced: they no longer show the gag.
    await clearPendingExamples(tx, [gagId]);
    // Content equal to the published version returns the gag to it in the
    // draft, published examples included; anything else is a draft change.
    const now = new Date();
    const [updated] = await tx.update(factGagsTable).set({
      draftRemoved: false,
      updatedAt: now,
      ...(sameAsPublished
        ? { pendingContent: null, pendingBy: null, pendingAt: null }
        : { pendingContent: content, pendingBy: actor.adminId, pendingAt: now }),
    }).where(eq(factGagsTable.id, gagId)).returning();
    if (!updated!.approvedContent && !updated!.pendingContent) {
      throw new GagError("SCENE_REQUIRED", "A gag needs content.", 400);
    }
    return updated!;
  });
}

/**
 * Approve one of a gag's test renders as its draft example for the subject
 * kind the render drew (male, female or pet). Accepted only for a finished,
 * unstyled render of THIS gag, of one of those kinds, whose frozen snapshot
 * holds exactly the gag's draft content.
 *
 * The pick is recorded in the draft and publishes nothing. A published gag
 * with no draft change gets one first: its published content and examples
 * are copied into the draft, and the pick replaces that kind's copy, so what
 * members are offered changes only at the next publish.
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
    if (gag.draftRemoved) throw new GagError("GAG_NOT_FOUND", "This gag is removed in the draft. Save it to put it back first.", 409);
    const target = (gag.pendingContent ?? gag.approvedContent) as GagContent | null;
    const drew = drewGagOf(attempt.factEnrichmentSnapshot);
    if (!target || drew == null || !sameRenderedGag(drew, target)) {
      throw new GagError("CONTENT_CHANGED", "This render was made from different content than the gag holds now. Run its test renders again.");
    }
    const now = new Date();
    if (gag.pendingContent == null) {
      // A published gag unchanged in the draft: open its draft from the published version.
      await copyPublishedExamplesToDraft(tx, gagId);
    }
    await putExample(tx, gagId, kind, "pending", attemptId, actor.adminId);
    const [touched] = await tx.update(factGagsTable).set({ pendingContent: target, pendingBy: actor.adminId, pendingAt: now, updatedAt: now })
      .where(eq(factGagsTable.id, gagId)).returning();
    return touched!;
  });
}

/**
 * Remove a gag from the draft. Allowed for any gag, the last one included:
 * the go-live rule then refuses to publish an empty set. A gag with nothing
 * published is removed outright; a published gag is marked removed in the
 * draft and stays offered until the draft is published.
 */
export async function removeGag(factId: number, gagId: number, actor: GagActor): Promise<FactGag> {
  return db.transaction(async (tx) => {
    await lockFact(tx, factId);
    await resolveScope(tx, factId, actor);
    const gag = await lockGag(tx, factId, gagId);
    const now = new Date();
    await clearPendingExamples(tx, [gagId]);
    const [updated] = await tx.update(factGagsTable).set(gag.approvedContent == null
      ? { removedAt: now, removedBy: actor.adminId, updatedAt: now }
      : { draftRemoved: true, pendingContent: null, pendingBy: null, pendingAt: null, updatedAt: now },
    ).where(eq(factGagsTable.id, gagId)).returning();
    return updated!;
  });
}
