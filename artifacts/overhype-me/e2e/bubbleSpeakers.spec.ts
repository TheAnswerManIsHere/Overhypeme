/**
 * Bubble speakers on the moderation screen, in a real browser
 * (PLAN_BUBBLE_SPEAKERS.md, Testing: "on a seeded hospital fact, add two
 * bubbles — subject 'Buckle up, mom', mom 'Will do'"; since
 * PLAN_GAG_DIRECT_RENDER.md increment 2, the speakers are the gag's cast).
 *
 * The review and its enrichment are stubbed (the dev database holds no fact,
 * and making one takes the AI pipeline), and so is reading the scene's cast (a
 * model call). What this owns is the screen: the gag card shows who is in its
 * scene, its speaker dropdown offers the subject and that cast, picking mom
 * stores the label "mom", the eleven "More art direction" controls are gone,
 * and the moderation screen keeps the fact's characters but not the taxonomy
 * editor. Nothing is saved.
 */
import { expect, test, type Page } from "@playwright/test";
import { castSourceKey, type FactEnrichment, type VisualPromptStrategyOverride } from "@workspace/api-zod";
import { enrichmentWithConcept, stubConceptReview } from "./helpers/adminStubs";

const TEXT = "When {NAME} was born, {SUBJ} drove {POSS} mom home from the hospital.";
const DESKTOP = { width: 1440, height: 1000 };
const SCENE = "Newborn {NAME} drives a station wagon out of the hospital lot, mom in the passenger seat.";
const MOM = { label: "mom", description: "the woman in the passenger seat" };

function hospitalEnrichment(): FactEnrichment {
  const e = enrichmentWithConcept(SCENE);
  const ov = e.visualPromptStrategyOverride as VisualPromptStrategyOverride;
  const bubbles = [
    { type: "speech" as const, entity: "subject", text: "Buckle up, mom" },
    { type: "speech" as const, entity: "subject", text: "Will do." },
  ];
  return {
    ...e,
    characters: [{ label: "mom", kind: "person", ofSubject: true }],
    charactersExtraction: { promptVersion: "v1", extractedAt: "2026-11-15T00:00:00.000Z" },
    visualPromptStrategyOverride: {
      ...ov,
      bubbles,
      // The gag's cast, read from its scene (the fold reads every stored gag's).
      cast: [MOM],
      castExtraction: { promptVersion: "v2", extractedAt: "2026-11-17T00:00:00.000Z", sourceKey: castSourceKey(SCENE, bubbles) },
    },
  } as FactEnrichment;
}

async function openReview(page: Page): Promise<void> {
  await page.goto("/admin/moderation");
  await page.getByText(`"${TEXT}"`, { exact: true }).first().click();
  await expect(page.getByTestId("visual-concept-card")).toBeVisible();
}

test.describe("Bubble speakers", () => {
  test.beforeEach(async ({ context, page }) => {
    const login = await context.request.post("/api/auth/dev-admin-login");
    expect(login.ok(), `dev-admin-login should be 200, got ${login.status()}`).toBe(true);
    await page.setViewportSize(DESKTOP);
  });

  test("the gag card shows who is in the scene, offers the subject and them as speakers, and has no extra art-direction controls", async ({ page }) => {
    await stubConceptReview(page, { id: 96801, submittedText: TEXT, stagingFactId: 96802, enrichment: hospitalEnrichment(), cast: [MOM] });
    await openReview(page);

    const gag = page.getByTestId("gag-card").first();
    await expect(gag.getByTestId("gag-cast-chip")).toHaveText(["mom"]);
    await expect(gag.getByText("More art direction")).toHaveCount(0);
    const speakers = gag.getByTestId("bubble-entity");
    await expect(speakers).toHaveCount(2);
    await expect(speakers.nth(0).locator("option")).toHaveText(["Alex (the subject)", "mom"]);

    await speakers.nth(1).selectOption({ label: "mom" });
    await expect(speakers.nth(1)).toHaveValue("mom");
    await expect(speakers.nth(0)).toHaveValue("subject");
    await page.screenshot({ path: test.info().outputPath("bubble-speakers.png"), fullPage: false });
  });

  test("the moderation screen shows neither the fact's characters nor the taxonomy editor: both are the Facts editor's (Issue #1018, increment 1.2c-ii)", async ({ page }) => {
    await stubConceptReview(page, { id: 96803, submittedText: TEXT, stagingFactId: 96804, enrichment: hospitalEnrichment(), cast: [MOM] });
    await openReview(page);
    await expect(page.getByRole("button", { name: /Advanced Options/ }), "Advanced Options left moderation (increment 1.3b)").toHaveCount(0);
    await expect(page.getByTestId("characters-editor")).toHaveCount(0);
    await expect(page.getByTestId("enrichment-editor")).toHaveCount(0);
    await expect(page.getByText(/Primary archetype/i)).toHaveCount(0);
  });
});
