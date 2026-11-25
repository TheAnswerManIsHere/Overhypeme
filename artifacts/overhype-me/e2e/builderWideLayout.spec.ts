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

  // Issue #850, amendment 1 (Q31: 1): whichever arrangement shows the picture
  // larger wins. A big iPad held upright stacks a landscape picture (much
  // wider there) and puts a portrait one beside the controls.
  test("big iPad upright: a landscape picture stacks and spans the width, a portrait one goes side by side", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 1366 });
    await seedIdentity(page);
    await openBuilder(page, 856);
    const canvas = page.locator('canvas[aria-label="Meme preview"]');

    await page.getByTestId("aspect-landscape").click();
    await expect(page.locator('[data-layout="stacked"]')).toBeVisible();
    await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(900);

    await page.getByTestId("aspect-portrait").click();
    await expect(page.locator('[data-layout="wide"]')).toBeVisible();
    // Side by side, it fills its area's width or its height.
    await expect.poll(async () => {
      const a = await page.getByTestId("locked-preview-area").boundingBox();
      const c = await canvas.boundingBox();
      if (!a || !c) return false;
      return a.width - c.width <= 4 || a.height - c.height <= 4;
    }).toBe(true);
  });

  // Astra C7 on amendment 1: a large remembered height is the same height the
  // layout choice used and the stacked preview draws, across a resize.
  test("a large remembered preview height: stacked on a big upright iPad, side by side on a desktop, still stored", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 1366 });
    await seedIdentity(page);
    await page.addInitScript(() => window.localStorage.setItem("mbfo_locked_preview_max_h", "700"));
    await openBuilder(page, 857);
    const canvas = page.locator('canvas[aria-label="Meme preview"]');
    await page.getByTestId("aspect-landscape").click();
    await expect(page.locator('[data-layout="stacked"]')).toBeVisible();
    await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(900);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('[data-layout="wide"]')).toBeVisible();
    // Stacked at 1440×900 would cap the remembered 700 to 468 px tall (52%),
    // about 832 px wide; side by side shows it wider, so side by side wins.
    await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(840);
    expect(await page.evaluate(() => window.localStorage.getItem("mbfo_locked_preview_max_h"))).toBe("700");
  });

  // Codex F1 on PR #1258: a remembered height read on a short screen comes
  // back in full when the screen grows, without reopening the builder.
  test("a remembered preview height read on a short screen returns in full when the screen grows", async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 844 });
    await seedIdentity(page);
    await page.addInitScript(() => window.localStorage.setItem("mbfo_locked_preview_max_h", "700"));
    await openBuilder(page, 859);
    const canvas = page.locator('canvas[aria-label="Meme preview"]');
    const canvasHeight = async () => (await canvas.boundingBox())?.height ?? 0;
    await page.getByTestId("aspect-portrait").click();
    await expect(page.locator('[data-layout="stacked"]')).toBeVisible();
    // 52% of 844 is 438 px: the screen's limit, not the remembered 700.
    await expect.poll(canvasHeight).toBeLessThan(440);
    await page.setViewportSize({ width: 600, height: 1400 });
    await expect.poll(canvasHeight).toBeGreaterThan(690);
    await page.setViewportSize({ width: 600, height: 844 });
    await expect.poll(canvasHeight).toBeLessThan(440);

    // Codex's example: opened side by side on a desktop, then made taller, the
    // landscape picture stacks at the remembered 700 px, wider than the 970 px
    // side by side would give.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId("aspect-landscape").click();
    await expect(page.locator('[data-layout="wide"]')).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Make my meme" })).toBeVisible();
    await page.getByTestId("aspect-landscape").click();
    await expect(page.locator('[data-layout="wide"]')).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1600 });
    await expect(page.locator('[data-layout="stacked"]')).toBeVisible();
    await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(1100);
    expect(await page.evaluate(() => window.localStorage.getItem("mbfo_locked_preview_max_h"))).toBe("700");
  });

  // Codex F2 on PR #1258: the stacked canvas stops at its own 1280 px, so
  // the layout choice counts that ceiling. Where it binds, side by side wins.
  test("on a very large upright screen the stacked picture stops at 1280 px, and the choice counts that", async ({ page }) => {
    await seedIdentity(page);
    await page.setViewportSize({ width: 1600, height: 2400 });
    await openBuilder(page, 860);
    const canvas = page.locator('canvas[aria-label="Meme preview"]');
    await page.getByTestId("aspect-landscape").click();
    // Side by side would be 1130 px; stacked is capped at the canvas's 1280.
    await expect(page.locator('[data-layout="stacked"]')).toBeVisible();
    await expect.poll(async () => Math.round((await canvas.boundingBox())?.width ?? 0)).toBe(1280);

    // At 1920 wide, stacked would still be 1280 but side by side gives 1450.
    await page.setViewportSize({ width: 1920, height: 2400 });
    await expect(page.locator('[data-layout="wide"]')).toBeVisible();
    await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(1400);
  });

  // David, 2026-11-24: a phone held sideways is too short to stack; the
  // picture goes beside the controls, for every shape.
  test("a phone on its side puts the picture beside the controls for every shape", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await seedIdentity(page);
    await openBuilder(page, 858);
    for (const r of ["landscape", "square", "portrait"]) {
      await page.getByTestId(`aspect-${r}`).click();
      await expect(page.locator('[data-layout="wide"]')).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Make my meme" })).toBeInViewport();
  });

  test("turning the screen keeps the choices made", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await seedIdentity(page);
    await openBuilder(page, 853);

    await page.getByTestId("aspect-square").click();
    await page.getByTestId("advanced-options-trigger").click();
    const colorButtons = page.getByRole("button", { name: /^Text color / });
    const chosen = colorButtons.nth(2);
    const chosenLabel = await chosen.getAttribute("aria-label");
    await chosen.click();
    await expect(chosen).toHaveClass(/border-\[#ff6b35\]/);

    await page.setViewportSize({ width: 820, height: 1180 });
    await expect(page.locator('[data-layout="stacked"]')).toBeVisible();
    await expect(page.getByTestId("aspect-square")).toHaveAttribute("aria-checked", "true");

    await page.setViewportSize({ width: 1180, height: 820 });
    await expect(page.locator('[data-layout="wide"]')).toBeVisible();
    await expect(page.getByTestId("aspect-square")).toHaveAttribute("aria-checked", "true");
    // The Advanced options panel stayed open through both turns, and the colour is still the one chosen.
    await expect(page.getByTestId("advanced-options-trigger")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("button", { name: chosenLabel! })).toHaveClass(/border-\[#ff6b35\]/);
  });

  // PR #1252's build report: turning the screen must not rebuild the builder's
  // parts, or a photo still uploading would be lost with its panel.
  test("turning the screen rebuilds nothing: the photo panel and an open options panel are the same elements", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await seedIdentity(page);
    await openBuilder(page, 855);
    await page.getByTestId("advanced-options-trigger").click();

    const photoPanel = await page.getByText("Sign up or sign in to make a meme with your photo").elementHandle();
    const optionsTrigger = await page.getByTestId("advanced-options-trigger").elementHandle();
    const controlsScroll = await page.getByTestId("builder-controls-scroll").elementHandle();
    expect(photoPanel && optionsTrigger && controlsScroll).toBeTruthy();

    await page.setViewportSize({ width: 820, height: 1180 });
    await expect(page.locator('[data-layout="stacked"]')).toBeVisible();
    await page.setViewportSize({ width: 1180, height: 820 });
    await expect(page.locator('[data-layout="wide"]')).toBeVisible();

    for (const el of [photoPanel!, optionsTrigger!, controlsScroll!]) {
      expect(await el.evaluate((node) => node.isConnected)).toBe(true);
    }
    await expect(page.getByTestId("advanced-options-trigger")).toHaveAttribute("aria-expanded", "true");
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
