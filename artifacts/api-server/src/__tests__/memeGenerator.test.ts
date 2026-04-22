import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import sharp from "sharp";
import { generateMemeBuffer, MEME_TEMPLATES } from "../lib/memeGenerator.ts";
import { MEME_ASPECT_RATIOS, type MemeAspectRatio } from "@workspace/api-zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, "../assets/meme-templates");

/** Build a synthetic JPEG buffer at the requested resolution. */
function makeSyntheticJpeg(width: number, height: number): Buffer {
  const c = createCanvas(width, height);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#aabbcc";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(width * 0.4, height * 0.4, width * 0.2, height * 0.2);
  return c.toBuffer("image/jpeg", 0.9);
}

const ASPECTS: MemeAspectRatio[] = ["landscape", "square", "portrait"];

for (const aspect of ASPECTS) {
  test(`generateMemeBuffer template render honours ${aspect} aspect ratio`, async () => {
    const buf = await generateMemeBuffer(
      { type: "template", templateId: "action" },
      "Test fact",
      { topText: "TOP", bottomText: "BOTTOM" },
      aspect,
    );
    const meta = await sharp(buf).metadata();
    assert.equal(meta.format, "jpeg");
    assert.ok(meta.width && meta.height, "must have dimensions");
    const expected = MEME_ASPECT_RATIOS[aspect];
    const actualRatio = meta.width! / meta.height!;
    const expectedRatio = expected.w / expected.h;
    // Allow ±0.5% drift for integer rounding.
    assert.ok(
      Math.abs(actualRatio - expectedRatio) / expectedRatio < 0.005,
      `aspect ratio ${actualRatio} should match ${expectedRatio} for ${aspect}`,
    );
  });

  test(`generateMemeBuffer photo render at source resolution for ${aspect}`, async () => {
    // Source 4000x3000 (4:3); centre-cropped to logical aspect, output should
    // match logical aspect at the cropped source resolution.
    const photo = makeSyntheticJpeg(4000, 3000);
    const buf = await generateMemeBuffer(
      { type: "image", imageData: photo },
      "Test fact",
      undefined,
      aspect,
    );
    const meta = await sharp(buf).metadata();
    assert.equal(meta.format, "jpeg");
    assert.ok(meta.width && meta.height);
    const expected = MEME_ASPECT_RATIOS[aspect];
    const actualRatio = meta.width! / meta.height!;
    const expectedRatio = expected.w / expected.h;
    assert.ok(
      Math.abs(actualRatio - expectedRatio) / expectedRatio < 0.005,
      `${aspect}: ratio ${actualRatio} drifted from ${expectedRatio}`,
    );
    // Output must have meaningful resolution (≥ logical units × some scale).
    assert.ok(meta.width! >= expected.w, `${aspect}: width ${meta.width} below logical ${expected.w}`);
    assert.ok(meta.height! >= expected.h, `${aspect}: height ${meta.height} below logical ${expected.h}`);
  });
}

test("generateMemeBuffer caps photo render at MAX_PHOTO_RENDER_PX longest edge", async () => {
  // Provide an oversized 8000x4500 photo (16:9 already) — output longest edge
  // should be capped at 6000.
  const photo = makeSyntheticJpeg(8000, 4500);
  const buf = await generateMemeBuffer(
    { type: "image", imageData: photo },
    "Test fact",
    undefined,
    "landscape",
  );
  const meta = await sharp(buf).metadata();
  const longest = Math.max(meta.width!, meta.height!);
  assert.ok(longest <= 6000, `longest edge ${longest} exceeded cap`);
  assert.ok(longest >= 5800, `longest edge ${longest} unexpectedly small (cap should be ~6000)`);
});

test("every template has an asset PNG present in all 3 aspect subfolders", () => {
  for (const template of MEME_TEMPLATES) {
    for (const aspect of ASPECTS) {
      const assetPath = path.join(TEMPLATES_DIR, aspect, template.assetPath);
      assert.ok(
        existsSync(assetPath),
        `missing template asset for "${template.id}" / ${aspect} at ${assetPath}`,
      );
    }
  }
});

test("generateMemeBuffer defaults to landscape when aspectRatio omitted", async () => {
  const buf = await generateMemeBuffer(
    { type: "template", templateId: "action" },
    "Test fact",
  );
  const meta = await sharp(buf).metadata();
  const ratio = meta.width! / meta.height!;
  const expected = MEME_ASPECT_RATIOS.landscape.w / MEME_ASPECT_RATIOS.landscape.h;
  assert.ok(Math.abs(ratio - expected) / expected < 0.005);
});
