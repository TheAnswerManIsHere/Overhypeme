/**
 * Issue #850 — the meme builder uses the full screen on iPad and desktop.
 *
 * At 1024 px wide or more the builder lays the preview and the controls side
 * by side: the preview fills everything left of a scrolling controls column,
 * and "Make my meme" sits at the column's foot. Narrower screens keep the
 * stacked layout, resize handle included. Geometry and reachability are
 * checked here; whether it feels right is David's UAT.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { factDetail, stubPublicFacts } from "./helpers/apiStubs";
import { seedIdentity } from "./helpers/identity";
import { PAID_ACCOUNT, TEST_ACCOUNT_PASSWORD, signInThroughForm } from "./helpers/testAccounts";

const WIDE_VIEWPORTS = [
  { name: "iPad landscape", width: 1180, height: 820 },
  { name: "desktop", width: 1440, height: 900 },
  { name: "tall desktop window", width: 1280, height: 1600 },
];
const NARROW_VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "iPad portrait", width: 820, height: 1180 },
];
const RATIOS = ["landscape", "square", "portrait"] as const;
const FACT_TEXT = "{NAME} out-ran the weekend.";

async function openBuilder(page: Page, factId: number): Promise<void> {
  await stubPublicFacts(page, { facts: [factDetail({ id: factId, text: FACT_TEXT })] });
  await page.goto(`/facts/${factId}/meme`);
  await expect(page.getByRole("button", { name: "Make my meme" })).toBeVisible();
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, "element should be laid out").not.toBeNull();
  return b!;
}

test.describe("Meme builder on wide screens (Issue #850)", () => {
  for (const vp of WIDE_VIEWPORTS) {
    test(`${vp.name} (${vp.width}x${vp.height}): preview beside the controls, filling its area for every ratio`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await seedIdentity(page);
      await openBuilder(page, 850);

      await expect(page.locator('[data-layout="wide"]')).toBeVisible();
      const previewCol = await box(page.getByTestId("builder-preview-column"));
      const controlsCol = await box(page.getByTestId("builder-controls-column"));
      expect(previewCol.x + previewCol.width).toBeLessThanOrEqual(controlsCol.x + 1);
      // The wide layout has no resize handle (Q25: 1).
      await expect(page.getByTestId("locked-preview-resize-handle")).toHaveCount(0);

      const area = page.getByTestId("locked-preview-area");
      const canvas = page.locator('canvas[aria-label="Meme preview"]');
      for (const ratio of RATIOS) {
        await page.getByTestId(`aspect-${ratio}`).click();
        await expect(page.getByTestId(`aspect-${ratio}`)).toHaveAttribute("aria-checked", "true");
        await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(100);
        const a = await box(area);
        const c = await box(canvas);
        // Inside its area…
        expect(c.x).toBeGreaterThanOrEqual(a.x - 1);
        expect(c.y).toBeGreaterThanOrEqual(a.y - 1);
        expect(c.x + c.width).toBeLessThanOrEqual(a.x + a.width + 1);
        expect(c.y + c.height).toBeLessThanOrEqual(a.y + a.height + 1);
        // …and reaching its full width or its full height (2px border, 2px rounding).
        const fillsWidth = a.width - c.width <= 4;
        const fillsHeight = a.height - c.height <= 4;
        expect(fillsWidth || fillsHeight, `${ratio}: canvas ${c.width}x${c.height} in area ${a.width}x${a.height}`).toBe(true);
        // …in proportion.
        const expected = ratio === "landscape" ? 1280 / 720 : ratio === "square" ? 1 : 720 / 1280;
        expect(Math.abs(c.width / c.height - expected)).toBeLessThan(0.03);
      }
    });
  }

  test("the controls scroll on their own, and Make my meme stays in view with Advanced options open and Private chosen", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await signInThroughForm(page, PAID_ACCOUNT.email, TEST_ACCOUNT_PASSWORD);
    await openBuilder(page, 851);
    await expect(page.locator('[data-layout="wide"]')).toBeVisible();

    await page.getByTestId("meme-visibility-private").click();
    await page.getByTestId("adjust-text-trigger").click();
    await page.getByTestId("advanced-options-trigger").click();

    const scroller = page.getByTestId("builder-controls-scroll");
    const canvas = page.locator('canvas[aria-label="Meme preview"]');
    const before = await box(canvas);
    expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    // The preview did not move with the controls.
    const after = await box(canvas);
    expect(after.y).toBeCloseTo(before.y, 0);
    expect(after.height).toBeCloseTo(before.height, 0);

    // Make my meme is fully on screen, and the last control clears it.
    const action = page.getByTestId("wizard-primary-action");
    const actionBox = await box(action);
    expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(820 + 1);
    await expect(page.getByRole("button", { name: "Make my meme" })).toBeInViewport();
    const lastControl = scroller.locator(":scope > div > *").last();
    const lastBox = await box(lastControl);
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(actionBox.y + 1);
    // The action spans the controls column only, never the preview.
    const controlsCol = await box(page.getByTestId("builder-controls-column"));
    expect(actionBox.x).toBeGreaterThanOrEqual(controlsCol.x - 1);
  });

  for (const vp of NARROW_VIEWPORTS) {
    test(`${vp.name} (${vp.width}x${vp.height}) keeps the stacked layout with its resize handle`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await seedIdentity(page);
      await openBuilder(page, 852);
      await expect(page.locator('[data-layout="stacked"]')).toBeVisible();
      await expect(page.getByTestId("locked-preview-resize-handle")).toBeVisible();
      await expect(page.getByTestId("builder-controls-column")).toHaveCount(0);
      // The preview sits above the controls.
      const canvas = await box(page.locator('canvas[aria-label="Meme preview"]'));
      const controls = await box(page.getByTestId("builder-controls-scroll"));
      expect(canvas.y + canvas.height).toBeLessThanOrEqual(controls.y + 1);
    });
  }

  test("turning the screen keeps the choices made", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await seedIdentity(page);
    await openBuilder(page, 853);

    await page.getByTestId("aspect-portrait").click();
    await page.getByTestId("advanced-options-trigger").click();
    const colorButtons = page.getByRole("button", { name: /^Text color / });
    const chosen = colorButtons.nth(2);
    const chosenLabel = await chosen.getAttribute("aria-label");
    await chosen.click();
    await expect(chosen).toHaveClass(/border-\[#ff6b35\]/);

    await page.setViewportSize({ width: 820, height: 1180 });
    await expect(page.locator('[data-layout="stacked"]')).toBeVisible();
    await expect(page.getByTestId("aspect-portrait")).toHaveAttribute("aria-checked", "true");

    await page.setViewportSize({ width: 1180, height: 820 });
    await expect(page.locator('[data-layout="wide"]')).toBeVisible();
    await expect(page.getByTestId("aspect-portrait")).toHaveAttribute("aria-checked", "true");
    // The Advanced options sheet may have closed with the layout change; the colour is still the one chosen.
    if ((await page.getByTestId("advanced-options-trigger").getAttribute("aria-expanded")) !== "true") {
      await page.getByTestId("advanced-options-trigger").click();
    }
    await expect(page.getByRole("button", { name: chosenLabel! })).toHaveClass(/border-\[#ff6b35\]/);
  });

  test("the wide layout ignores the remembered preview height without erasing it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedIdentity(page);
    await page.addInitScript(() => window.localStorage.setItem("mbfo_locked_preview_max_h", "200"));
    await openBuilder(page, 854);

    const canvas = page.locator('canvas[aria-label="Meme preview"]');
    await expect(page.locator('[data-layout="wide"]')).toBeVisible();
    await expect.poll(async () => (await canvas.boundingBox())?.height ?? 0).toBeGreaterThan(400);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-layout="stacked"]')).toBeVisible();
    await expect.poll(async () => Math.round((await canvas.boundingBox())?.height ?? 0)).toBeLessThanOrEqual(200);
    expect(await page.evaluate(() => window.localStorage.getItem("mbfo_locked_preview_max_h"))).toBe("200");
  });
});
