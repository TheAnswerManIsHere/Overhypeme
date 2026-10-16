/**
 * Browser-level stubs for the admin READ endpoints the Facts editor and the
 * moderation review need, for the described-screen checks in
 * `adminScreens.spec.ts` (#631, increment 8).
 *
 * Same reason as `apiStubs.ts`: the dev stack's database holds no fact and no
 * review, and making either takes the AI pipeline. Only reads are stubbed. A
 * SAVE is never stubbed: the enrichment PATCH reaches the real server, whose
 * prompt-budget gate refuses an over-budget Visual Concept before it looks the
 * fact up (`routes/admin.ts`, PATCH /admin/facts/:id/enrichment), so the
 * refusal a test reads is the server's own.
 *
 * Shapes follow the server's serializers (`routes/admin.ts`,
 * `routes/reviews.ts`) and the page's own interfaces
 * (`pages/admin/facts.tsx`, `pages/admin/moderation.tsx`).
 */
import type { Page, Route } from "@playwright/test";
import type { FactEnrichment, VisualPromptStrategyOverride } from "@workspace/api-zod";
import { factDetail } from "./apiStubs";

const CREATED = "2026-10-01T12:00:00.000Z";

/** A complete enrichment blob with a Visual Concept, as a prepped fact carries it. */
export function enrichmentWithConcept(concept: string): FactEnrichment {
  const override: VisualPromptStrategyOverride = {
    version: 1,
    enabled: true,
    coreSceneOverride: concept,
    requiredVisualDetails: [],
    forbiddenVisualDetails: [],
    roleBindings: [],
    compositionGuidance: [],
    styleAgnosticPromptAdditions: [],
    negativePromptAdditions: [],
    bubbles: [],
  } as VisualPromptStrategyOverride;
  return {
    primaryArchetype: "superhuman_physical_feat",
    subtype: "force_scaled_action",
    modifiers: [],
    visualLiteralness: "literal_dramatization",
    visualComplexity: "medium",
    overhypeFit: "strong",
    adultSuitability: "safe",
    adultSuitabilityNotes: "",
    suggestedHashtags: ["legend", "onions", "kitchen"],
    taxonomyConfidence: 0.9,
    adminReviewNotes: "",
    culturalReferences: [],
    semanticEntities: [],
    visualPromptStrategyOverride: override,
  } as FactEnrichment;
}

/** One row of GET /api/admin/facts, as `pages/admin/facts.tsx` reads it. */
export interface AdminFactRow {
  id: number;
  text: string;
  canonicalText: string | null;
  parentId: number | null;
  useCase: string | null;
  isActive: boolean;
  hasEmbedding: boolean;
  hasPexelsImages: boolean;
  upvotes: number;
  downvotes: number;
  score: number;
  wilsonScore: number;
  commentCount: number;
  shareCount: number;
  submittedById: string | null;
  splitTokenIndex: number | null;
  createdAt: string;
  updatedAt: string;
  primaryArchetype?: string | null;
  enrichmentStatus?: string | null;
  hasEnrichment?: boolean;
  hasEnrichmentOverrides?: boolean;
  enrichmentBaselineChanged?: boolean;
  evalGolden?: boolean;
  evalGoldenReason?: string | null;
  variants?: AdminFactRow[];
}

export function adminFactRow(overrides: Partial<AdminFactRow> & Pick<AdminFactRow, "id" | "text">): AdminFactRow {
  return {
    canonicalText: null,
    parentId: null,
    useCase: null,
    isActive: true,
    hasEmbedding: true,
    hasPexelsImages: false,
    upvotes: 12,
    downvotes: 1,
    score: 11,
    wilsonScore: 0.7,
    commentCount: 0,
    shareCount: 0,
    submittedById: null,
    splitTokenIndex: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    primaryArchetype: "superhuman_physical_feat",
    enrichmentStatus: "ok",
    hasEnrichment: true,
    hasEnrichmentOverrides: false,
    enrichmentBaselineChanged: false,
    evalGolden: false,
    evalGoldenReason: null,
    variants: [],
    ...overrides,
  };
}

const EMPTY_OVERRIDE_SUMMARY = {
  hasOverrides: false,
  overriddenPaths: [],
  baselineChangedPaths: [],
  invalidPaths: [],
  crossFieldInvalid: false,
  hasVisualStrategyOverride: true,
};

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/**
 * Answer the reads behind one editable fact: its admin record, its resolved
 * enrichment, its version history, its stock-image panel and its public
 * detail. `listed` facts also answer GET /api/admin/facts. Writes pass through.
 */
