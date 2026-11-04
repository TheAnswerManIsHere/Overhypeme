/**
 * #870: a saved meme did not look like the builder's preview — a different
 * crop, different caption line breaks, the name in white instead of orange,
 * and an orange bar, a darkening wash and ghost "OM" letters the preview
 * never drew — because the server had its own renderer, written separately.
 * Both now call one drawing (`drawMeme`, `@workspace/api-zod`). These tests
 * hold the saved file equal to that drawing given the inputs the preview
 * passes it (`LivePreview.tsx`), and pin the three decorations out.
 *
 * @purpose Proves the server's meme render is pixel-for-pixel the shared preview drawing for the same recipe (crop, framing, caption, name colour, watermark), and that no orange bar, wash or ghost letters are drawn.
 * @subsystem meme-studio
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import sharp from "sharp";
import {
  MEME_CANVAS_DIMS,
  WATERMARK_FONT_ID,
  captionFontById,
  captionFontStack,
  drawMeme,
  memeCaption,
  renderTemplateSegments,
  renderTemplateWithIdentityForms,
  resolveIdentityForms,
  type MemeCanvasContext,
} from "@workspace/api-zod";

import { generateMemeBuffer } from "../lib/memeGenerator.js";
import { storedMemeCaption } from "../lib/memeComposite.js";

/** A photo of four solid quadrants, so a crop or pan difference moves colour boundaries. */
function quadrantsJpeg(w: number, h: number): Buffer {
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  const fills = ["#204060", "#406020", "#602040", "#606060"];
  ctx.fillStyle = fills[0]!; ctx.fillRect(0, 0, w / 2, h / 2);
  ctx.fillStyle = fills[1]!; ctx.fillRect(w / 2, 0, w / 2, h / 2);
  ctx.fillStyle = fills[2]!; ctx.fillRect(0, h / 2, w / 2, h / 2);
  ctx.fillStyle = fills[3]!; ctx.fillRect(w / 2, h / 2, w / 2, h / 2);
  return c.toBuffer("image/png");
}

/** What the preview draws for this recipe: LivePreview's inputs to `drawMeme`, on a canvas at logical size. */
async function previewJpeg(args: {
  photo: Buffer;
  template: string;
  textOptions: { topText?: string; bottomText?: string; topY?: number; bottomY?: number; fontFamily: "block" };
  name: string;
  pronouns: string;
  framing: { x: number; y: number };
}): Promise<Buffer> {
  const dims = MEME_CANVAS_DIMS.landscape;
  const canvas = createCanvas(dims.w, dims.h);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const img = await loadImage(args.photo);
  const caption = captionFontById(args.textOptions.fontFamily);
  const watermark = captionFontById(WATERMARK_FONT_ID);
  drawMeme(ctx as unknown as MemeCanvasContext, {
    image: img,
    drawImage: (image, x, y, w, h) => ctx.drawImage(image, x, y, w, h),
    aspectRatio: "landscape",
    framingOffset: args.framing,
    caption: memeCaption(args.template, args.textOptions, args.name, args.pronouns),
    style: args.textOptions,
    captionFont: (size) => `normal ${caption.weight} ${size}px ${captionFontStack(caption)}`,
    watermarkFont: (size) => `${watermark.weight} ${size}px ${captionFontStack(watermark)}`,
  });
  return canvas.toBuffer("image/jpeg", 90);
}

async function raw(buf: Buffer) {
  return sharp(buf).raw().toBuffer({ resolveWithObject: true });
}

describe("#870: the saved meme is the preview", () => {
  // A photo exactly the logical width and taller, so the server draws at
  // logical size and the pan has room to move.
  const photo = quadrantsJpeg(1280, 960);
  const template = "{NAME} doesn't wear a watch. {Subj} decides what time it is.";
  const textOptions = {
    topText: "{NAME} doesn't wear a watch.",
    bottomText: "{Subj} decides what time it is.",
    topY: 17,
    bottomY: 88,
    fontFamily: "block" as const,
  };
  const framing = { x: 0, y: -80 };

  it("the server's file is pixel-identical to the preview's drawing of the same recipe", async () => {
    const saved = await generateMemeBuffer(
      { type: "image", imageData: photo },
      "unused: the caption below wins",
      textOptions,
      "landscape",
      { offsetX: framing.x, offsetY: framing.y },
      storedMemeCaption({ text: template, canonicalText: null }, { displayName: "David Franklin", pronouns: "he/him" }, textOptions),
    );
    const preview = await previewJpeg({ photo, template, textOptions, name: "David Franklin", pronouns: "he/him", framing });

    const a = await raw(saved);
    const b = await raw(preview);
    assert.equal(a.info.width, b.info.width);
    assert.equal(a.info.height, b.info.height);
    assert.ok(a.data.equals(b.data), "saved and preview pixels differ");
  });

  it("draws the name in the name colour", async () => {
    const saved = await generateMemeBuffer(
      { type: "image", imageData: photo },
      "",
      { ...textOptions, textEffect: "none" },
      "landscape",
      null,
      storedMemeCaption({ text: template, canonicalText: null }, { displayName: "David Franklin", pronouns: "he/him" }, textOptions),
    );
    const { data, info } = await raw(saved);
    let orange = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const [r, g, b] = [data[i]!, data[i + 1]!, data[i + 2]!];
      if (r > 220 && g > 80 && g < 140 && b < 90) orange++;
    }
    assert.ok(orange > 500, `the name is drawn orange (${orange} orange pixels)`);
  });

  it("draws no orange bar, darkening wash or ghost letters over the photo", async () => {
    const grey = (() => {
      const c = createCanvas(1280, 720);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#808080";
      ctx.fillRect(0, 0, 1280, 720);
      return c.toBuffer("image/png");
    })();
    // No caption at all: whatever is drawn over the photo is decoration.
    const saved = await generateMemeBuffer(
      { type: "image", imageData: grey },
      "",
      { topText: "", bottomText: "" },
      "landscape",
    );
    const { data, info } = await raw(saved);
    const px = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    };
    for (const [x, y] of [[4, 360], [6, 100], [640, 360], [1100, 500], [1200, 400]] as const) {
      const [r, g, b] = px(x, y);
      for (const c of [r, g, b]) assert.ok(Math.abs(c - 128) <= 3, `pixel (${x},${y}) is the photo's grey, got ${r},${g},${b}`);
    }
  });
});

describe("#870: caption runs are the renderer's words", () => {
  const templates = [
    "{NAME} doesn't wear a watch. {Subj} decides what time it is.",
    "a {NAME} {keeps|keep} {POSS} promises to {OBJ}.",
    "An {NAME} beat {REFL}; {NAME_POSSESSIVE} fame is {POSS_PRO}.",
    "Nobody is named here, {but|and} set {a, b} stays.",
    "",
  ];
  for (const pronouns of ["he/him", "she/her", "they/them", "xe|xem|xyr|xyrs|xemself|s"]) {
    for (const name of ["David Franklin", "Ana"]) {
      it(`joins to renderTemplateWithIdentityForms (${name}, ${pronouns})`, () => {
        const forms = resolveIdentityForms(name, pronouns);
        for (const t of templates) {
          const runs = renderTemplateSegments(t, forms);
          assert.equal(runs.map((r) => r.text).join(""), renderTemplateWithIdentityForms(t, forms), t);
          for (const r of runs) if (r.isName) assert.ok(r.text === name || r.text === `${name}'s`, r.text);
        }
      });
    }
  }
});
