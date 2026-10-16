/**
 * Captures for PR398 (the meme split caption personalisation UAT): the live
 * preview and the saved picture for each split, the text styling and framing
 * of finished memes per aspect ratio, and the caption at two position-slider
 * settings. Claude reads each shot against its step's Expect at run time; this
 * spec proves the shots can be produced, plus the facts a machine can state
 * outright (a ratio's output dimensions, the download's bytes).
 *
 * The fact is the fixture's "Firearms carry {NAME} for protection." — five
 * words with the name third, so split 2 puts the name in the bottom line and
 * split 3 in the top one. The free test account's display name is the name
 * drawn.
 */
import { test, expect } from "@playwright/test";
import {
  extOf,
  factIdByText,
  imageSize,
  openBuilderWithPhoto,
  previewShot,
  saveMeme,
  saveShot,
  setSlider,
  ensureFreeSession,
  FREE_SESSION,
} from "./captureKit";

const DOC = "PR398_MEME_SPLIT_CAPTION_PERSONALIZATION_UAT";
const FACT = "Firearms carry {NAME} for protection.";
const SPLIT = { min: 1, max: 4 };

test.describe.configure({ mode: "serial" });
// Tall enough that every builder control sits above the fixed action bar, so a
// click on a slider track lands on the track.
test.use({ viewport: { width: 1280, height: 1600 } });

test.beforeAll(async ({ browser }, info) => {
  await ensureFreeSession(browser, String(info.project.use.baseURL));
});
test.use({ storageState: FREE_SESSION });

test("the default split: preview and saved picture (step 3)", async ({ page }) => {
  const factId = await factIdByText(page.request, FACT);
  await openBuilderWithPhoto(page, factId);
  saveShot("pr398-s3-preview", await previewShot(page), { doc: DOC, step: "3", shows: "the builder preview at the default split" });
  const saved = await saveMeme(page);
  saveShot("pr398-s3-saved", saved.picture, { doc: DOC, step: "3", shows: "the finished meme picture at the default split" }, extOf(saved.contentType));
});

test("name in the bottom line, then moved to the top line (steps 4 and 5)", async ({ page }) => {
  const factId = await factIdByText(page.request, FACT);
  await openBuilderWithPhoto(page, factId);
  const split = page.getByRole("slider").first();
  await setSlider(split, 2, SPLIT.min, SPLIT.max);
  await expect(page.getByText("2 / 5")).toBeVisible();
  saveShot("pr398-s4-preview", await previewShot(page), { doc: DOC, step: "4", shows: "the builder preview with the split before the name" });
  await setSlider(split, 3, SPLIT.min, SPLIT.max);
  await expect(page.getByText("3 / 5")).toBeVisible();
  saveShot("pr398-s5-preview", await previewShot(page), { doc: DOC, step: "5", shows: "the builder preview with the split after the name" });
  const saved = await saveMeme(page);
  saveShot("pr398-s5-saved", saved.picture, { doc: DOC, step: "5", shows: "the finished meme picture saved with the split after the name" }, extOf(saved.contentType));
});

test("name in the bottom line, saved (step 4)", async ({ page }) => {
  const factId = await factIdByText(page.request, FACT);
  await openBuilderWithPhoto(page, factId);
  await setSlider(page.getByRole("slider").first(), 2, SPLIT.min, SPLIT.max);
  await expect(page.getByText("2 / 5")).toBeVisible();
  const saved = await saveMeme(page);
  saveShot("pr398-s4-saved", saved.picture, { doc: DOC, step: "4", shows: "the finished meme picture saved with the split before the name" }, extOf(saved.contentType));
});

test("the downloaded file is the page's picture (step 8)", async ({ page }) => {
  const factId = await factIdByText(page.request, FACT);
  await openBuilderWithPhoto(page, factId);
  const saved = await saveMeme(page);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /download/i }).first().click();
  const file = await (await download).path();
  const { readFileSync } = await import("node:fs");
  const bytes = readFileSync(file!);
  expect(bytes.equals(saved.picture), "the downloaded file must be byte-identical to the meme's served picture").toBe(true);
  saveShot("pr398-s8-download", bytes, { doc: DOC, step: "8", shows: "the file the Download button saved" }, extOf(saved.contentType));
});

for (const ratio of [
  { id: "landscape", label: "Landscape 16:9", w: 16, h: 9 },
  { id: "square", label: "Square 1:1", w: 1, h: 1 },
  { id: "portrait", label: "Portrait 9:16", w: 9, h: 16 },
]) {
  test(`a finished meme at ${ratio.label} (R1, R3)`, async ({ page }) => {
    const factId = await factIdByText(page.request, FACT);
    await openBuilderWithPhoto(page, factId);
    await page.getByTestId(`aspect-${ratio.id}`).click();
    await expect(page.getByTestId(`aspect-${ratio.id}`)).toHaveAttribute("aria-checked", "true");
    const saved = await saveMeme(page);
    const meta = imageSize(saved.picture);
    expect(meta.width! * ratio.h, `${ratio.label} output is ${meta.width}x${meta.height}`).toBeCloseTo(meta.height! * ratio.w, -2);
    saveShot(`pr398-r3-${ratio.id}`, saved.picture, { doc: DOC, step: "R1, R3", shows: `a finished photo meme at ${ratio.label}, ${meta.width}x${meta.height}` }, extOf(saved.contentType));
  });
}

test("the caption at two position-slider settings (R2)", async ({ page }) => {
  const factId = await factIdByText(page.request, FACT);
  await openBuilderWithPhoto(page, factId);
  const top = page.getByRole("slider").nth(1);
  const before = Number(await top.getAttribute("aria-valuenow"));
  saveShot("pr398-r2-preview-default", await previewShot(page), { doc: DOC, step: "R2", shows: `the preview with the top line at its default position (${before}%)` });
  await setSlider(top, 45, Number(await top.getAttribute("aria-valuemin")), Number(await top.getAttribute("aria-valuemax")));
  const after = Number(await top.getAttribute("aria-valuenow"));
  expect(after, "the top-position slider moved").toBeGreaterThan(before + 10);
  saveShot("pr398-r2-preview-moved", await previewShot(page), { doc: DOC, step: "R2", shows: `the preview with the top line moved to ${after}%` });
  const saved = await saveMeme(page);
  saveShot("pr398-r2-saved-moved", saved.picture, { doc: DOC, step: "R2", shows: `the finished picture saved with the top line at ${after}%` }, extOf(saved.contentType));
});