export async function stubAdminFacts(
  page: Page,
  facts: { row: AdminFactRow; enrichment: FactEnrichment | null; listed?: boolean }[],
): Promise<void> {
  const byId = new Map(facts.map((f) => [f.row.id, f]));
  const listed = facts.filter((f) => f.listed !== false).map((f) => f.row);

  await page.route(/\/api\/admin\/facts(\?.*)?$/, (route) =>
    route.request().method() === "GET"
      ? json(route, { facts: listed, total: listed.length, page: 1, limit: 25 })
      : route.continue(),
  );
  await page.route(/\/api\/admin\/facts\/(\d+)(\/[a-z-]+)?(\?.*)?$/, (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const url = new URL(route.request().url());
    const m = /\/api\/admin\/facts\/(\d+)(\/[a-z-]+)?$/.exec(url.pathname)!;
    const entry = byId.get(Number(m[1]));
    if (!entry) return json(route, { error: "Fact not found" }, 404);
    const { row, enrichment } = entry;
    switch (m[2] ?? "") {
      case "":
        return json(route, { ...row, enrichment, enrichmentStatus: row.enrichmentStatus ?? null });
      case "/enrichment-resolved":
        return json(route, { aiDerived: enrichment, overrides: {}, effective: enrichment, overrideSummary: EMPTY_OVERRIDE_SUMMARY });
      case "/enrichment-versions":
        return json(route, {
          current: { hasEnrichment: enrichment != null, enrichmentStatus: row.enrichmentStatus ?? null, hasOverrides: false },
          inFlight: null,
          versions: [],
        });
      case "/pexels-images":
        return json(route, { pexelsStatus: null, factType: null, keywords: null, images: { male: [], female: [], neutral: [] } });
      default:
        return route.continue();
    }
  });
  await page.route(/\/api\/facts\/(\d+)(\?.*)?$/, (route) => {
    const id = Number(/\/api\/facts\/(\d+)/.exec(route.request().url())![1]);
    const entry = byId.get(id);
    if (!entry) return json(route, { error: "Fact not found" }, 404);
    return json(route, factDetail({ id, text: entry.row.text, parentId: entry.row.parentId, variants: [] }));
  });
}

/** A first-time submission waiting at moderation Step 2 (the Visual Concept step), with its staging fact. */
export async function stubConceptReview(
  page: Page,
  review: { id: number; submittedText: string; stagingFactId: number; enrichment: FactEnrichment },
): Promise<void> {
  const stagingSlice = {
    id: review.stagingFactId,
    isActive: false,
    enrichmentStatus: "ok",
    pexelsStatus: "ok",
    visualConceptStatus: "ok",
  };
  const row = {
    id: review.id,
    submittedText: review.submittedText,
    matchingFactId: null,
    matchingSimilarity: 0,
    status: "pending",
    workflowStage: "concept_review",
    stagingFactId: review.stagingFactId,
    stagingFact: stagingSlice,
    reason: null,
    adminNote: null,
    createdAt: CREATED,
    reviewedAt: null,
    submitter: null,
    matchingFact: null,
    approvedFactId: null,
    hashtags: ["legend"],
    enrichment: null,
    enrichmentStatus: "ok",
    candidateVersionId: null,
    rendersRunning: false,
    renderReviewState: null,
  };
  await page.route(/\/api\/admin\/reviews(\?.*)?$/, (route) => {
    const status = new URL(route.request().url()).searchParams.get("status");
    const reviews = status === "pending" || status === "all" ? [row] : [];
    return json(route, { reviews, total: reviews.length, page: 1, limit: 20 });
  });
  await page.route(new RegExp(`/api/admin/reviews/${review.id}(\\?.*)?$`), (route) =>
    route.request().method() === "GET"
      ? json(route, {
          ...row,
          stagingFact: { ...stagingSlice, enrichment: review.enrichment },
          visualConcepts: { status: "ok", candidates: [], current: true, generatedAt: CREATED },
        })
      : route.continue(),
  );
  await stubAdminFacts(page, [{
    row: adminFactRow({ id: review.stagingFactId, text: review.submittedText, isActive: false }),
    enrichment: review.enrichment,
    listed: false,
  }]);
}
