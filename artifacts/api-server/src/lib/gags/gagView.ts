/**
 * @purpose What the admin Gags panel reads for one fact: each gag's state in words, whether users could be offered it, its approved example and pending change, and its test renders.
 * @subsystem visual-pipeline
 *
 * Plans docs/plans/PLAN_THREE_GAGS.md (section E) and
 * docs/plans/PLAN_GAG_EXAMPLES.md (section E): each gag's examples per subject
 * kind and its render of the current content per kind. Read-only; every
 * write is in gagStore.ts.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  factsTable,
  factEnrichmentVersionsTable,
  imagePromptAttemptsTable,
  type FactGag,
} from "@workspace/db";
import { GAG_EXAMPLE_KINDS, MAX_GAGS_PER_FACT, type FactGagsView, type GagExample, type GagView, type PerKind } from "@workspace/api-zod";
import { findInFlightRefreshCandidate } from "../refreshCandidate";
import { buildGagKindCards, gagRenderImageUrl } from "../reviewRenderScenarios";
import { loadGags, normaliseGagContent, openReviewForFact } from "./resolver";
import { emptyExamples, loadExamples, type GagExamples } from "./examples";

async function examples(ids: number[], gagIdOf: Map<number, number>): Promise<Map<number, GagExample>> {
  const out = new Map<number, GagExample>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: imagePromptAttemptsTable.id, renderJobId: imagePromptAttemptsTable.renderJobId, path: imagePromptAttemptsTable.generatedImageObjectPath })
    .from(imagePromptAttemptsTable)
    .where(inArray(imagePromptAttemptsTable.id, ids));
  for (const r of rows) {
    const gagId = gagIdOf.get(r.id);
    out.set(r.id, {
      attemptId: r.id,
      imageUrl: r.renderJobId && r.path && gagId != null ? gagRenderImageUrl(gagId, r.renderJobId) : null,
    });
  }
  return out;
}

export async function buildFactGagsView(factId: number): Promise<FactGagsView | null> {
  const [fact] = await db.select({ id: factsTable.id, isActive: factsTable.isActive }).from(factsTable).where(eq(factsTable.id, factId)).limit(1);
  if (!fact) return null;
  const gags = await loadGags(factId);
  const review = await openReviewForFact(factId);
  const refresh = await findInFlightRefreshCandidate(factId);
  const [lastPromotion] = await db
    .select({ at: factEnrichmentVersionsTable.promotedAt })
    .from(factEnrichmentVersionsTable)
    .where(and(eq(factEnrichmentVersionsTable.factId, factId), eq(factEnrichmentVersionsTable.status, "promoted")))
    .orderBy(desc(factEnrichmentVersionsTable.promotedAt))
    .limit(1);

  const byGag = await loadExamples(gags.map((g) => g.id));
  const exampleIds: number[] = [];
  const gagIdOf = new Map<number, number>();
  for (const [gagId, set] of byGag) {
    for (const stage of ["approved", "pending"] as const) {
      for (const kind of GAG_EXAMPLE_KINDS) {
        const row = set[stage][kind];
        if (row) { exampleIds.push(row.attemptId); gagIdOf.set(row.attemptId, gagId); }
      }
    }
  }
  const ex = await examples(exampleIds, gagIdOf);
  const defaultId = fact.isActive ? gags.find((g) => g.approvedContent != null)?.id ?? null : null;

  const views: GagView[] = [];
  for (const g of gags) views.push(await viewOf(g, fact.isActive, defaultId, byGag.get(g.id) ?? emptyExamples(), ex, lastPromotion?.at ?? null));
  return {
    factId,
    isActive: fact.isActive,
    review: review ? { id: review.id, stage: review.workflowStage, refresh: review.candidateVersionId != null } : null,
    frozenOutsideReview: refresh != null,
    gags: views,
    maxGags: MAX_GAGS_PER_FACT,
  };
}

function perKind(set: GagExamples["approved"], ex: Map<number, GagExample>): PerKind<GagExample | null> {
  return {
    male: set.male ? ex.get(set.male.attemptId) ?? null : null,
    female: set.female ? ex.get(set.female.attemptId) ?? null : null,
    pet: set.pet ? ex.get(set.pet.attemptId) ?? null : null,
  };
}

async function viewOf(
  g: FactGag,
  factActive: boolean,
  defaultId: number | null,
  set: GagExamples,
  ex: Map<number, GagExample>,
  lastPromotionAt: Date | null,
): Promise<GagView> {
  const approved = g.approvedContent != null;
  const state = !approved ? "new" : g.pendingContent != null ? "approved_with_change" : "approved";
  return {
    id: g.id,
    slot: g.slot,
    state,
    availableToUsers: factActive && approved,
    isDefault: g.id === defaultId,
    approvedContent: normaliseGagContent(g.approvedContent),
    approvedExamples: perKind(set.approved, ex),
    grandfathered: approved && (g.approvedBeforeExampleSets || g.approvedCarriedOver),
    approvedAt: g.approvedAt?.toISOString() ?? null,
    pendingContent: normaliseGagContent(g.pendingContent),
    pendingReviewId: g.pendingReviewId ?? null,
    pendingExamples: perKind(set.pending, ex),
    pendingRemove: g.pendingRemove,
    refreshedSinceApproval: approved && lastPromotionAt != null && (g.approvedAt == null || g.approvedAt < lastPromotionAt),
    renders: await buildGagKindCards(g.id),
  };
}
