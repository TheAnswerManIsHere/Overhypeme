/**
 * Browser-level stubs for the admin READ endpoints the Facts editor and the
 * moderation review need, for the described-screen checks in
 * `adminScreens.spec.ts` (#631, increment 8).
 *
 * Same reason as `apiStubs.ts`: the dev stack's database holds no fact and no
 * review, and making either takes the AI pipeline. Only reads are stubbed. A
 * SAVE is never stubbed: a gag save reaches the real server, whose prompt-budget
 * gate refuses an over-budget Visual Concept before it looks the fact up
 * (`lib/gags/gagStore.ts`, `validateGagContent` ahead of the transaction), so
 * the refusal a test reads is the server's own.
 *
 * Reading a draft's cast (POST /api/admin/facts/:id/gags/cast, plan
 * PLAN_GAG_DIRECT_RENDER.md, F) IS stubbed: it is a model call, and every save
 * takes it first. The stub answers the fact's `cast` (none by default), keyed to
 * the scene and speakers it was sent, as the server would.
 *
 * Shapes follow the server's serializers (`routes/admin.ts`,
 * `routes/reviews.ts`) and the page's own interfaces
 * (`pages/admin/facts.tsx`, `pages/admin/moderation.tsx`).
 */
import type { Page, Route } from "@playwright/test";
import { castSourceKey, type FactEnrichment, type FactGagsView, type GagCastEntry, type GagView, type VisualPromptStrategyOverride } from "@workspace/api-zod";
import { factDetail } from "./apiStubs";

const CREATED = "2026-10-01T12:00:00.000Z";

/**
 * A complete enrichment blob with a Visual Concept: the stubs below serve the
 * classification as the fact's enrichment and the concept as its one gag
 * (GET /api/admin/facts/:id/gags), as the server holds them since migration
 * 0139 (plan docs/plans/PLAN_THREE_GAGS.md).
 */
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
  isActive: boolean;
  hasEmbedding: boolean;
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
}

export function adminFactRow(overrides: Partial<AdminFactRow> & Pick<AdminFactRow, "id" | "text">): AdminFactRow {
  return {
    canonicalText: null,
    isActive: true,
    hasEmbedding: true,
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
    ...overrides,
  };
}

/** The stubbed gag's id: one per fact, so a fact's id doubles as it. */
const gagIdFor = (factId: number) => factId;

/** Split a test's enrichment into what the server serves: the classification, and the gag. */
function splitGag(enrichment: FactEnrichment | null): { classification: FactEnrichment | null; gag: VisualPromptStrategyOverride | null } {
  if (!enrichment) return { classification: null, gag: null };
  const { visualPromptStrategyOverride, ...rest } = enrichment;
  return { classification: rest as FactEnrichment, gag: visualPromptStrategyOverride?.coreSceneOverride?.trim() ? visualPromptStrategyOverride : null };
}

