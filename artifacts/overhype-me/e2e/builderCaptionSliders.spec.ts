/**
 * Issue #1260 — in the builder, the top and bottom caption blocks could be
 * drawn over each other, and the position sliders stopped at limits that had
 * nothing to do with where the text was (David's iPad, portrait, the pushups
 * fact: top slider at its limit reading 51%, bottom at its limit reading 72%,
 * the blocks colliding).
 *
 * In a real browser, with the real caption face: wherever the two position
 * sliders are put, in every ratio and at the smallest and largest font size,
 * the preview shows every caption line whole and separate — none cut by the
 * top or bottom edge, none drawn over another — and a slider's ends are
 * where its block stops moving.
 */
import { expect, test, type Page } from "@playwright/test";
import { factDetail, stubPublicFacts } from "./helpers/apiStubs";
import { seedIdentity } from "./helpers/identity";

const FACT_TEXT = "When {NAME} does pushups, {SUBJ} doesn't push {REFL} up – {Subj} pushes the Earth down.";
const RATIOS = ["portrait", "square", "landscape"] as const;

/**
 * The preview's caption ink, read from the canvas's middle columns (clear of
 * the watermark): the bands of rows holding caption-coloured pixels, and the
 * canvas height. Each caption line is one band; lines drawn over each other
 * merge into one.
 */
async function inkBands(page: Page): Promise<{ bands: { from: number; to: number }[]; height: number }> {
  return page.locator('canvas[aria-label="Meme preview"]').evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const x0 = Math.floor(canvas.width * 0.2);
    const w = Math.floor(canvas.width * 0.6);
    const { data } = ctx.getImageData(x0, 0, w, canvas.height);
    const bands: { from: number; to: number }[] = [];
    let open: { from: number; to: number } | null = null;
    for (let y = 0; y < canvas.height; y++) {
      let ink = false;
      for (let x = 0; x < w && !ink; x++) {
        const i = (y * w + x) * 4;
        const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
        // White text, or the name's orange; the backdrop is #111 and the outline black.
        ink = (r > 200 && g > 200 && b > 200) || (r > 200 && g > 80 && g < 160 && b < 90);
      }
      if (ink) {
        if (open) open.to = y;
        else bands.push((open = { from: y, to: y }));
      } else open = null;
    }
    return { bands, height: canvas.height };
  });
}

async function setSlider(page: Page, index: number, end: "Home" | "End"): Promise<void> {
  const slider = page.getByRole("slider").nth(index);
  await slider.focus();
  await page.keyboard.press(end);
}

const valueOf = async (page: Page, index: number) => Number(await page.getByRole("slider").nth(index).getAttribute("aria-valuenow"));

test.describe("Meme builder caption position sliders (Issue #1260)", () => {
  test("wherever the sliders are put, every caption line is whole and separate, in every ratio and font size", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await seedIdentity(page, "David Franklin", "he/him");
    await stubPublicFacts(page, { facts: [factDetail({ id: 1260, text: FACT_TEXT })] });
    await page.goto("/facts/1260/meme");
    await expect(page.getByRole("button", { name: "Make my meme" })).toBeVisible();
    await expect(page.locator('canvas[aria-label="Meme preview"]')).toHaveAttribute("data-caption-font-status", "ready");
    await page.getByTestId("adjust-text-trigger").click();
    await page.getByTestId("advanced-options-trigger").click();
    // Sliders, in page order: split, top position, bottom position, font size.
    await expect(page.getByRole("slider")).toHaveCount(4);
    const TOP = 1, BOTTOM = 2, FONT = 3;

    for (const fontEnd of [null, "Home", "End"] as const) {
      if (fontEnd) await setSlider(page, FONT, fontEnd);
      for (const ratio of RATIOS) {
        await page.getByTestId(`aspect-${ratio}`).click();
        await expect(page.getByTestId(`aspect-${ratio}`)).toHaveAttribute("aria-checked", "true");
        // The line count with the blocks as far apart as they go: nothing can overlap there.
        await setSlider(page, TOP, "Home");
        await setSlider(page, BOTTOM, "End");
        await page.waitForTimeout(150);
        const apart = await inkBands(page);
        const lines = apart.bands.length;
        expect(lines, `${ratio}, font ${fontEnd ?? "default"}: the caption is drawn`).toBeGreaterThanOrEqual(2);

        for (const [topEnd, bottomEnd] of [["Home", "End"], ["End", "End"], ["Home", "Home"], ["End", "Home"], ["Home", "Home"]] as const) {
          await setSlider(page, TOP, topEnd);
          await setSlider(page, BOTTOM, bottomEnd);
          await page.waitForTimeout(150);
          const where = `${ratio}, font ${fontEnd ?? "default"}, top slider at ${topEnd}, bottom slider at ${bottomEnd}`;
          const { bands, height } = await inkBands(page);
          expect(bands.length, `${where}: every line separate (lines drawn over each other merge)`).toBe(lines);
          expect(bands[0]!.from, `${where}: nothing cut by the top edge`).toBeGreaterThan(0);
          expect(bands[bands.length - 1]!.to, `${where}: nothing cut by the bottom edge`).toBeLessThan(height - 1);
          // A slider shows a position inside its own range.
          for (const s of [TOP, BOTTOM]) {
            const slider = page.getByRole("slider").nth(s);
            const now = await valueOf(page, s);
            expect(now).toBeGreaterThanOrEqual(Number(await slider.getAttribute("aria-valuemin")));
            expect(now).toBeLessThanOrEqual(Number(await slider.getAttribute("aria-valuemax")));
          }
        }
      }
    }
  });

  test("moving a slider moves its block from the first step, and the other block stays where it is", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await seedIdentity(page, "David Franklin", "he/him");
    await stubPublicFacts(page, { facts: [factDetail({ id: 1261, text: FACT_TEXT })] });
    await page.goto("/facts/1261/meme");
    await expect(page.locator('canvas[aria-label="Meme preview"]')).toHaveAttribute("data-caption-font-status", "ready");
    await page.getByTestId("aspect-portrait").click();
    await page.getByTestId("adjust-text-trigger").click();
    await expect(page.getByRole("slider")).toHaveCount(3);
    await page.waitForTimeout(150);

    const before = await inkBands(page);
    const topLines = before.bands.length - 2; // the bottom half is two lines in portrait
    // The top block starts at its slider's upper end: the five-line block cannot sit at the 17% default.
    expect(await valueOf(page, 1)).toBe(Number(await page.getByRole("slider").nth(1).getAttribute("aria-valuemin")));
    await page.getByRole("slider").nth(1).focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
    const after = await inkBands(page);
    expect(after.bands[0]!.from, "one step on the top slider moves the top block down").toBeGreaterThan(before.bands[0]!.from);
    expect(after.bands[topLines]!.from, "the bottom block did not move").toBe(before.bands[topLines]!.from);
  });
});
