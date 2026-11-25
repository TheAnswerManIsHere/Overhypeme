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
import { EMPTY_VISUAL_STRATEGY_OVERRIDE, type FactGagsView, type GagView, type RenderHistoryEntry, type RenderScenarioCard } from "@workspace/api-zod";
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
    // Each picture's draft pick is its working render too (PLAN_RENDER_HISTORY.md D1).
    roles: {
      male: { live: null, approvedNext: example(id * 10 + 1), working: tile("i2i_male_default", id * 10 + 1) },
      female: { live: null, approvedNext: example(id * 10 + 2), working: tile("i2i_female_default", id * 10 + 2) },
      pet: { live: null, approvedNext: example(id * 10 + 3), working: tile("i2i_nonhuman_animal", id * 10 + 3) },
    },
  };
}

async function stubReview(page: Page, stage: "gags" | "test_renders" = "test_renders", draftReady: FactGagsView["draftReady"] = { ok: true, reason: null }): Promise<{ approvals: () => unknown[]; view: FactGagsView }> {
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
  await page.route(new RegExp(`/api/admin/facts/${FACT_ID}/render-history/removed-gags$`), (route: Route) => route.fulfill({ json: { gags: [] } }));
  await page.route(new RegExp(`/api/admin/facts/${FACT_ID}/gags/\\d+/render-history`), (route: Route) =>
    route.fulfill({ json: { gagId: 1, entries: [], nextBefore: null } }));
  await page.route(new RegExp(`/api/admin/facts/${FACT_ID}(\\?.*)?$`), (route: Route) =>
    route.fulfill({ json: { id: FACT_ID, text: TEXT, isActive: false, enrichment: classification, enrichmentStatus: "ok" } }));
  return { approvals: () => approvals, view };
}

/** A render in a gag's history, as the server reads it (PLAN_RENDER_HISTORY.md D4). */
function historyEntry(attemptId: number, over: Partial<RenderHistoryEntry> = {}): RenderHistoryEntry {
  return {
    attemptId, kind: "male", createdAt: CREATED, drawnBy: { userId: "a1", name: "Raena Admin" }, roles: [], status: "done", error: null,
    imageUrl: null, gag: { ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: "{NAME} outlifts a forklift, take 1." },
    reference: { identityType: "male", assetVersion: "v1" }, engine: { engineId: "gpt-image-2", fallback: null },
    prompt: { compiled: { scene: "outlifts a forklift" }, requests: [] },
    approval: "not_approved", cost: { state: "billed", usd: 0.04, unbilledRequests: 0, unknownRequests: 0 },
    ...over,
  };
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

  // Issue #1304 (plan PLAN_RENDER_HISTORY.md D3 and D6): the approved render is
  // locked beside the working one, and each gag's history opens to its renders,
  // pages, and deletes an old one after a confirmation naming it.
  test("the approved render is locked beside the working render, and the gag's history opens and deletes an old render after a confirmation", async ({ page }) => {
    const { view } = await stubReview(page);
    const g1 = view.gags[0]!;
    // A newer male render (#15) is working; the approved one (#11) stays locked.
    const withNewer: FactGagsView = { ...view, gags: [{ ...g1, roles: { ...g1.roles, male: { ...g1.roles.male, working: tile("i2i_male_default", 15) } } }, view.gags[1]!] };
    await page.route(new RegExp(`/api/admin/facts/${FACT_ID}/gags$`), (route: Route) => route.fulfill({ json: withNewer }));
    const deletes: string[] = [];
    let deleted = false;
    await page.route(new RegExp(`/api/admin/facts/${FACT_ID}/gags/1/render-history`), (route: Route) => route.fulfill({ json: {
      gagId: 1,
      entries: [
        historyEntry(15, { roles: ["working"] }),
        historyEntry(11, { roles: ["approved_next"], approval: "approved" }),
        ...(deleted ? [] : [historyEntry(9, { status: "failed", error: "vendor failed", cost: { state: "never_sent" } })]),
      ],
      nextBefore: null,
    } }));
    await page.route(new RegExp(`/api/admin/facts/${FACT_ID}/gags/1/renders/\\d+/delete$`), (route: Route) => {
      deletes.push(route.request().url());
      deleted = true;
      return route.fulfill({ json: { deleted: true, fileStillBeingRemoved: false } });
    });

    await page.goto("/admin/moderation");
    await page.getByText(`"${TEXT}"`, { exact: true }).first().click();
    const card = page.getByTestId("gag-card").first();
    const male = card.locator('[data-testid="gag-render"][data-kind="male"]');
    const official = male.getByTestId("gag-render-official");
    await expect(official).toHaveCount(1);
    await expect(official).toContainText("Approved for publishing");
    await expect(official).toContainText("Locked");
    await expect(official.getByTestId("gag-redraw-render"), "no draw on the approved render").toHaveCount(0);
    await expect(male.getByTestId("gag-render-working").getByTestId("gag-approve-render")).toBeVisible();

    const history = card.getByTestId("gag-history");
    await expect(history.getByTestId("gag-history-entry"), "history is collapsed until opened").toHaveCount(0);
    await history.getByTestId("gag-history-toggle").click();
    await expect(history.getByTestId("gag-history-entry")).toHaveCount(3);
    const old = history.locator('[data-testid="gag-history-entry"][data-attempt-id="9"]');
    await expect(old).toContainText("Failed: vendor failed");
    await old.getByTestId("gag-history-entry-toggle").click();
    await expect(old.getByTestId("gag-history-record")).toContainText("outlifts a forklift, take 1.");
    // The approved render offers no delete; the old failed one does, after a confirmation.
    const approved = history.locator('[data-testid="gag-history-entry"][data-attempt-id="11"]');
    await approved.getByTestId("gag-history-entry-toggle").click();
    await expect(approved.getByTestId("gag-history-delete")).toHaveCount(0);
    let asked = "";
    page.once("dialog", (d) => { asked = d.message(); void d.accept(); });
    await old.getByTestId("gag-history-delete").click();
    await expect(history.getByTestId("gag-history-notice")).toHaveText("Deleted.");
    expect(asked).toMatch(/^Delete the male render drawn .+ for good\?/);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatch(/\/gags\/1\/renders\/9\/delete$/);
    await expect(history.getByTestId("gag-history-entry")).toHaveCount(2);
    await page.screenshot({ path: "test-results/render-history.png", fullPage: true });
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
