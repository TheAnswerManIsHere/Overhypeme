/**
 * The meme font has to ship with the built server. The build copies
 * `src/assets` into `dist/assets` (`build.mjs`), and the bundle resolves the
 * font from `dist/`. Until 2026-11-01 the font sat in `src/lib/assets/`, which
 * the build never copies: the Repl's build had no `dist/assets/fonts` at all,
 * so built servers drew every caption in a fallback face while the source
 * tree, where tests run, found the font and looked fine.
 *
 * @purpose Proves the renderer's built-layout font path points at a file the build copies (under src/assets), that the source-tree path finds the same file, and that Anton actually registers so captions do not fall back to a system face.
 * @subsystem meme-studio
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";

import { fontFileCandidates, generateMemeBuffer } from "../lib/memeGenerator.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const artifactDir = path.resolve(here, "..", "..");
const srcAssets = path.join(artifactDir, "src", "assets");
const distDir = path.join(artifactDir, "dist");

describe("meme font packaging", () => {
  it("the built layout's font path is a file the build copies from src/assets", () => {
    const [built] = fontFileCandidates(distDir, "Anton-Regular.ttf");
    const underDistAssets = path.relative(path.join(distDir, "assets"), built!);
    assert.ok(!underDistAssets.startsWith(".."), `built candidate ${built} is inside dist/assets`);
    const source = path.join(srcAssets, underDistAssets);
    assert.ok(fs.existsSync(source), `the build copies ${source} into dist/assets; it must exist`);
  });

  it("the source-tree path finds the same file", () => {
    const candidates = fontFileCandidates(path.join(artifactDir, "src", "lib"), "Anton-Regular.ttf");
    assert.ok(candidates.some((c) => fs.existsSync(c)), `one of ${candidates.join(", ")} exists`);
  });

  it("Anton registers once a meme renders", async () => {
    const c = createCanvas(200, 200);
    c.getContext("2d").fillRect(0, 0, 200, 200);
    await generateMemeBuffer({ type: "image", imageData: c.toBuffer("image/jpeg") }, "WORDS", { topText: "WORDS" }, "square");
    assert.ok(GlobalFonts.has("Anton"), "Anton is registered");
  });
});
