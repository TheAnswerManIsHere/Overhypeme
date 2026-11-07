/**
 * The engine comparison's blind judging page, driven in a browser (launch
 * Phase 8, increment 3; plan `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`,
 * *Testing Plan*: "The blind page itself, driven in a browser: pick, face
 * mark, reload, and the pick survives; a panel with a missing cell cannot be
 * picked").
 *
 * The dev stack's database holds no comparison set, and making one takes paid
 * planner and fal calls, so the judging API is stubbed here by a small
 * in-memory server: the read, the images, and the pick. That the server
 * stores a pick against the hidden cell, keeps the history and names no
 * engine in its payload is `comparisonJudging.test.ts`, against the real
 * database. What this spec owns is the page: that a click, a face mark and a
 * reload behave in a real browser.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

/** A 1×1 PNG, so every image loads. */
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const tokens = (prefix: string) => ["a", "b", "c", "d", "e", "f"].map((l) => `${prefix}${l}`.padEnd(16, l));

interface Pick { pickedToken: string; faceMismatchTokens: string[]; judgedAt: string }

/** The judging API for set 7: a text-to-image panel, a reference panel, and one still missing an image. */
async function stubJudging(page: Page): Promise<{ picks: Map<number, Pick> }> {
  const picks = new Map<number, Pick>();
  const panels = [
    { panelId: 101, scenarioKey: "generic_t2i", scenarioLabel: "Generic (text-to-image)", imageMode: "t2i", faceMarkable: false, judgeable: true, tok: tokens("1") },
    { panelId: 102, scenarioKey: "i2i_male_default", scenarioLabel: "Male subject (image-to-image)", imageMode: "i2i", faceMarkable: true, judgeable: true, tok: tokens("2") },
    { panelId: 103, scenarioKey: "i2i_female_default", scenarioLabel: "Female subject (image-to-image)", imageMode: "i2i", faceMarkable: true, judgeable: false, tok: tokens("3") },
  ];
  const body = () => ({
    set: { id: 7, label: "Round 1", round: 1 },
    progress: { panels: 3, judgeable: 2, judged: picks.size },
    panels: panels.map((p, i) => ({
      panelId: p.panelId, position: i + 1, factId: 11, factText: "Alex lifts a mountain before breakfast",
      scenarioKey: p.scenarioKey, scenarioLabel: p.scenarioLabel, lookStyleId: "none", imageMode: p.imageMode,
      faceMarkable: p.faceMarkable, judgeable: p.judgeable, imagesReady: p.judgeable ? 6 : 5, imagesExpected: 6,
      images: p.judgeable ? p.tok.map((t) => ({ token: t, src: `/api/admin/comparison/panels/${p.panelId}/images/${t}` })) : [],
      pick: picks.get(p.panelId) ?? null,
    })),
  });
  await page.route(/\/api\/admin\/comparison\/sets\/7\/judging$/, (route: Route) => route.fulfill({ json: body() }));
  await page.route(/\/api\/admin\/comparison\/panels\/\d+\/images\/[0-9a-f]+$/, (route: Route) => route.fulfill({ body: PIXEL, contentType: "image/png" }));
  await page.route(/\/api\/admin\/comparison\/panels\/(\d+)\/pick$/, async (route: Route) => {
    const panelId = Number(route.request().url().match(/panels\/(\d+)\/pick/)![1]);
    const panel = panels.find((p) => p.panelId === panelId)!;
    const req = route.request().postDataJSON() as { pickedToken: string; faceMismatchTokens: string[] };
    if (!panel.judgeable) return route.fulfill({ status: 409, json: { error: "pick_refused", refusal: "this panel cannot be judged until every image is ready" } });
    picks.set(panelId, { ...req, judgedAt: new Date().toISOString() });
    return route.fulfill({ json: { pick: req } });
  });
  return { picks };
}

test.describe("Admin · Engine comparison · blind judging", () => {
  test.beforeEach(async ({ context }) => {
    const login = await context.request.post("/api/auth/dev-admin-login");
    expect(login.ok(), `dev-admin-login should be 200, got ${login.status()}`).toBe(true);
  });

  test("pick and face mark survive a reload; a panel missing an image cannot be picked", async ({ page }) => {
    const { picks } = await stubJudging(page);
    await page.goto("/admin/eval/judge/7", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("judging-images")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("judging-panel")).toContainText("Panel 1 of 3");
    await expect(page.getByTestId("judging-images").locator("img")).toHaveCount(6);
    // Every image actually drew.
    await expect.poll(() => page.getByTestId("judging-images").locator("img").evaluateAll((imgs) => imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0))).toBe(true);

    // Panel 1 (no person): pick C, save, and the page moves on.
    await expect(page.getByTestId("judging-face-A")).toHaveCount(0);
    await page.getByTestId("judging-pick-C").click();
    await page.getByTestId("judging-save").click();
    await expect(page.getByTestId("judging-panel")).toContainText("Panel 2 of 3");

    // Panel 2 (a person's photo): pick A and mark B's face.
    await page.getByTestId("judging-pick-A").click();
    await page.getByTestId("judging-face-B").check();
    await page.getByTestId("judging-save").click();
    await expect(page.getByTestId("judging-progress")).toContainText("2 of 3 judged");
    expect(picks.get(102)?.faceMismatchTokens).toHaveLength(1);

    // Reload: the picks are read back and shown on their panels.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("judging-images")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("judging-panel")).toContainText("Panel 1 of 3");
    await expect(page.getByTestId("judging-pick-C")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("judging-next").click();
    await expect(page.getByTestId("judging-pick-A")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("judging-face-B")).toBeChecked();

    // Panel 3 is missing an image: no images, nothing to pick.
    await page.getByTestId("judging-next").click();
    await expect(page.getByTestId("judging-not-ready")).toContainText("5 of 6 images are ready");
    await expect(page.getByTestId("judging-images")).toHaveCount(0);
    await expect(page.getByTestId("judging-save")).toHaveCount(0);
  });
});
