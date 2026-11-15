/**
 * @purpose The one place a fact's classification and one of its gags are joined into a render input, and the one answer to "which gags may a caller be offered".
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_THREE_GAGS.md, section B. Since migration 0139 a gag's
 * content lives only in `fact_gags`; `facts.enrichment` is the fact's
 * classification and holds no gag (a CHECK refuses one). The planner,
 * compiler and prompt budget still read the shape they always did, an
 * enrichment with a `visualPromptStrategyOverride`: `gagRenderInput` builds it
 * at the moment a render is built, and nothing stores it.
 *
 * Every gag follows the same rules whatever its slot. The default gag is the
 * available gag in the lowest slot; it is derived here and never stored.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  factGagsTable,
  factsTable,
  factEnrichmentVersionsTable,
  pendingReviewsTable,
  type FactGag,
} from "@workspace/db";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  visualPromptStrategyOverrideSchema,
  type FactEnrichment,
  type PerKind,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import { emptyExamples, loadExamples } from "./examples";

export type GagContent = VisualPromptStrategyOverride;

/** The list fields the schema defaults to []: older stored gags can lack any of them. */
const DEFAULTED_LISTS = [
  "requiredVisualDetails",
  "forbiddenVisualDetails",
  "roleBindings",
  "bubbles",
  "compositionGuidance",
  "styleAgnosticPromptAdditions",
  "negativePromptAdditions",
] as const;

/**
 * Stored gag content as a value the editors and readers can take. Migration
 * 0139 moved every old gag byte for byte, so a stored value can be an older,
 * shorter shape (no `roleBindings`, say): the schema fills its defaults. It
 * never refuses: content the schema rejects (an invalid token, say) comes back
 * as stored with its lists filled, so the moderator still sees the text to fix.
 * Read side only; nothing stored changes (Codex, PR #956 round 3).
 */
export function normaliseGagContent(stored: unknown): GagContent | null {
  if (stored == null || typeof stored !== "object" || Array.isArray(stored)) return null;
  const parsed = visualPromptStrategyOverrideSchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  const filled: Record<string, unknown> = { ...EMPTY_VISUAL_STRATEGY_OVERRIDE, ...(stored as Record<string, unknown>) };
  for (const key of DEFAULTED_LISTS) {
    if (!Array.isArray(filled[key])) filled[key] = [];
  }
  return filled as GagContent;
}

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The enrichment shape the render pipeline reads: a classification with this gag's content as its override. */
export function gagRenderInput(classification: FactEnrichment, content: GagContent): FactEnrichment {
  return { ...stripGag(classification), visualPromptStrategyOverride: content };
}

/** A classification with no gag in it, whatever was passed. */
export function stripGag(enrichment: FactEnrichment): FactEnrichment {
  if (!("visualPromptStrategyOverride" in enrichment)) return enrichment;
  const copy = { ...enrichment } as Record<string, unknown>;
  delete copy["visualPromptStrategyOverride"];
  return copy as FactEnrichment;
}

/** The content a moderator is working on: the pending change if there is one, else the approved version. */
export function workingContent(gag: FactGag): GagContent | null {
  return ((gag.pendingContent ?? gag.approvedContent) as GagContent | null) ?? null;
}

/** A fact's non-removed gags in slot order. */
export async function loadGags(factId: number, executor: Executor = db): Promise<FactGag[]> {
  return executor
    .select()
    .from(factGagsTable)
    .where(and(eq(factGagsTable.factId, factId), isNull(factGagsTable.removedAt)))
    .orderBy(asc(factGagsTable.slot));
}

/** Non-removed gags of many facts, grouped by fact, each list in slot order. */
export async function loadGagsForFacts(factIds: number[], executor: Executor = db): Promise<Map<number, FactGag[]>> {
  const out = new Map<number, FactGag[]>();
  if (factIds.length === 0) return out;
  const rows = await executor
    .select()
    .from(factGagsTable)
    .where(and(inArray(factGagsTable.factId, factIds), isNull(factGagsTable.removedAt)))
    .orderBy(asc(factGagsTable.factId), asc(factGagsTable.slot));
  for (const r of rows) {
    const list = out.get(r.factId) ?? [];
    list.push(r);
    out.set(r.factId, list);
  }
  return out;
}

export interface AvailableGag {
  gagId: number;
  slot: number;
  content: GagContent;
  /**
   * The approved example render per subject kind (plan PLAN_GAG_EXAMPLES.md):
   * all three, except on a gag approved before example sets (Q11), which may
   * have fewer or none.
   */
  examples: PerKind<number | null>;
}

/**
 * The gags a caller without moderator rights may be offered, default first:
 * the approved versions of a LIVE fact's non-removed gags, in slot order. A
 * pending change is never offered; the approved version keeps being served
 * while one waits. Empty for an inactive fact. A refresh's picks and removals
 * change it only at promotion.
 *
 * Phase 7's contract (plan PLAN_THREE_GAGS.md, decisions 13 and 15): its
 * picker lists exactly these, offers a choice wherever there is more than
 * one, and draws through `resolveOfferedGag`. Tested in availableGags.test.ts.
 */
