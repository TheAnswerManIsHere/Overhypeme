/**
 * The caption fonts (names-and-fonts plan): every face in the shared catalogue
 * ships with the built server and with the web app as the same file, registers,
 * and draws differently from every other face; a new request can only name a
 * catalogue face; a stored recipe from before the catalogue renders byte for
 * byte as it did; and a face that failed to register refuses to render rather
 * than saving a meme in a fallback face.
 *
 * @purpose Proves each caption font ships to the server build and the web app as one identical file, registers and renders distinctly, that requests accept catalogue ids only while stored legacy font strings render exactly as before, and that an unregistered face refuses to render.
 * @subsystem meme-studio
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { CAPTION_FONTS, CAPTION_FONT_IDS } from "@workspace/api-zod";

import { captionCanvasFont, fontFileCandidates, generateMemeBuffer, withCaptionFontUnregisteredForTest, type TextOptions } from "../lib/memeGenerator.js";
import { StoredTextOptionsSchema, TextOptionsSchema } from "../lib/validators/memeBuilder.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const artifactDir = path.resolve(here, "..", "..");
const serverFonts = path.join(artifactDir, "src", "assets", "fonts");
const webFonts = path.resolve(artifactDir, "..", "overhype-me", "public", "fonts", "caption");

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

function background(): Buffer {
  const c = createCanvas(320, 320);
  const g = c.getContext("2d");
  g.fillStyle = "#336699";
  g.fillRect(0, 0, 320, 320);
  g.fillStyle = "#cc9933";
  g.fillRect(40, 40, 120, 200);
  return c.toBuffer("image/png");
}

const render = (opts: TextOptions) => generateMemeBuffer({ type: "image", imageData: background() }, "x", opts, "square");

describe("caption fonts", () => {
  it("each face is one file, identical on the server and in the web app, under src/assets where the build copies it", () => {
    for (const font of CAPTION_FONTS) {
      const server = path.join(serverFonts, font.file);
      assert.ok(fs.existsSync(server), `${font.file} is in src/assets/fonts`);
      assert.equal(sha(fs.readFileSync(path.join(webFonts, font.file))), sha(fs.readFileSync(server)), `${font.file} matches in the web app`);
      const [built] = fontFileCandidates(path.join(artifactDir, "dist"), font.file);
      assert.ok(!path.relative(path.join(artifactDir, "dist", "assets"), built!).startsWith(".."), "the built path is inside dist/assets");
    }
  });

  it("every face renders, and no two faces draw the same caption", async () => {
    const seen = new Map<string, string>();
    for (const font of CAPTION_FONTS) {
      const hash = sha(await render({ topText: "Zoë Nguyễn counted", bottomText: "to infinity twice", fontFamily: font.id }));
      assert.ok(!seen.has(hash), `${font.id} draws differently from ${seen.get(hash)}`);
      seen.set(hash, font.id);
    }
  });

  it("draws a catalogue face at its own fixed weight, whatever bold says", () => {
    for (const font of CAPTION_FONTS) {
      for (const bold of [true, false, undefined]) {
        assert.equal(captionCanvasFont({ fontFamily: font.id, bold }, 40), `${font.weight} 40px "${font.family}", sans-serif`);
      }
    }
  });

  it("a request names a catalogue face or nothing; a stored recipe may hold an old string", () => {
    for (const id of CAPTION_FONT_IDS) assert.ok(TextOptionsSchema.safeParse({ fontFamily: id }).success, id);
    assert.ok(TextOptionsSchema.safeParse({}).success);
    for (const bad of ["Impact", "'Bebas Neue', Impact, sans-serif", "OH Block", "Comic Sans MS"]) {
      assert.equal(TextOptionsSchema.safeParse({ fontFamily: bad }).success, false, `${bad} is refused on a request`);
      assert.ok(StoredTextOptionsSchema.safeParse({ fontFamily: bad }).success, `${bad} is kept on a stored recipe`);
    }
  });

  // Hashes recorded from the renderer before the catalogue existed (the same
  // recipes rendered at main 61a2d8b3). A stored recipe keeps its face.
  it("a stored recipe with an old font string, or none, renders byte for byte as before", async () => {
    assert.equal(sha(await render({ topText: "ZOË NGUYEN COUNTED", bottomText: "TO INFINITY TWICE" })),
      "fefb895da141aa8d4af764a8b5957a236c05f70f3744b68e0b7dea62e846b8b1");
    assert.equal(sha(await render({ topText: "ZOË NGUYEN COUNTED", bottomText: "TO INFINITY TWICE", fontFamily: "Impact" })),
      "fefb895da141aa8d4af764a8b5957a236c05f70f3744b68e0b7dea62e846b8b1");
    assert.equal(sha(await render({ topText: "Zoë counted", bottomText: "to infinity", fontFamily: "'Bebas Neue', Impact, sans-serif", bold: false, italic: true })),
      "038bd5fb718aa326d0a0edc2398998decdfb7ae3a60462ea235105c2d91bed96");
  });

  it("a face that did not register refuses to render instead of saving a fallback face", async () => {
    await withCaptionFontUnregisteredForTest("script", async () => {
      await assert.rejects(render({ topText: "Zoë", fontFamily: "script" }), /caption font "script" is not available/);
    });
    assert.ok((await render({ topText: "Zoë", fontFamily: "script" })).length > 0, "it renders once registered again");
  });
});
