/**
 * The fact character list's producer (PLAN_BUBBLE_SPEAKERS.md, A–B): the
 * dedicated call's clean-up, its success-only extraction marker, and what a
 * failure keeps. Pure — no DB, no network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  factEnrichmentWireSchema,
  validateEnrichment,
  buildPlaceholderFactEnrichment,
  CHARACTER_LIST_PROMPT_VERSION,
  hasExtractedCharacters,
  type FactEnrichment,
} from "@workspace/api-zod";
import {
  normalizeExtractedCharacters,
  parseCharacterResponse,
  extractFactCharactersWithModel,
  attachCharacters,
  charactersOverrideOnly,
  CharacterExtractionError,
} from "../lib/factCharacters.js";

const BASE: FactEnrichment = buildPlaceholderFactEnrichment();
const MARKER = { promptVersion: "v1", extractedAt: "2026-11-15T00:00:00.000Z" };

describe("normalizeExtractedCharacters", () => {
  it("keeps a plain list and strips the subject and subject possessives", () => {
    const out = normalizeExtractedCharacters({
      characters: [
        { label: "Alex", kind: "person", ofSubject: false },
        { label: "Alex's mom", kind: "person", ofSubject: false },
        { label: "his dog", kind: "animal", ofSubject: false },
        { label: "referee", kind: "person", ofSubject: false },
      ],
    });
    assert.deepEqual(out, [
      { label: "mom", kind: "person", ofSubject: true },
      { label: "dog", kind: "animal", ofSubject: true },
      { label: "referee", kind: "person", ofSubject: false },
    ]);
  });

  it("drops the reserved word, tokens, over-long labels and case-insensitive duplicates", () => {
    const out = normalizeExtractedCharacters({
      characters: [
        { label: "subject", kind: "person", ofSubject: false },
        { label: "{NAME}", kind: "person", ofSubject: false },
        { label: "x".repeat(61), kind: "person", ofSubject: false },
        { label: "mom", kind: "person", ofSubject: true },
        { label: "Mom", kind: "person", ofSubject: true },
        { label: "ghost", kind: "spirit", ofSubject: false },
      ],
    });
    assert.deepEqual(out, [{ label: "mom", kind: "person", ofSubject: true }]);
  });

  it("clips to the maximum of 10", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ label: `person ${i}`, kind: "person", ofSubject: false }));
    assert.equal(normalizeExtractedCharacters({ characters: many }).length, 10);
  });
});

describe("parseCharacterResponse / extractFactCharactersWithModel", () => {
  it("accepts a legitimate empty list (subject-only fact)", () => {
    assert.deepEqual(parseCharacterResponse('{"characters":[]}'), []);
  });

  it("throws on invalid JSON or a missing array", () => {
    assert.throws(() => parseCharacterResponse("nope"), CharacterExtractionError);
    assert.throws(() => parseCharacterResponse('{"people":[]}'), CharacterExtractionError);
  });

  it("sends the rendered fact and its own system prompt", async () => {
    let seenUser = "";
    let seenSystem = "";
    const out = await extractFactCharactersWithModel("When Alex was born, they drove their mom home.", async (s, u) => {
      seenSystem = s;
      seenUser = u;
      return '{"characters":[{"label":"mom","kind":"person","ofSubject":true}]}';
    });
    assert.match(seenUser, /drove their mom home/);
    assert.match(seenSystem, /NEVER list the subject/);
    assert.deepEqual(out, [{ label: "mom", kind: "person", ofSubject: true }]);
  });
});

describe("attachCharacters — the success-only marker and what a failure keeps", () => {
  it("stamps the marker on success, an empty list included", async () => {
    const out = await attachCharacters(BASE, null, async () => []);
    assert.deepEqual(out.characters, []);
    assert.equal(out.charactersExtraction?.promptVersion, CHARACTER_LIST_PROMPT_VERSION);
    assert.equal(hasExtractedCharacters(out), true);
  });

  it("first enrichment failure: empty list and NO marker (counted missing)", async () => {
    const out = await attachCharacters(BASE, null, async () => {
      throw new Error("provider down");
    });
    assert.deepEqual(out.characters, []);
    assert.equal(out.charactersExtraction, undefined);
    assert.equal(hasExtractedCharacters(out), false);
  });

  it("re-enrichment failure keeps the prior list and its marker", async () => {
    const prior = { characters: [{ label: "mom", kind: "person" as const, ofSubject: true }], charactersExtraction: MARKER };
    const out = await attachCharacters(BASE, prior, async () => {
      throw new Error("provider down");
    });
    assert.deepEqual(out.characters, prior.characters);
    assert.deepEqual(out.charactersExtraction, MARKER);
  });

  it("a prior list that was never extracted is not carried as if it were", async () => {
    const out = await attachCharacters(BASE, { characters: [], charactersExtraction: undefined }, async () => {
      throw new Error("provider down");
    });
    assert.equal(out.charactersExtraction, undefined);
  });
});

describe("schema boundaries", () => {
  it("an old blob without the field parses to [] with no marker (defaults never stamp)", () => {
    const { characters: _c, ...old } = BASE;
    const v = validateEnrichment(old);
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.deepEqual(v.data.characters, []);
      assert.equal(hasExtractedCharacters(v.data), false);
    }
  });

  it("the main classifier's response schema has no characters field", () => {
    assert.equal(Object.prototype.hasOwnProperty.call(factEnrichmentWireSchema.shape, "characters"), false);
  });
});

describe("charactersOverrideOnly (bulk re-enrich keeps only the character correction)", () => {
  it("keeps /characters and drops the rest", () => {
    const ov = {
      "/characters": { value: [], overriddenFrom: [], overriddenAt: "x", overriddenBy: "a" },
      "/overhypeFit": { value: "questionable", overriddenFrom: "strong", overriddenAt: "x", overriddenBy: "a" },
    } as never;
    assert.deepEqual(Object.keys(charactersOverrideOnly(ov)), ["/characters"]);
    assert.deepEqual(charactersOverrideOnly({}), {});
    assert.deepEqual(charactersOverrideOnly(null), {});
  });
});