/** GET /api/admin/facts/:id/gags for a fact with at most one gag: published on a live fact, in the draft on a staging one. */
export function gagsView(factId: number, isActive: boolean, gag: VisualPromptStrategyOverride | null, review: FactGagsView["review"] = null): FactGagsView {
  const gags: GagView[] = gag
    ? [{
        id: gagIdFor(factId),
        slot: 1,
        state: isActive ? "approved" : "new",
        availableToUsers: isActive,
        isDefault: isActive,
        approvedContent: isActive ? gag : null,
        approvedExamples: { male: null, female: null, pet: null },
        grandfathered: isActive,
        approvedAt: isActive ? CREATED : null,
        pendingContent: isActive ? null : gag,
        pendingExamples: { male: null, female: null, pet: null },
        draftRemoved: false,
        prefilledUntouched: false,
        renders: { male: null, female: null, pet: null },
      }]
    : [];
  // A live fact's published gag is ready as it stands; a staging gag has no renders approved yet.
  const draftReady = isActive && gag
    ? { ok: true, reason: null }
    : { ok: false, reason: gag ? "Visual gag 1 needs male, female and pet renders approved." : "A fact needs at least one visual gag before it can go live." };
  return { factId, isActive, review, gags, maxGags: 3, draftReady, filling: false, fillFailed: false };
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/**
 * Answer the reads behind one fact on the Facts page: its admin record (with
 * its stored taxonomy), its gags and its public detail. `listed` facts also answer GET /api/admin/facts. Writes pass through.
 */
export async function stubAdminFacts(
  page: Page,
  facts: { row: AdminFactRow; enrichment: FactEnrichment | null; listed?: boolean; review?: FactGagsView["review"]; cast?: GagCastEntry[] }[],
): Promise<void> {
  const byId = new Map(facts.map((f) => [f.row.id, f]));
  const listed = facts.filter((f) => f.listed !== false).map((f) => f.row);

  await page.route(/\/api\/admin\/facts(\?.*)?$/, (route) =>
    route.request().method() === "GET"
      ? json(route, { facts: listed, total: listed.length, page: 1, limit: 25 })
      : route.continue(),
  );
  await page.route(/\/api\/admin\/facts\/(\d+)\/gags\/cast$/, (route) => {
    const id = Number(/\/api\/admin\/facts\/(\d+)\//.exec(route.request().url())![1]);
    const body = route.request().postDataJSON() as { scene: string; bubbles: { entity: string; text: string }[] };
    const cast = byId.get(id)?.cast ?? [];
    const labels = new Set(cast.map((c) => c.label));
    const unboundSpeakers = body.bubbles.map((b) => b.entity.trim()).filter((e) => e && e !== "subject" && !labels.has(e));
    return json(route, {
      cast,
      castExtraction: { promptVersion: "e2e", extractedAt: CREATED, sourceKey: castSourceKey(body.scene, body.bubbles) },
      unboundSpeakers,
    });
  });
  await page.route(/\/api\/admin\/facts\/(\d+)(\/[a-z-]+)?(\?.*)?$/, (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const url = new URL(route.request().url());
    const m = /\/api\/admin\/facts\/(\d+)(\/[a-z-]+)?$/.exec(url.pathname)!;
    const entry = byId.get(Number(m[1]));
    if (!entry) return json(route, { error: "Fact not found" }, 404);
    const { row } = entry;
    const { classification: enrichment, gag } = splitGag(entry.enrichment);
    switch (m[2] ?? "") {
      case "":
        return json(route, { ...row, enrichment, enrichmentStatus: row.enrichmentStatus ?? null });
      case "/gags":
        return json(route, gagsView(row.id, row.isActive, gag, entry.review ?? null));
      default:
        return route.continue();
    }
  });
  await page.route(/\/api\/facts\/(\d+)(\?.*)?$/, (route) => {
    const id = Number(/\/api\/facts\/(\d+)/.exec(route.request().url())![1]);
    const entry = byId.get(id);
    if (!entry) return json(route, { error: "Fact not found" }, 404);
    return json(route, factDetail({ id, text: entry.row.text }));
  });
}

/** A first-time submission waiting at moderation Step 2 (the Visual Concept step), with its staging fact. */
export async function stubConceptReview(
  page: Page,
  review: { id: number; submittedText: string; stagingFactId: number; enrichment: FactEnrichment; cast?: GagCastEntry[] },
): Promise<void> {
  const stagingSlice = {
    id: review.stagingFactId,
    isActive: false,
    enrichmentStatus: "ok",
    visualConceptStatus: "ok",
  };
  const row = {
    id: review.id,
    submittedText: review.submittedText,
    matchingFactId: null,
    matchingSimilarity: 0,
    status: "pending",
    workflowStage: "gags",
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
          stagingFact: { ...stagingSlice, enrichment: splitGag(review.enrichment).classification },
          visualConcepts: { status: "ok", candidates: [], current: true, generatedAt: CREATED },
        })
      : route.continue(),
  );
  await stubAdminFacts(page, [{
    row: adminFactRow({ id: review.stagingFactId, text: review.submittedText, isActive: false }),
    enrichment: review.enrichment,
    listed: false,
    review: { id: review.id, stage: "gags", refresh: false },
    cast: review.cast,
  }]);
}
