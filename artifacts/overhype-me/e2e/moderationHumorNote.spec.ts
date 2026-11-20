/**
 * The humor note on the moderation screen's Gags step, driven in a real
 * browser (plan `docs/plans/PLAN_GAG_GENERATOR.md`, *Testing*: "one browser test
 * of the moderation journey"; PR #936's build report found it missing).
 *
 * What it owns is the screen and its hand-off with the server: no read of the
 * joke from the gag writer shows (it writes none since increment 1.2d, plan
 * PLAN_FACT_LIFECYCLE_REBUILD.md 1C); a note being typed survives Regenerate, through
 * "drafting" and back (the defect Codex found in PR #936 round 2, which the
 * component tests had missed because they never passed through pending); Save
 * note sends the typed text and the note then shows as approved.
 *
 * Drafting gags is a paid Astra call, so the review, Regenerate and the note
 * save are stubbed by a small stateful server here. That the server stores the
 * note, keeps it out of generation and marks gags stale on a correction is
 * `visualConceptJobs.test.ts`, against the real database.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { enrichmentWithConcept, stubConceptReview } from "./helpers/adminStubs";

const REVIEW_ID = 9361;
const FACT_ID = 9362;
const TEXT = "Alex slams a revolving door";
const DESKTOP = { width: 1440, height: 1000 };

const gag = (title: string) => ({
  title,
  whyItWorks: "The door cannot slam, and does.",
  sceneDescription: `{NAME} ${title.toLowerCase()} in a hotel lobby, deadpan.`,
  tokenValid: true,
  bubbles: [],
});

/** The review's gag state, served and changed the way the real routes would. */
async function stubGagServer(page: Page): Promise<{ notesSaved: () => string[]; regenerated: () => number }> {
  let phase: "first" | "drafting" | "second" = "first";
  let pendingPolls = 0;
  let note: { text: string; approvedBy: string; approvedAt: string } | null = null;
  const saved: string[] = [];
  let regenerations = 0;

  const visualConcepts = () => {
    if (phase === "drafting") {
      // Two polls at "pending" before the new generation lands, as a real job takes a while.
      if (++pendingPolls > 2) phase = "second";
      else return { status: "pending", candidates: [], current: false, humorNote: note };
    }
    const second = phase === "second";
    return {
      status: "ok",
      current: true,
      generatedAt: new Date().toISOString(),
      humorNote: note,
      candidates: second ? [gag("Spins it shut"), gag("Brakes it"), gag("Glares it closed")] : [gag("Slams it"), gag("Stops it"), gag("Shuts it")],
    };
  };

  await page.route(new RegExp(`/api/admin/reviews/${REVIEW_ID}(\\?.*)?$`), async (route: Route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ json: {
      id: REVIEW_ID, submittedText: TEXT, matchingFactId: null, matchingSimilarity: 0, status: "pending",
      workflowStage: "gags", stagingFactId: FACT_ID,
      stagingFact: { id: FACT_ID, isActive: false, enrichmentStatus: "ok", visualConceptStatus: "ok", enrichment: enrichmentWithConcept("{NAME} slams a revolving door.") },
      reason: null, adminNote: null, createdAt: "2026-11-13T12:00:00.000Z", reviewedAt: null, submitter: null, matchingFact: null,
      approvedFactId: null, hashtags: ["legend"], enrichment: null, enrichmentStatus: "ok",
      rendersRunning: false, renderReviewState: null,
      visualConcepts: visualConcepts(),
    } });
  });
  await page.route(new RegExp(`/api/admin/reviews/${REVIEW_ID}/visual-concepts/regenerate$`), (route: Route) => {
    regenerations++;
    phase = "drafting";
    pendingPolls = 0;
    return route.fulfill({ status: 202, json: { queued: true } });
  });
  await page.route(new RegExp(`/api/admin/reviews/${REVIEW_ID}/humor-note$`), (route: Route) => {
    const { text } = route.request().postDataJSON() as { text: string };
    saved.push(text);
    note = { text, approvedBy: "admin", approvedAt: new Date().toISOString() };
    return route.fulfill({ json: { humorNote: note } });
  });
  return { notesSaved: () => saved, regenerated: () => regenerations };
}

test.describe("Admin · moderation · the humor note on the Gags step", () => {
  test.beforeEach(async ({ context, page }) => {
    const login = await context.request.post("/api/auth/dev-admin-login");
    expect(login.ok(), `dev-admin-login should be 200, got ${login.status()}`).toBe(true);
    await page.setViewportSize(DESKTOP);
  });

  test("a note typed before saving survives Regenerate, then saves as the approved note", async ({ page }) => {
    await stubConceptReview(page, { id: REVIEW_ID, submittedText: TEXT, stagingFactId: FACT_ID, enrichment: enrichmentWithConcept("{NAME} slams a revolving door.") });
    const server = await stubGagServer(page);

    await page.goto("/admin/moderation");
    await page.getByText(`"${TEXT}"`, { exact: true }).first().click();

    await expect(page.getByTestId("candidate-title").first(), "the ideas have loaded").toBeVisible();
    await expect(page.getByText(/The AI's read of the joke/), "the gag writer's own read is gone").toHaveCount(0);

    await page.getByTestId("humor-note-write").click();
    const input = page.getByTestId("humor-note-input");
    await input.fill("The door is the victim; Alex is merely punctual.");

    await page.getByRole("button", { name: /^regenerate$/i }).click();
    await expect(page.getByText(/Drafting three ideas/i), "Regenerate passes through drafting").toBeVisible();
    await expect(page.getByText(/Drafting three ideas/i), "and the new generation lands").toBeHidden({ timeout: 15_000 });
    expect(server.regenerated()).toBe(1);

    await expect(input, "the typed note survived Regenerate").toHaveValue("The door is the victim; Alex is merely punctual.");
    expect(server.notesSaved(), "nothing was saved without Save note").toEqual([]);

    await page.getByTestId("humor-note-save").click();
    await expect(page.getByTestId("humor-note-approved")).toContainText("The door is the victim; Alex is merely punctual.");
    expect(server.notesSaved()).toEqual(["The door is the victim; Alex is merely punctual."]);
  });
});
