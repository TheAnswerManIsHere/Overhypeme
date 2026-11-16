/**
 * Bubble speakers on the moderation screen, in a real browser
 * (PLAN_BUBBLE_SPEAKERS.md, Testing: "on a seeded hospital fact, add two
 * bubbles — subject 'Buckle up, mom', mom 'Will do'").
 *
 * The review and its enrichment are stubbed (the dev database holds no fact,
 * and making one takes the AI pipeline); what this owns is the screen: the
 * gag's speaker dropdown offers the subject and the fact's characters by
 * their display names, picking "Alex's mom" stores the plain label "mom", the
 * same choices appear in the bubble editor under "More art direction", and the
 * Characters section in the enrichment shows the list. Nothing is saved.
 */
import { expect, test, type Page } from "@playwright/test";
import { enrichmentWithConcept, stubConceptReview } from "./helpers/adminStubs";
import type { FactEnrichment, VisualPromptStrategyOverride } from "@workspace/api-zod";

const TEXT = "When {NAME} was born, {SUBJ} drove {POSS} mom home from the hospital.";
const DESKTOP = { width: 1440, height: 1000 };

function hospitalEnrichment(): FactEnrichment {
  const e = enrichmentWithConcept("Newborn {NAME} drives a station wagon out of the hospital lot, mom in the passenger seat.");
  const ov = e.visualPromptStrategyOverride as VisualPromptStrategyOverride;
  return {
    ...e,
    characters: [{ label: "mom", kind: "person", ofSubject: true }],
    charactersExtraction: { promptVersion: "v1", extractedAt: "2026-11-15T00:00:00.000Z" },
    visualPromptStrategyOverride: {
      ...ov,
      bubbles: [
        { type: "speech", entity: "subject", text: "Buckle up, mom" },
        { type: "speech", entity: "subject", text: "Will do." },
      ],
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

  test("the speaker dropdown offers Alex and Alex's mom, and picking mom stores the label", async ({ page }) => {
    await stubConceptReview(page, { id: 96801, submittedText: TEXT, stagingFactId: 96802, enrichment: hospitalEnrichment() });
    await openReview(page);

    const gag = page.getByTestId("gag-card").first();
    // Two bubbles, each editable in two placements: the gag card (first two)
    // and the bubble editor inside "More art direction" (last two).
    const all = gag.getByTestId("bubble-entity");
    await expect(all).toHaveCount(4);
    const speakers = gag.getByTestId("bubble-editor").first().getByTestId("bubble-entity");
    await expect(speakers).toHaveCount(2);
    const first = speakers.nth(0);
    await expect(first.locator("option")).toHaveText(["Alex (the subject)", "Alex's mom"]);

    await speakers.nth(1).selectOption({ label: "Alex's mom" });
    await expect(speakers.nth(1)).toHaveValue("mom");
    await expect(speakers.nth(0)).toHaveValue("subject");
    await page.screenshot({ path: test.info().outputPath("bubble-speakers.png"), fullPage: false });

    // The bubble editor under "More art direction" edits the same draft and offers the same speakers.
    await gag.getByText("More art direction").click();
    await expect(all.nth(3)).toHaveValue("mom");
    await expect(all.nth(2).locator("option")).toHaveText(["Alex (the subject)", "Alex's mom"]);
  });

  test("the enrichment's Characters section lists the fact's characters", async ({ page }) => {
    await stubConceptReview(page, { id: 96803, submittedText: TEXT, stagingFactId: 96804, enrichment: hospitalEnrichment() });
    await openReview(page);
    await page.getByRole("button", { name: /Advanced Options/ }).click();
    const editor = page.getByTestId("characters-editor");
    await expect(editor).toBeVisible();
    await expect(editor.getByTestId("character-label")).toHaveValue("mom");
    await expect(editor.getByTestId("character-display")).toContainText("Alex's mom");
  });
});