export async function availableGags(factId: number, executor: Executor = db): Promise<AvailableGag[]> {
  const rows = await executor
    .select({ gag: factGagsTable })
    .from(factGagsTable)
    .innerJoin(factsTable, eq(factsTable.id, factGagsTable.factId))
    .where(and(
      eq(factGagsTable.factId, factId),
      eq(factsTable.isActive, true),
      isNull(factGagsTable.removedAt),
      sql`${factGagsTable.approvedContent} IS NOT NULL`,
    ))
    .orderBy(asc(factGagsTable.slot));
  const examples = await loadExamples(rows.map(({ gag }) => gag.id), executor);
  return rows.map(({ gag }) => {
    const set = (examples.get(gag.id) ?? emptyExamples()).approved;
    return {
      gagId: gag.id,
      slot: gag.slot,
      content: normaliseGagContent(gag.approvedContent)!,
      examples: { male: set.male?.attemptId ?? null, female: set.female?.attemptId ?? null, pet: set.pet?.attemptId ?? null },
    };
  });
}

export class GagNotAvailableError extends Error {
  constructor(public readonly factId: number, public readonly gagId: number | null) {
    super(gagId == null ? `Fact ${factId} has no available gag.` : `Gag ${gagId} is not available on fact ${factId}.`);
    this.name = "GagNotAvailableError";
  }
}

/**
 * Resolve the gag a caller without moderator rights draws: the named one if it
 * is available, else (no name) the default gag. Phase 7's AI-picture flow and
 * its picker call this, so the "only an available gag" rule cannot be skipped.
 */
export async function resolveOfferedGag(factId: number, gagId: number | null, executor: Executor = db): Promise<AvailableGag> {
  const available = await availableGags(factId, executor);
  const chosen = gagId == null ? available[0] : available.find((g) => g.gagId === gagId);
  if (!chosen) throw new GagNotAvailableError(factId, gagId);
  return chosen;
}

/**
 * The gag a moderator-side surface uses when it needs "the fact's gag" and has
 * no specific one (comparison runs, the prompt preview, the gag writer's
 * context): the default gag, the lowest-slot APPROVED one, as `availableGags`
 * puts first. Only a fact with nothing approved (first-time moderation) falls
 * back to its lowest-slot pending content. Approved-first across the whole set,
 * never per slot: a pending-only gag in a lower slot must not displace an
 * approved one above it (Codex, PR #956 round 1).
 */
export async function primaryGag(factId: number, executor: Executor = db): Promise<{ gag: FactGag; content: GagContent } | null> {
  const gags = await loadGags(factId, executor);
  const approved = gags.find((g) => g.approvedContent != null);
  if (approved) return { gag: approved, content: approved.approvedContent as GagContent };
  const pending = gags.find((g) => g.pendingContent != null);
  return pending ? { gag: pending, content: pending.pendingContent as GagContent } : null;
}

/**
 * The gag a moderation-side surface reads when it needs "the review's gag"
 * (the preview, the gag writer's cycle hash, the approve-the-gags gate): the
 * lowest-slot non-removed gag with content, and its WORKING content (the
 * pending change if there is one, else the approved version).
 */
export async function primaryWorkingGag(factId: number, executor: Executor = db): Promise<{ gag: FactGag; content: GagContent } | null> {
  for (const gag of await loadGags(factId, executor)) {
    const content = workingContent(gag);
    if (content) return { gag, content };
  }
  return null;
}

// ─── Where a gag's renders take their classification from ─────────────────

export interface GagRenderContext {
  factId: number;
  /** The fact's template text (locked). */
  factText: string;
  /** The classification renders are drawn against: a refresh candidate's while one is under review, else the fact's. */
  classification: unknown;
  /** The open review the fact is in, if any; renders made now are recorded against it. */
  reviewId: number | null;
  /** The open review is a refresh of a live fact. */
  refresh: boolean;
  /** The open review's stage, or null with no review. */
  stage: string | null;
  isActive: boolean;
}

/** The fact's open (unresolved) moderation review, if any. */
export async function openReviewForFact(factId: number, executor: Executor = db) {
  const [review] = await executor
    .select({
      id: pendingReviewsTable.id,
      workflowStage: pendingReviewsTable.workflowStage,
      status: pendingReviewsTable.status,
      candidateVersionId: pendingReviewsTable.candidateVersionId,
    })
    .from(pendingReviewsTable)
    .where(and(eq(pendingReviewsTable.stagingFactId, factId), eq(pendingReviewsTable.status, "pending")))
    .orderBy(desc(pendingReviewsTable.id))
    .limit(1);
  return review ?? null;
}

export async function loadGagRenderContext(factId: number, executor: Executor = db): Promise<GagRenderContext | null> {
  const [fact] = await executor
    .select({ id: factsTable.id, text: factsTable.text, enrichment: factsTable.enrichment, isActive: factsTable.isActive })
    .from(factsTable)
    .where(eq(factsTable.id, factId))
    .limit(1);
  if (!fact) return null;
  const review = await openReviewForFact(factId, executor);
  let classification: unknown = fact.enrichment;
  if (review?.candidateVersionId != null) {
    const [cand] = await executor
      .select({ enrichment: factEnrichmentVersionsTable.enrichment })
      .from(factEnrichmentVersionsTable)
      .where(eq(factEnrichmentVersionsTable.id, review.candidateVersionId))
      .limit(1);
    classification = cand?.enrichment ?? null;
  }
  return {
    factId,
    factText: fact.text,
    classification,
    reviewId: review?.id ?? null,
    refresh: review?.candidateVersionId != null,
    stage: review?.workflowStage ?? null,
    isActive: fact.isActive,
  };
}
