/**
 * @purpose What the admin Gags panel reads for one fact: each gag's state in words, whether users could be offered it, its approved example and pending change, and its test renders.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_THREE_GAGS.md, section E. Read-only; every write is in
 * gagStore.ts.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  factsTable,
  factEnrichmentVersionsTable,
  imagePromptAttemptsTable,
  type FactGag,
} from "@workspace/db";
import { MAX_GAGS_PER_FACT, type FactGagsView, type GagExample, type GagView, type VisualPromptStrategyOverride } from "@workspace/api-zod";
import { findInFlightRefreshCandidate } from "../refreshCandidate";
import { buildGagScenarioGrid, gagRenderImageUrl } from "../reviewRenderScenarios";
import { loadGags, openReviewForFact } from "./resolver";

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

  const exampleIds: number[] = [];
  const gagIdOf = new Map<number, number>();
  for (const g of gags) {
    for (const id of [g.approvedExampleAttemptId, g.pendingExampleAttemptId]) {
      if (id != null) { exampleIds.push(id); gagIdOf.set(id, g.id); }
    }
  }
  const ex = await examples(exampleIds, gagIdOf);
  const defaultId = fact.isActive ? gags.find((g) => g.approvedContent != null)?.id ?? null : null;

  const views: GagView[] = [];
  for (const g of gags) views.push(await viewOf(g, fact.isActive, defaultId, ex, lastPromotion?.at ?? null, review?.id ?? null));
  return {
    factId,
    isActive: fact.isActive,
    review: review ? { id: review.id, stage: review.workflowStage, refresh: review.candidateVersionId != null } : null,
    frozenOutsideReview: refresh != null,
    gags: views,
    maxGags: MAX_GAGS_PER_FACT,
  };
}

async function viewOf(
  g: FactGag,
  factActive: boolean,
  defaultId: number | null,
  ex: Map<number, GagExample>,
  lastPromotionAt: Date | null,
  reviewId: number | null,
): Promise<GagView> {
  const approved = g.approvedContent != null;
  const state = !approved ? "new" : g.pendingContent != null ? "approved_with_change" : "approved";
  return {
    id: g.id,
    slot: g.slot,
    state,
    availableToUsers: factActive && approved,
    isDefault: g.id === defaultId,
    approvedContent: (g.approvedContent as VisualPromptStrategyOverride | null) ?? null,
    approvedExample: g.approvedExampleAttemptId != null ? ex.get(g.approvedExampleAttemptId) ?? null : null,
    carriedOver: g.approvedCarriedOver,
    approvedAt: g.approvedAt?.toISOString() ?? null,
    pendingContent: (g.pendingContent as VisualPromptStrategyOverride | null) ?? null,
    pendingReviewId: g.pendingReviewId ?? null,
    pendingExample: g.pendingExampleAttemptId != null ? ex.get(g.pendingExampleAttemptId) ?? null : null,
    pendingRemove: g.pendingRemove,
    refreshedSinceApproval: approved && lastPromotionAt != null && (g.approvedAt == null || g.approvedAt < lastPromotionAt),
    renders: await buildGagScenarioGrid(g.id, reviewId),
  };
}
