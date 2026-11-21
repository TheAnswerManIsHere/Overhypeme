/**
 * The moderation review's Test Renders step, driven in a real browser (plan
 * docs/plans/PLAN_GAG_EXAMPLES.md, Testing Plan item 8): the review-wide render
 * grid, its scenario checkboxes and the "How the AI read this fact" panel are
 * gone; each gag shows a male, a female and a pet tile; the Final hashtags
 * editor keeps a section of its own and its tags still ship with the approval;
 * and a gag there is its three render windows and nothing else from the gag
 * setup (plan PLAN_FACT_LIFECYCLE_REBUILD.md, item 11), with "Back to gags".
 *
 * The review and its gags are stubbed: what the server does with the approval
 * (the per-gag gate, the hashtags) is tested against the real database in the
 * api-server suites.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { EMPTY_VISUAL_STRATEGY_OVERRIDE, type FactGagsView, type GagView, type RenderScenarioCard } from "@workspace/api-zod";
import { enrichmentWithConcept } from "./helpers/adminStubs";

const REVIEW_ID = 9461;
const FACT_ID = 9462;
const TEXT = "Alex outlifts a forklift";
const DESKTOP = { width: 1440, height: 1100 };
const CREATED = "2026-11-15T12:00:00.000Z";

const tile = (key: RenderScenarioCard["key"], attemptId: number): RenderScenarioCard => ({
  key, label: key, purpose: "", referenceIdentityType: null, required: true, status: "done", stale: false,
  latestAttemptId: attemptId, imageUrl: null, message: null,
});
const example = (attemptId: number) => ({ attemptId, imageUrl: null });

/** A submission's gag: in the draft, with its male, female and pet renders picked. */
function gag(id: number, slot: number): GagView {
  return {
    id, slot, state: "new", availableToUsers: false, isDefault: false,
    approvedContent: null,
    approvedExamples: { male: null, female: null, pet: null },
    grandfathered: false, approvedAt: null,
    pendingContent: { ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: `{NAME} outlifts a forklift, take ${slot}.` },
    pendingExamples: { male: example(id * 10 + 1), female: example(id * 10 + 2), pet: example(id * 10 + 3) },
    draftRemoved: false,
    prefilledUntouched: false,
    renders: { male: tile("i2i_male_default", id * 10 + 1), female: tile("i2i_female_default", id * 10 + 2), pet: tile("i2i_nonhuman_animal", id * 10 + 3) },
  };
}

async function stubReview(page: Page, stage: "gags" | "test_renders" = "test_renders", draftReady: FactGagsView["draftReady"] = { ok: true, reason: null }): Promise<{ approvals: () => unknown[] }> {
  const approvals: unknown[] = [];
  const row = {
    id: REVIEW_ID, submittedText: TEXT, matchingFactId: null, matchingSimilarity: 0, status: "pending",
    workflowStage: stage, stagingFactId: FACT_ID,
    stagingFact: { id: FACT_ID, isActive: false, enrichmentStatus: "ok", visualConceptStatus: "ok" },
    reason: null, adminNote: null, createdAt: CREATED, reviewedAt: null, submitter: null, matchingFact: null,
    approvedFactId: null, hashtags: ["legend"], enrichment: null, enrichmentStatus: "ok",
    rendersRunning: false, renderReviewState: null,
  };
  const { visualPromptStrategyOverride: _gag, ...classification } = enrichmentWithConcept("{NAME} outlifts a forklift.");
  const view: FactGagsView = { factId: FACT_ID, isActive: false, review: { id: REVIEW_ID, stage }, gags: [gag(1, 1), gag(2, 2)], maxGags: 3, draftReady, filling: false, fillFailed: false };

  await page.route(/\/api\/admin\/reviews(\?.*)?$/, (route: Route) =>
    route.fulfill({ json: { reviews: [row], total: 1, page: 1, limit: 20 } }));
  await page.route(new RegExp(`/api/admin/reviews/${REVIEW_ID}(\\?.*)?$`), (route: Route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { ...row, stagingFact: { ...row.stagingFact, enrichment: classification }, visualConcepts: { status: "ok", candidates: [], current: true, generatedAt: CREATED } } })
      : route.continue());
  await page.route(new RegExp(`/api/admin/reviews/${REVIEW_ID}/approve-for-production$`), (route: Route) => {
    approvals.push(route.request().postDataJSON());
    return route.fulfill({ json: { success: true } });
  });
  await page.route(new RegExp(`/api/admin/facts/${FACT_ID}/gags$`), (route: Route) => route.fulfill({ json: view }));
  await page.route(new RegExp(`/api/admin/facts/${FACT_ID}(/enrichment-resolved|/enrichment-versions)?(\\?.*)?$`), (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/enrichment-resolved")) {
      return route.fulfill({ json: { aiDerived: classification, overrides: {}, effective: classification, overrideSummary: { overriddenPaths: [], count: 0 } } });
    }
    if (path.endsWith("/enrichment-versions")) {
      return route.fulfill({ json: { current: { hasEnrichment: true, enrichmentStatus: "ok", hasOverrides: false }, versions: [] } });
    }
    return route.fulfill({ json: { id: FACT_ID, text: TEXT, isActive: false, enrichment: classification, enrichmentStatus: "ok" } });
  });
  return { approvals: () => approvals };
}

