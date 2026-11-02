/**
 * The name rule admits only characters the meme font draws (David,
 * 2026-11-02: English-script names only, no fallback fonts). This draws every
 * character the rule admits in Anton and compares it with the missing-glyph
 * box, so a widened rule that admits a character Anton lacks fails here.
 *
 * @purpose Proves every character the shared name rule admits renders as a real glyph in the bundled Anton font rather than as the missing-glyph box.
 * @subsystem meme-studio
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";
import { hasOnlyAllowedNameChars } from "@workspace/api-zod";

const here = path.dirname(fileURLToPath(import.meta.url));
GlobalFonts.registerFromPath(path.resolve(here, "..", "assets", "fonts", "Anton-Regular.ttf"), "AntonCoverage");

function bitmap(ch: string): string {
  const c = createCanvas(48, 48);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 48, 48);
  ctx.fillStyle = "#fff";
  ctx.font = "32px AntonCoverage";
  ctx.fillText(ch, 8, 38);
  return Buffer.from(ctx.getImageData(0, 0, 48, 48).data).toString("base64");
}

describe("the name rule and the meme font", () => {
  it("every admitted letter and digit has a glyph in Anton", () => {
    const missing = bitmap("\u{10FFFD}");
    const blank = bitmap(" ");
    const bad: string[] = [];
    let checked = 0;
    for (let cp = 0x21; cp <= 0x24f; cp++) {
      const ch = String.fromCodePoint(cp);
      if (!hasOnlyAllowedNameChars(ch)) continue;
      checked++;
      const b = bitmap(ch);
      if (b === missing || b === blank) bad.push(`U+${cp.toString(16).toUpperCase().padStart(4, "0")} ${ch}`);
    }
    assert.ok(checked > 180, `checked ${checked} admitted characters`);
    assert.deepEqual(bad, [], `admitted but not drawn by Anton: ${bad.join(", ")}`);
  });
});
