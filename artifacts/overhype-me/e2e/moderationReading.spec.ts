/**
 * The Reading step and Reject's confirmation, driven in a real browser (plan
 * docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, 1B and 1D; Issue #1018,
 * increment 1.2c-ii).
 *
 * What it owns is the screen and its hand-off with the server: a review at
 * Reading opens on the Reading step of four; while the run is in flight the
 * step says so and updates live; the draft note and the research beneath it
 * show; the note is approved as the moderator edited it, with the run it was
 * written from, and the wizard moves to Gags. Past triage, Reject asks first.
 *
 * The reading is a paid web-search call, so the review and its routes are
 * stubbed by a small stateful server here. That the server stores the run,
 * records the approval and rewrites the ideas is readingStep.test.ts, against
 * the real database.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { stubAdminFacts, adminFactRow } from "./helpers/adminStubs";

const REVIEW_ID = 9461;
const FACT_ID = 9462;
const TEXT = "Alex has a Shark Week";
const DESKTOP = { width: 1440, height: 1000 };
const DRAFT = "Normally people watch sharks; here the sharks hold a week for Alex.";

async function stubReadingServer(page: Page): Promise<{ approvals: () => Array<{ text: string; readingId: number }>; rejects: () => number }> {
  let polls = 0;
  let stage: "reading" | "gags" | "rejected" = "reading";
  const approvals: Array<{ text: string; readingId: number }> = [];
  let rejects = 0;

  const reading = () => {
    // Two polls in flight before the run lands, as a real reading takes a while.
    const done = ++polls > 2;
    return {
      latest: {
        id: 77,
        status: done ? "ok" : "pending",
        research: done ? { references: [{ phrase: "Shark Week", meaning: "A TV week of shark documentaries; here the sharks watch Alex.", pictureImplication: "Sharks watching Alex on TV, NOT Alex watching sharks.", sources: [{ title: "Shark Week", url: "https://example.com/shark-week" }] }] } : null,
        draftNote: done ? DRAFT : null,
        error: null,
        createdAt: "2026-11-18T00:00:00.000Z",
        completedAt: done ? "2026-11-18T00:01:00.000Z" : null,
      },
      approved: null,
    };
  };
  const row = () => ({
    id: REVIEW_ID, submittedText: TEXT, matchingFactId: null, matchingSimilarity: 0, status: stage === "rejected" ? "rejected" : "pending",
    workflowStage: stage, stagingFactId: FACT_ID,
    stagingFact: { id: FACT_ID, isActive: false, visualConceptStatus: null },
    reason: null, adminNote: null, createdAt: "2026-11-18T00:00:00.000Z", reviewedAt: null, submitter: null, matchingFact: null,
    approvedFactId: null, hashtags: ["legend"], enrichment: null, enrichmentStatus: null,
    rendersRunning: false, renderReviewState: null, readingStatus: "pending",
  });

  await page.route(/\/api\/admin\/reviews(\?.*)?$/, (route: Route) => route.fulfill({ json: { reviews: [row()], total: 1, page: 1, limit: 20 } }));
  await page.route(new RegExp(`/api/admin/reviews/${REVIEW_ID}(\\?.*)?$`), (route: Route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ json: {
      ...row(),
      stagingFact: { id: FACT_ID, isActive: false, visualConceptStatus: stage === "gags" ? "pending" : null, enrichment: null },
      visualConcepts: { status: stage === "gags" ? "pending" : null, candidates: [], current: false, humorNote: null },
      reading: reading(),
    } });
  });
  await page.route(new RegExp(`/api/admin/reviews/${REVIEW_ID}/approve-reading$`), (route: Route) => {
    approvals.push(route.request().postDataJSON() as { text: string; readingId: number });
    stage = "gags";
    return route.fulfill({ json: { success: true, workflowStage: "gags" } });
  });
  await page.route(new RegExp(`/api/admin/reviews/${REVIEW_ID}/reject$`), (route: Route) => {
    rejects++;
    stage = "rejected";
    return route.fulfill({ json: { success: true } });
  });
  await stubAdminFacts(page, [{ row: adminFactRow({ id: FACT_ID, text: TEXT, isActive: false }), enrichment: null, listed: false, review: { id: REVIEW_ID, stage: "gags", refresh: false } }]);
  return { approvals: () => approvals, rejects: () => rejects };
}

test.describe("Admin · moderation · the Reading step", () => {
  test.beforeEach(async ({ context, page }) => {
    const login = await context.request.post("/api/auth/dev-admin-login");
    expect(login.ok(), `dev-admin-login should be 200, got ${login.status()}`).toBe(true);
    await page.setViewportSize(DESKTOP);
  });

  test("opens on Reading, waits live for the run, and approves the note as edited", async ({ page }) => {
    const server = await stubReadingServer(page);
    await page.goto("/admin/moderation");
    await page.getByText(`"${TEXT}"`, { exact: true }).first().click();

    const steps = page.getByTestId("moderation-step-indicator");
    await expect(steps).toContainText("Triage");
    await expect(steps).toContainText("Reading");
    await expect(steps).toContainText("Gags");
    await expect(steps).toContainText("Test Renders");

    await expect(page.getByTestId("reading-pending"), "the run in flight shows").toBeVisible();
    await expect(page.getByTestId("reading-note"), "and lands without a refresh").toHaveValue(DRAFT, { timeout: 15_000 });
    await expect(page.getByTestId("reading-research")).toContainText("Sharks watching Alex on TV");

    await page.getByTestId("reading-note").fill("The sharks are the audience; Alex is the show.");
    await page.getByTestId("approve-reading").click();
    await expect.poll(() => server.approvals()).toEqual([{ text: "The sharks are the audience; Alex is the show.", readingId: 77 }]);
    await expect(page.getByTestId("gags-step-hint"), "the wizard moves to Gags").toBeVisible();
  });

  test("Reject past triage asks first, and only the confirmation rejects", async ({ page }) => {
    const server = await stubReadingServer(page);
    await page.goto("/admin/moderation");
    await page.getByText(`"${TEXT}"`, { exact: true }).first().click();
    await expect(page.getByTestId("reading-pending")).toBeVisible();

    await page.getByRole("combobox").selectOption("visual");
    await page.getByRole("button", { name: /^reject$/i }).click();
    await expect(page.getByTestId("reject-confirm")).toContainText("Its gags are deleted");
    expect(server.rejects(), "nothing rejected before the confirmation").toBe(0);

    await page.getByRole("button", { name: /keep it/i }).click();
    await expect(page.getByTestId("reject-confirm")).toBeHidden();
    expect(server.rejects()).toBe(0);

    await page.getByRole("button", { name: /^reject$/i }).click();
    await page.getByTestId("reject-confirm-yes").click();
    await expect.poll(() => server.rejects()).toBe(1);
  });
});
