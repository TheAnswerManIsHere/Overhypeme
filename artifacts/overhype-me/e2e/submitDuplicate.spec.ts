/**
 * The submission form's duplicate message (plan
 * docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, item 2 and 1G; Issue #1018,
 * increment 1.4): on the server's "duplicate" verdict the form shows the
 * matching fact in an on-brand warning and offers "Submit anyway" and a way
 * back; identical wording is refused, before the click when the preview's exact
 * check found it and after it when the server does, and a refused fact's
 * greyed button never reads "Submit anyway". Wording of a fact that was
 * approved and later deactivated is refused as retired, with no link.
 *
 * The AI conversion and the duplicate verdict are stubbed (vendor calls); the
 * server's identical-text refusal is tested against the real database in the
 * api-server suites, and stubbed here so nothing is queued.
 */
import { expect, test, type Page } from "@playwright/test";

const TEMPLATE = "{NAME} out-stared a lighthouse.";
const MATCH = "Alex out-stared a lighthouse until it blinked.";

async function preview(page: Page, verdict: Record<string, unknown>): Promise<void> {
  await page.route("**/api/ai/tokenize-fact", (route) => route.fulfill({ json: { template: TEMPLATE } }));
  await page.route("**/api/ai/check-duplicate", (route) => route.fulfill({ json: verdict }));
  await page.route("**/api/ai/suggest-hashtags", (route) => route.fulfill({ json: { hashtags: [] } }));
  await page.goto("/submit", { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder(/When John does pushups/).fill("Alex out-stared a lighthouse, and it looked away first.");
  await page.getByRole("button", { name: /Preview/ }).click();
}

test.describe("Submit · the duplicate message", () => {
  test.beforeEach(async ({ context }) => {
    const login = await context.request.post("/api/auth/dev-admin-login");
    expect(login.ok(), `dev-admin-login should be 200, got ${login.status()}`).toBe(true);
  });

  test("a duplicate verdict shows the matching fact, a way back, and Submit anyway", async ({ page }) => {
    await preview(page, { outcome: "duplicate", isDuplicate: true, confidence: 82, matchingFactId: 4242, matchingFactText: TEMPLATE, matchingCanonicalText: MATCH, llmChecked: true });
    const warning = page.getByTestId("duplicate-warning");
    await expect(warning).toContainText("Great legends think alike.");
    await expect(warning.getByTestId("duplicate-match-text")).toHaveText(`"${MATCH}"`);
    await expect(warning.getByRole("link", { name: /See the original legend/ })).toHaveAttribute("href", "/facts/4242");
    await expect(page.getByTestId("submit-fact")).toHaveText(/Submit anyway/);
    await expect(page.getByTestId("submit-fact")).toBeEnabled();
    await warning.getByTestId("duplicate-back-out").click();
    await expect(page.getByPlaceholder(/When John does pushups/), "backing out returns to the wording").toBeVisible();
  });

  test("an exact match is refused before the click, with no Submit", async ({ page }) => {
    await preview(page, { outcome: "duplicate", isDuplicate: true, confidence: 100, matchingFactId: 4242, matchingFactText: TEMPLATE, matchingCanonicalText: MATCH, llmChecked: false });
    await expect(page.getByTestId("identical-refusal")).toContainText("Even legends can't happen twice.");
    await expect(page.getByTestId("duplicate-warning")).toHaveCount(0);
    await expect(page.getByTestId("submit-fact")).toBeDisabled();
    await expect(page.getByTestId("submit-fact"), "a refused fact offers no Submit anyway").not.toHaveText(/Submit anyway/);
  });

  test("identical wording of a retired fact says it was retired, and links nothing", async ({ page }) => {
    await page.route("**/api/facts/submit-review", (route) => route.fulfill({
      status: 409,
      json: { error: "This exact fact was on Overhype.me once and has been retired.", code: "IDENTICAL_FACT", matchingFactRetired: true, matchingCanonicalText: MATCH },
    }));
    await preview(page, { outcome: "distinct", isDuplicate: false, confidence: 10, llmChecked: true });
    await page.getByTestId("submit-fact").click();
    const refusal = page.getByTestId("identical-refusal");
    await expect(refusal).toContainText("retired");
    await expect(refusal).not.toContainText("already on Overhype.me");
    await expect(refusal.getByTestId("duplicate-match-text")).toHaveText(`"${MATCH}"`);
    await expect(refusal.getByRole("link")).toHaveCount(0);
    await expect(page.getByTestId("submit-fact")).toBeDisabled();
    await expect(page.getByTestId("submit-fact")).not.toHaveText(/Submit anyway/);
  });

  test("the server's identical-text refusal replaces the form's submit with the matching fact", async ({ page }) => {
    await page.route("**/api/facts/submit-review", (route) => route.fulfill({
      status: 409,
      json: { error: "This exact fact is already waiting for review.", code: "IDENTICAL_FACT", matchingReviewId: 77, matchingCanonicalText: MATCH },
    }));
    await preview(page, { outcome: "distinct", isDuplicate: false, confidence: 10, llmChecked: true });
    await page.getByTestId("submit-fact").click();
    const refusal = page.getByTestId("identical-refusal");
    await expect(refusal).toContainText("already waiting in line for review");
    await expect(refusal.getByTestId("duplicate-match-text")).toHaveText(`"${MATCH}"`);
    await expect(page.getByTestId("submit-fact")).toBeDisabled();
  });
});
