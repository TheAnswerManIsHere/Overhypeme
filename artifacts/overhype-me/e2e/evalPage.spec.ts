/**
 * The Eval page, driven in a browser (plan `docs/plans/PLAN_EVAL_PAGE.md`,
 * *Testing*): the models wizard from fact search to Generate Images, the
 * evaluation appearing in the list, Judge results opening blind judging,
 * Finish opening the results, the prompts wizard from fact search to a
 * wording evaluation, and the tab surviving a reload.
 *
 * Making an evaluation takes paid planner and fal calls, so the evaluation
 * API is stubbed here by a small in-memory server. That the server creates
 * and runs an evaluation once, queues each picture when its scene is ready
 * and refuses an early Finish is `evaluations.test.ts`, against the real
 * database. What this spec owns is the page and its links in a real browser.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

async function stubEvaluations(page: Page): Promise<{ generated: () => unknown[] }> {
  const generated: unknown[] = [];
  let finished = false;
  const evaluation = (id = 9, kind: "engine" | "prompt" = "engine") => ({
    id, description: "GPT vs Nano", createdAt: new Date().toISOString(), finishedAt: finished ? new Date().toISOString() : null,
    status: finished ? "finished" : "judging", images: 2, drawn: 2, inFlight: 0, failed: 0, lost: 0, skippedPanels: 0,
    judgeablePanels: 1, judgedPanels: 1, needsAction: [], engineFamilies: kind === "engine" ? ["gpt-image-2-6", "nano-banana-2-1"] : ["gpt-image-2-6"],
    scenarioKeys: ["i2i_male_default"], lookStyleIds: ["none"], factCount: 1, round: 1, imageSize: "comparison",
  });
  await page.route(/\/api\/admin\/comparison\/eligible-facts/, (route: Route) =>
    route.fulfill({ json: { facts: [{ id: 11, text: "Alex lifts a mountain before breakfast" }], eligibleTotal: 1 } }));
  await page.route(/\/api\/admin\/comparison\/evaluations\/estimate$/, (route: Route) =>
    route.fulfill({ json: { panels: 1, images: 2, totalBoundUsd: 0.6, typicalUsd: 0.25, preparationBoundUsd: 0.4, renderBoundUsd: 0.2, warning: false, refusal: null } }));
  await page.route(/\/api\/admin\/comparison\/evaluations\/9\/finish$/, (route: Route) => { finished = true; return route.fulfill({ json: { progress: evaluation() } }); });
  await page.route(/\/api\/admin\/comparison\/evaluations(\?.*)?$/, (route: Route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { selection: { kind: string } };
      generated.push(body);
      return route.fulfill({ status: 201, json: { setId: body.selection.kind === "prompt" ? 10 : 9, created: true } });
    }
    const kind = new URL(route.request().url()).searchParams.get("kind");
    const made = (k: string) => generated.some((g) => (g as { selection: { kind: string } }).selection.kind === k);
    return route.fulfill({ json: { evaluations: kind === "engine" ? (made("engine") ? [evaluation()] : []) : (made("prompt") ? [evaluation(10, "prompt")] : []) } });
  });
  // One engine with one saved wording version, so the wording step has a choice to make.
  await page.route(/\/api\/admin\/prompt-recipes$/, (route: Route) => route.fulfill({ json: {
    pieces: [],
    families: [{
      family: "gpt-image-2-6", engines: [], liveVersionId: null, promotions: [],
      versions: [{ id: 1, number: 1, note: "Lean wording", createdBy: null, createdAt: new Date().toISOString(), pieces: {} }],
    }],
  } }));
  await page.route(/\/api\/admin\/comparison\/sets\/9\/judging$/, (route: Route) => route.fulfill({ json: {
    set: { id: 9, label: "GPT vs Nano", round: 1, judgingEdition: 2 },
    progress: { panels: 1, judgeable: 1, judged: 1, skipped: 0, lost: 0 },
    panels: [],
  } }));
  return { generated: () => generated };
}

test.describe("Admin · Eval page", () => {
  test.beforeEach(async ({ context }) => {
    const login = await context.request.post("/api/auth/dev-admin-login");
    expect(login.ok(), `dev-admin-login should be 200, got ${login.status()}`).toBe(true);
  });

  test("set up an engine evaluation, generate it, judge it and finish into the results", async ({ page }) => {
    const { generated } = await stubEvaluations(page);
    await page.goto("/admin/eval", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("eval-tab-models")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
    await expect(page.getByTestId("evaluations-empty")).toBeVisible();

    await page.getByTestId("wizard-fact-search").fill("mountain");
    await page.getByTestId("wizard-fact-11").click();
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("wizard-engine-gpt-image-2-6").check();
    await page.getByTestId("wizard-engine-nano-banana-2-1").check();
    await page.getByTestId("wizard-next").click();
    await expect(page.getByTestId("wizard-photo-i2i_male_default")).toBeChecked();
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("wizard-description").fill("GPT vs Nano");
    await expect(page.getByTestId("wizard-count")).toContainText("= 2 images, usually about $0.25, at most $0.60");
    await page.getByTestId("wizard-generate").click();

    await expect(page.getByTestId("evaluation-9")).toBeVisible();
    expect(generated()).toHaveLength(1);
    expect((generated()[0] as { selection: { engineFamilies: string[] } }).selection.engineFamilies).toEqual(["gpt-image-2-6", "nano-banana-2-1"]);

    await page.getByTestId("evaluation-judge-9").click();
    await expect(page).toHaveURL(/\/admin\/eval\/judge\/9$/);
    await page.getByTestId("judging-finish").click();
    await expect(page).toHaveURL(/\/admin\/eval\/results\?sets=9$/);
  });

  test("set up a wording evaluation on the Evaluate Prompts tab and generate it (PR #931's build report)", async ({ page }) => {
    const { generated } = await stubEvaluations(page);
    await page.goto("/admin/eval?tab=prompts", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("eval-tab-prompts")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
    await expect(page.getByTestId("evaluations-empty")).toBeVisible();

    await page.getByTestId("wizard-fact-search").fill("mountain");
    await page.getByTestId("wizard-fact-11").click();
    await page.getByTestId("wizard-next").click();
    await expect(page.getByTestId("wizard-wording")).toBeVisible();
    // The live wording (today's baseline) and the newest version are pre-ticked.
    await expect(page.getByTestId("wizard-version-0")).toBeChecked();
    await expect(page.getByTestId("wizard-version-1")).toBeChecked();
    await page.getByTestId("wizard-next").click();
    await expect(page.getByTestId("wizard-photo-i2i_male_default")).toBeChecked();
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("wizard-description").fill("Lean vs today");
    await page.getByTestId("wizard-generate").click();

    await expect(page.getByTestId("evaluation-10")).toBeVisible();
    expect(generated()).toHaveLength(1);
    const sel = (generated()[0] as { selection: { kind: string; engineFamilies: string[]; recipeVersionIds: Array<number | null> } }).selection;
    expect(sel.kind).toBe("prompt");
    expect(sel.engineFamilies).toEqual(["gpt-image-2-6"]);
    expect([...sel.recipeVersionIds].sort()).toEqual([1, null].sort());
  });

  test("the Evaluate Prompts tab is kept in the URL across a reload", async ({ page }) => {
    await stubEvaluations(page);
    await page.goto("/admin/eval", { waitUntil: "domcontentloaded" });
    await page.getByTestId("eval-tab-prompts").click({ timeout: 30_000 });
    await expect(page).toHaveURL(/\?tab=prompts$/);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("eval-tab-prompts")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
    await expect(page.getByTestId("eval-wording-editor")).toBeVisible();
  });
});
