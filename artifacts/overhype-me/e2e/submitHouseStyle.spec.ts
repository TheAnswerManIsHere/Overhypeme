/**
 * The submit page shows a fact's wording in the house style before it is
 * saved (plan docs/plans/PLAN_FACT_HOUSE_STYLE.md, I3): the preview capitalizes
 * the first letter and ends the fact with punctuation, including after an
 * edit in the advanced template editor, while the editor's own text is left
 * as typed. The AI conversion and the duplicate verdict are stubbed (vendor
 * calls); the server's own application of the rule is tested in the
 * api-server suite (factHouseStyle.test.ts).
 */
import { expect, test } from "@playwright/test";

test.describe("Submit · the house style in the preview", () => {
  test.beforeEach(async ({ context }) => {
    const login = await context.request.post("/api/auth/dev-admin-login");
    expect(login.ok(), `dev-admin-login should be 200, got ${login.status()}`).toBe(true);
  });

  test("the preview shows the tidied wording, after an advanced edit too, and the editor keeps what was typed", async ({ page }) => {
    await page.route("**/api/ai/tokenize-fact", (route) => route.fulfill({ json: { template: "{NAME} out-stared a lighthouse" } }));
    await page.route("**/api/ai/check-duplicate", (route) => route.fulfill({ json: { outcome: "distinct", isDuplicate: false, confidence: 10, llmChecked: true } }));
    await page.route("**/api/ai/suggest-hashtags", (route) => route.fulfill({ json: { hashtags: [] } }));
    await page.goto("/submit", { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder(/When John does pushups/).fill("Alex out-stared a lighthouse");
    await page.getByRole("button", { name: /Preview/ }).click();

    const theyPreview = page.getByText("Alex Jordan out-stared a lighthouse", { exact: false }).first();
    await expect(theyPreview, "the tokenizer's unpunctuated wording is previewed with a period").toContainText("out-stared a lighthouse.");

    await page.getByRole("button", { name: /Advanced — view & edit template/ }).click();
    const editor = page.locator("textarea");
    await editor.fill("{SUBJ} out-ran a train,");
    await expect(editor, "the editor is not rewritten as it is typed").toHaveValue("{SUBJ} out-ran a train,");
    await expect(page.getByText("They out-ran a train.", { exact: false }).first(), "an advanced edit previews capitalized, with the trailing comma replaced").toBeVisible();
  });
});
