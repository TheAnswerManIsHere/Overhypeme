/**
 * The name rule admits only letters every caption font draws (David,
 * 2026-11-02: no fallback fonts; names-and-fonts plan, 2026-11-03: the letters
 * are derived from the eleven caption faces). Two checks hold the rule to the
 * shipped files:
 *
 * - the pinned letters (`personalNameLetters.generated.ts`) equal the letters
 *   derived from the font files' own character maps, in both directions, so a
 *   supported letter can't be silently left out and an unsupported one can't
 *   be let in;
 * - every admitted character, and its uppercase (captions are usually drawn in
 *   capitals), is drawn in every face as something other than that face's
 *   missing-glyph box.
 *
 * @purpose Proves the name rule's letters equal those derived from the shipped caption fonts, and that every admitted character and its uppercase renders as a real glyph in every caption face.
 * @subsystem meme-studio
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";
import { CAPTION_FONTS, hasOnlyAllowedNameChars } from "@workspace/api-zod";
import { PERSONAL_NAME_LETTER_RANGES } from "../../../../lib/api-zod/src/personalNameLetters.generated";
import { deriveNameLetters } from "../lib/fontCoverage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fontDir = path.resolve(here, "..", "assets", "fonts");
const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

describe("the name rule and the caption fonts", () => {
  it("admits exactly the letters every caption face draws in both cases", () => {
    const derived = deriveNameLetters(CAPTION_FONTS.map((f) => fs.readFileSync(path.join(fontDir, f.file))));
    const pinned: number[] = [];
    for (const [a, b] of PERSONAL_NAME_LETTER_RANGES) for (let cp = a; cp <= b; cp++) pinned.push(cp);
    const missing = derived.filter((cp) => !pinned.includes(cp)).map(hex);
    const extra = pinned.filter((cp) => !derived.includes(cp)).map(hex);
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] },
      "the pinned letters differ from the fonts; run artifacts/api-server/scripts/derive-name-letters.ts");
  });

  it("every admitted character and its uppercase has a real glyph in every face", () => {
    const admitted: string[] = [];
    for (let cp = 0x21; cp <= 0x2ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (hasOnlyAllowedNameChars(ch)) admitted.push(ch);
    }
    assert.ok(admitted.length > 340, `checked ${admitted.length} admitted characters`);
    const bad: string[] = [];
    for (const font of CAPTION_FONTS) {
      const family = `Coverage ${font.id}`;
      assert.ok(GlobalFonts.registerFromPath(path.join(fontDir, font.file), family), `${font.file} registers`);
      const bitmap = (ch: string) => {
        const c = createCanvas(64, 64);
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, 64, 64);
        ctx.fillStyle = "#fff";
        ctx.font = `${font.weight} 36px "${family}"`;
        ctx.fillText(ch, 8, 48);
        return Buffer.from(ctx.getImageData(0, 0, 64, 64).data).toString("base64");
      };
      const missingGlyph = bitmap("\u{10FFFD}");
      const blank = bitmap(" ");
      for (const ch of admitted) {
        for (const form of new Set([ch, ch.toUpperCase()])) {
          const b = bitmap(form);
          if (b === missingGlyph || b === blank) bad.push(`${font.id}: ${form} (${Array.from(form, (c) => hex(c.codePointAt(0)!)).join(" ")})`);
        }
      }
    }
    assert.deepEqual(bad, [], `admitted but not drawn: ${bad.join(", ")}`);
  });
});