test.describe("Admin · moderation · Test Renders per gag", () => {
  test.beforeEach(async ({ context, page }) => {
    const login = await context.request.post("/api/auth/dev-admin-login");
    expect(login.ok(), `dev-admin-login should be 200, got ${login.status()}`).toBe(true);
    await page.setViewportSize(DESKTOP);
  });

  test("each gag is its male, female and pet windows and nothing else, the grid is gone, and the hashtags still ship", async ({ page }) => {
    const server = await stubReview(page);
    await page.goto("/admin/moderation");
    await page.getByText(`"${TEXT}"`, { exact: true }).first().click();

    const cards = page.getByTestId("gag-card");
    await expect(cards).toHaveCount(2);
    for (const kind of ["male", "female", "pet"]) {
      await expect(cards.first().locator(`[data-testid="gag-render"][data-kind="${kind}"]`), `gag 1 has a ${kind} tile`).toBeVisible();
    }
    await expect(cards.first()).toContainText("Visual gag 1");
    await expect(cards.first().getByTestId("gag-render-picked"), "each window says its render is approved").toHaveCount(3);
    // Nothing else from the gag setup: no editor, no save, no removing or adding a gag.
    for (const id of ["visual-concept-textarea", "gag-save", "gag-remove", "gag-add", "gag-state", "gag-example-words"]) {
      await expect(page.getByTestId(id), `no ${id} on Test Renders`).toHaveCount(0);
    }
    await expect(page.getByTestId("back-to-visual-concept")).toHaveText(/Back to Gags/);

    await expect(page.getByText("How the AI read this fact"), "the AI-read panel is gone").toHaveCount(0);
    await expect(page.getByText("Run test renders"), "the scenario checkboxes are gone").toHaveCount(0);
    await expect(page.getByText(/Generic \(text-to-image\)/), "the generic render is gone").toHaveCount(0);

    // The Final hashtags editor has a section of its own, and what it holds ships.
    const tags = page.getByTestId("final-hashtags-section");
    await expect(tags).toBeVisible();
    await tags.getByRole("textbox").fill("forklift");
    await tags.getByRole("textbox").press("Enter");

    // Reject is on every step (PLAN_FACT_LIFECYCLE_REBUILD.md item 13), with its reason picker.
    await expect(page.getByRole("button", { name: "Reject", exact: true })).toBeVisible();
    await expect(page.locator("option", { hasText: "Couldn't make it work visually" })).toHaveCount(1);

    await page.getByTestId("approve-for-production").click();
    await expect.poll(() => server.approvals().length).toBe(1);
    expect((server.approvals()[0] as { hashtags: string[] }).hashtags).toContain("forklift");
  });

  // The lock beside Approve names what is missing, in the gags' own names (Issue #1018, 1.3b build report).
  test("Approve for production is locked while a gag lacks approved renders, and says which", async ({ page }) => {
    await stubReview(page, "test_renders", { ok: false, reason: "Visual gag 2 needs female and pet renders approved." });
    await page.goto("/admin/moderation");
    await page.getByText(`"${TEXT}"`, { exact: true }).first().click();
    await expect(page.getByTestId("approve-for-production")).toBeDisabled();
    await expect(page.getByText("Approve is locked: Visual gag 2 needs female and pet renders approved.")).toBeVisible();
  });

  // The Gags step's explanatory hint and Advanced Options are gone (plan
  // PLAN_FACT_LIFECYCLE_REBUILD.md, items 9 and 23; Issue #1018, increment 1.3b).
  test("the Gags step names its parts Gag ideas and Visual gag, with no hint and no Advanced Options", async ({ page }) => {
    await stubReview(page, "gags");
    await page.goto("/admin/moderation");
    await page.getByText(`"${TEXT}"`, { exact: true }).first().click();

    await expect(page.getByTestId("visual-concepts").getByText("Gag ideas", { exact: true })).toBeVisible();
    await expect(page.getByTestId("gag-card").first()).toContainText("Visual gag 1");
    await expect(page.getByTestId("gags-step-hint")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Advanced Options/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reject", exact: true }), "Reject is on the Gags step too").toBeVisible();
  });
});
