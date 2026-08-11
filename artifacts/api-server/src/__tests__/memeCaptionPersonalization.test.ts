/**
 * Regression tests for the split-caption personalization bug.
 *
 * The studio's split slider cuts the **raw fact template** into
 * `textOptions.topText` / `textOptions.bottomText` and persists both on the
 * meme row. `generateMemeBuffer` draws that pair in preference to the
 * `factText` argument whenever either half is present — so every render path
 * that personalized only `factText` resolved a string that was then thrown
 * away, and the finished image baked the literal `{NAME}` into a public,
 * shareable artifact.
 *
 * The invariant these tests pin, stated once:
 *
 *   > Whatever text the meme generator draws must carry no unresolved fact
 *   > tokens — for every render path, every pronoun set, and both the fact
 *   > sentence and the split halves.
 *
 * Note on why the pre-existing composite tests missed this: every one of them
 * passes a tokenized `factTextTemplate` with NO `textOptions`, exercising only
 * the legacy single-block path. Every real client sends the split pair.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  composeMeme,
  personalizeMemeTextOptions,
  resolveStoredMemeCaption,
} from "../lib/memeComposite.js";
import { resolveTextBlocks, type TextOptions } from "../lib/memeGenerator.js";
import { hasUnresolvedFactTokens, CANONICAL_NAME } from "../lib/renderCanonical.js";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

describe("personalizeMemeTextOptions", () => {
  it("substitutes {NAME} in both split halves", () => {
    const out = personalizeMemeTextOptions(
      { topText: "{NAME} makes", bottomText: "onions cry." },
      "Nick Baron",
      "he/him",
    );
    assert.equal(out?.topText, "Nick Baron makes");
    assert.equal(out?.bottomText, "onions cry.");
  });

  it("substitutes a token that lands in the BOTTOM half (not just the top)", () => {
    // The split index is arbitrary — a token can land on either side, so a fix
    // that only personalized topText would still ship the bug.
    const out = personalizeMemeTextOptions(
      { topText: "Onions cry", bottomText: "because of {NAME}." },
      "Nick Baron",
      "he/him",
    );
    assert.equal(out?.bottomText, "because of Nick Baron.");
  });

  it("conjugates plural for they/them and singular for he/him inside a half", () => {
    // The core conjugation invariant, proven on the split path: the renderer
    // picks the branch by plurality, so a split half must get the same
    // treatment the whole sentence gets.
    const they = personalizeMemeTextOptions(
      { topText: "{Subj} {keeps|keep}", bottomText: "going." },
      "Sam",
      "they/them",
    );
    assert.equal(they?.topText, "They keep");

    const he = personalizeMemeTextOptions(
      { topText: "{Subj} {keeps|keep}", bottomText: "going." },
      "Sam",
      "he/him",
    );
    assert.equal(he?.topText, "He keeps");
  });

  it("resolves the full pronoun token set, not just {NAME}", () => {
    const out = personalizeMemeTextOptions(
      { topText: "{Poss} dog knows {OBJ}", bottomText: "better than {REFL}." },
      "Sam",
      "they/them",
    );
    assert.equal(out?.topText, "Their dog knows them");
    assert.equal(out?.bottomText, "better than themselves.");
  });

  it("fixes indefinite-article agreement within a half", () => {
    const out = personalizeMemeTextOptions(
      { topText: "Sharks have a {NAME} Week", bottomText: "every year." },
      "Alex",
      "they/them",
    );
    assert.equal(out?.topText, "Sharks have an Alex Week");
  });

  it("leaves a half with no tokens byte-identical", () => {
    const out = personalizeMemeTextOptions(
      { topText: "Onions cry", bottomText: "on sight." },
      "Nick Baron",
      "he/him",
    );
    assert.equal(out?.topText, "Onions cry");
    assert.equal(out?.bottomText, "on sight.");
  });

  it("preserves every other text option and does not mutate the input", () => {
    const input: TextOptions = {
      topText: "{NAME} makes",
      bottomText: "onions cry.",
      fontSize: 42,
      fontFamily: "Impact",
      allCaps: false,
      textEffect: "shadow",
      outlineColor: "#123456",
    };
    const out = personalizeMemeTextOptions(input, "Nick", "he/him");
    assert.equal(out?.fontSize, 42);
    assert.equal(out?.fontFamily, "Impact");
    assert.equal(out?.allCaps, false);
    assert.equal(out?.textEffect, "shadow");
    assert.equal(out?.outlineColor, "#123456");
    // The caller's object is untouched — render paths reuse the stored blob.
    assert.equal(input.topText, "{NAME} makes");
  });

  it("passes through undefined options and undefined halves", () => {
    assert.equal(personalizeMemeTextOptions(undefined, "Nick", "he/him"), undefined);
    const onlyTop = personalizeMemeTextOptions<TextOptions>({ topText: "{NAME} wins" }, "Nick", "he/him");
    assert.equal(onlyTop?.topText, "Nick wins");
    assert.equal(onlyTop?.bottomText, undefined);
  });

  it("passes through unchanged when there is no name to substitute", () => {
    // No identity means no personalization is possible; the caller falls back
    // to canonical text. Must not crash or emit an empty name.
    const out = personalizeMemeTextOptions({ topText: "{NAME} makes" }, null, "he/him");
    assert.equal(out?.topText, "{NAME} makes");
  });
});

describe("resolveTextBlocks — the generator's last line of defence", () => {
  it("uses the fact sentence when no split pair was sent", () => {
    assert.deepEqual(resolveTextBlocks("Nick makes onions cry.", undefined), {
      mode: "single",
      text: "Nick makes onions cry.",
    });
  });

  it("uses the split pair when both halves are already resolved", () => {
    assert.deepEqual(
      resolveTextBlocks("Nick makes onions cry.", {
        topText: "Nick makes",
        bottomText: "onions cry.",
      }),
      { mode: "split", topText: "Nick makes", bottomText: "onions cry." },
    );
  });

  it("treats a single defined half as a split (the other half is empty)", () => {
    assert.deepEqual(resolveTextBlocks("Nick wins.", { topText: "Nick wins." }), {
      mode: "split",
      topText: "Nick wins.",
      bottomText: "",
    });
  });

  it("falls back to the resolved sentence when a half still carries tokens", () => {
    // This is the guard: a caller that forgets personalizeMemeTextOptions gets
    // a mispositioned caption, never a visible "{NAME}".
    assert.deepEqual(
      resolveTextBlocks("Nick makes onions cry.", {
        topText: "{NAME} makes",
        bottomText: "onions cry.",
      }),
      { mode: "single", text: "Nick makes onions cry." },
    );
  });

  it("fires the fallback for a tokenized BOTTOM half too", () => {
    assert.deepEqual(
      resolveTextBlocks("Onions cry because of Nick.", {
        topText: "Onions cry",
        bottomText: "because of {NAME}.",
      }),
      { mode: "single", text: "Onions cry because of Nick." },
    );
  });

  it("fires the fallback for a leftover conjugation pair", () => {
    assert.equal(
      resolveTextBlocks("They keep going.", {
        topText: "{Subj} {keeps|keep}",
        bottomText: "going.",
      }).mode,
      "single",
    );
  });

  it("keeps the split when the sentence is no more resolved than the halves", () => {
    // Nothing better to fall back to — don't trade the creator's layout for a
    // string that is just as broken. Behaviour here is deliberately unchanged.
    assert.deepEqual(
      resolveTextBlocks("{NAME} makes onions cry.", {
        topText: "{NAME} makes",
        bottomText: "onions cry.",
      }),
      { mode: "split", topText: "{NAME} makes", bottomText: "onions cry." },
    );
  });

  it("does not treat ordinary braces as fact tokens", () => {
    // hasUnresolvedFactTokens is deliberately narrow; a caption may legitimately
    // contain braces (emoji shortcodes, maths) and must keep its split.
    assert.equal(
      resolveTextBlocks("whatever", { topText: "set {a, b}", bottomText: "wins." }).mode,
      "split",
    );
  });
});

describe("resolveStoredMemeCaption — what a saved meme re-renders with", () => {
  const fact = { text: "{NAME} makes onions cry.", canonicalText: "Alex makes onions cry." };
  const storedOptions = { topText: "{NAME} makes", bottomText: "onions cry.", fontSize: 30 };

  it("personalizes the sentence AND both halves with the creator's identity", () => {
    const out = resolveStoredMemeCaption(
      fact,
      { displayName: "Nick Baron", pronouns: "he/him" },
      storedOptions,
    );
    assert.equal(out.factText, "Nick Baron makes onions cry.");
    assert.equal(out.textOptions?.topText, "Nick Baron makes");
    assert.equal(out.textOptions?.bottomText, "onions cry.");
    assert.equal(out.textOptions?.fontSize, 30);
  });

  it("leaves the generator nothing tokenized to draw, for every PRONOUN_ALLOWLIST set", () => {
    // he/him, she/her, they/them, xe/xem, ze/zir — the exact set
    // validators/memeBuilder.ts's PRONOUN_ALLOWLIST accepts on the
    // meme-builder endpoints, so this is real coverage, not an arbitrary
    // sample.
    for (const pronouns of ["he/him", "she/her", "they/them", "xe/xem", "ze/zir"]) {
      const out = resolveStoredMemeCaption(
        { text: "{Subj} {keeps|keep} {POSS} cool.", canonicalText: "They keep their cool." },
        { displayName: "Sam", pronouns },
        { topText: "{Subj} {keeps|keep}", bottomText: "{POSS} cool." },
      );
      const blocks = resolveTextBlocks(out.factText, out.textOptions);
      assert.equal(blocks.mode, "split", `${pronouns}: fallback should not be needed`);
      assert.ok(blocks.mode === "split");
      assert.ok(
        !hasUnresolvedFactTokens(blocks.topText) && !hasUnresolvedFactTokens(blocks.bottomText),
        `${pronouns}: drew "${blocks.topText}" / "${blocks.bottomText}"`,
      );
    }
  });

  it("resolves ze/zir and xe/xem to their OWN forms on the split halves, not they/them's", () => {
    // Round 1 regression: before this fix, resolveIdentityForms only
    // special-cased he/she and silently fell through to their/theirs for
    // every other subject — including two of PRONOUN_ALLOWLIST's own options.
    // A raw {POSS} token (loud, self-reporting) is worse than nothing, but
    // "their" instead of "zir" (quiet, plausible-looking, wrong) is worse
    // still on a permanent shareable image. Pin the exact word, not just
    // "no braces left".
    const zir = resolveStoredMemeCaption(
      { text: "{Subj} keeps {POSS} cool.", canonicalText: "They keep their cool." },
      { displayName: "Sam", pronouns: "ze/zir" },
      { topText: "{Subj} keeps", bottomText: "{POSS} cool." },
    );
    assert.equal(zir.textOptions?.topText, "Ze keeps");
    assert.equal(zir.textOptions?.bottomText, "zir cool.");

    const xyr = resolveStoredMemeCaption(
      { text: "{Subj} keeps {POSS} cool.", canonicalText: "They keep their cool." },
      { displayName: "Sam", pronouns: "xe/xem" },
      { topText: "{Subj} keeps", bottomText: "{POSS} cool." },
    );
    assert.equal(xyr.textOptions?.topText, "Xe keeps");
    assert.equal(xyr.textOptions?.bottomText, "xyr cool.");
  });

  it("falls back to the canonical identity for both when the creator is gone", () => {
    const out = resolveStoredMemeCaption(fact, undefined, storedOptions);
    assert.equal(out.factText, "Alex makes onions cry.");
    // The halves must agree with the sentence — canonical, not tokenized.
    assert.equal(out.textOptions?.topText, `${CANONICAL_NAME} makes`);
    assert.equal(out.textOptions?.bottomText, "onions cry.");
  });

  it("falls back to canonical when the creator row has no display name", () => {
    const out = resolveStoredMemeCaption(fact, { displayName: null, pronouns: null }, storedOptions);
    assert.equal(out.factText, "Alex makes onions cry.");
    assert.equal(out.textOptions?.topText, `${CANONICAL_NAME} makes`);
  });

  it("tolerates a meme row with no stored text options", () => {
    const out = resolveStoredMemeCaption(fact, { displayName: "Nick", pronouns: "he/him" }, null);
    assert.equal(out.factText, "Nick makes onions cry.");
    assert.equal(out.textOptions, undefined);
  });

  it("tolerates a missing fact row", () => {
    const out = resolveStoredMemeCaption(undefined, { displayName: "Nick", pronouns: "he/him" }, null);
    assert.equal(out.factText, "");
  });
});

describe("composeMeme — split captions render personalized (end to end)", () => {
  const imageSource = { type: "template" as const, templateId: "action" };

  it("renders a tokenized split identically to the same split typed out by hand", async () => {
    // The strongest available proof that substitution reached the drawn text:
    // if the token survived to the canvas, these two renders could not be
    // byte-identical. This assertion fails on the unfixed code.
    const tokenized = await composeMeme({
      factTextTemplate: "{NAME} makes onions cry.",
      name: "Nick Baron",
      pronouns: "he/him",
      imageSource,
      textOptions: { topText: "{NAME} makes", bottomText: "onions cry." },
      aspectRatio: "landscape",
    });
    const literal = await composeMeme({
      factTextTemplate: "Nick Baron makes onions cry.",
      name: "Nick Baron",
      pronouns: "he/him",
      imageSource,
      textOptions: { topText: "Nick Baron makes", bottomText: "onions cry." },
      aspectRatio: "landscape",
    });
    assert.equal(sha256(tokenized.buffer), sha256(literal.buffer));
  });

  it("still reflects the viewer's name in the split caption (not a blanket no-op)", async () => {
    // Guards against a "fix" that strips tokens instead of substituting them:
    // two different names must produce different pixels.
    const base = {
      factTextTemplate: "{NAME} makes onions cry.",
      pronouns: "he/him",
      imageSource,
      textOptions: { topText: "{NAME} makes", bottomText: "onions cry." },
      aspectRatio: "landscape" as const,
    };
    const nick = await composeMeme({ ...base, name: "Nick Baron" });
    const jordan = await composeMeme({ ...base, name: "Jordan" });
    assert.notEqual(sha256(nick.buffer), sha256(jordan.buffer));
  });

  it("conjugates the split caption by pronoun plurality", async () => {
    const base = {
      factTextTemplate: "{Subj} {keeps|keep} the receipts.",
      name: "Sam",
      imageSource,
      textOptions: { topText: "{Subj} {keeps|keep}", bottomText: "the receipts." },
      aspectRatio: "landscape" as const,
    };
    const singular = await composeMeme({ ...base, pronouns: "he/him" });
    const plural = await composeMeme({ ...base, pronouns: "they/them" });
    assert.notEqual(sha256(singular.buffer), sha256(plural.buffer));

    // And the plural render must equal the hand-typed plural wording.
    const literalPlural = await composeMeme({
      ...base,
      pronouns: "they/them",
      textOptions: { topText: "They keep", bottomText: "the receipts." },
    });
    assert.equal(sha256(plural.buffer), sha256(literalPlural.buffer));
  });

  it("leaves the single-block (no split) path unchanged", async () => {
    const withSplit = await composeMeme({
      factTextTemplate: "{NAME} makes onions cry.",
      name: "Nick",
      pronouns: "he/him",
      imageSource,
      aspectRatio: "landscape",
    });
    const again = await composeMeme({
      factTextTemplate: "Nick makes onions cry.",
      name: "Nick",
      pronouns: "he/him",
      imageSource,
      aspectRatio: "landscape",
    });
    assert.equal(sha256(withSplit.buffer), sha256(again.buffer));
  });
});
