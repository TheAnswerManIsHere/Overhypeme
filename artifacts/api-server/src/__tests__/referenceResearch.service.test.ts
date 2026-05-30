/**
 * Reference research SERVICE tests.
 *
 * Exercise researchCulturalReferenceWithModel (inject-the-caller variant)
 * + the cache (sha256 key stability, cache hit/miss/forceRefresh, write-through).
 * Mock the OpenAI Responses callable; no live network.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, referenceResearchCacheTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  researchCulturalReferenceWithModel,
  computeReferenceResearchCacheKey,
  ReferenceResearchError,
} from "../lib/referenceResearch";

const VALID_VI =
  "Show an elegant boutique fashion-retail setting with velvet curtain and runway lighting.";

const VALID_WIRE_JSON = JSON.stringify({
  explanation:
    "Victoria's Secret is a lingerie and fashion retailer. The phrase plays on the brand name as a pun.",
  visualImplication: VALID_VI,
  confidence: "high",
  sources: [
    {
      title: "Victoria's Secret",
      url: "https://en.wikipedia.org/wiki/Victoria%27s_Secret",
      sourceType: "encyclopedic",
      summary: "Background on the brand.",
    },
  ],
  researchNotes: "Brand-name pun; preserve secret + fashion-retail.",
  ambiguityWarnings: [],
});

const INPUT = {
  factText: "David knows Victoria's secret.",
  sourcePhrase: "Victoria's secret",
  referenceType: "brand_or_cultural_reference",
  canonicalReference: "Victoria's Secret",
};

async function clearCacheRow(input: typeof INPUT): Promise<void> {
  const key = computeReferenceResearchCacheKey(input);
  await db.delete(referenceResearchCacheTable).where(eq(referenceResearchCacheTable.cacheKey, key));
}

describe("researchCulturalReferenceWithModel", () => {
  before(async () => {
    // Belt-and-braces: nuke any leftover cache row from a previous run.
    await clearCacheRow(INPUT);
  });

  after(async () => {
    await clearCacheRow(INPUT);
  });

  beforeEach(async () => {
    await clearCacheRow(INPUT);
  });

  it("calls the model, stamps provenance, writes to cache, and returns fromCache=false", async () => {
    let calls = 0;
    const outcome = await researchCulturalReferenceWithModel(INPUT, async () => {
      calls++;
      return VALID_WIRE_JSON;
    });
    assert.equal(calls, 1);
    assert.equal(outcome.fromCache, false);
    assert.equal(outcome.result.confidence, "high");
    assert.equal(outcome.result.researchedBy, "ai_reference_research");
    assert.ok(outcome.result.researchedAt, "researchedAt timestamped");
    assert.equal(outcome.result.canAutoApplyToEmptyFields, true);
    assert.ok(outcome.cacheKey.length === 64, "cache key is sha256 hex");
  });

  it("returns the cached result on the second call without invoking the model", async () => {
    let calls = 0;
    const make = async () => {
      calls++;
      return VALID_WIRE_JSON;
    };
    const first = await researchCulturalReferenceWithModel(INPUT, make);
    assert.equal(first.fromCache, false);

    const second = await researchCulturalReferenceWithModel(INPUT, make);
    assert.equal(second.fromCache, true);
    assert.equal(calls, 1, "second call must skip the model");
    // The cached result should preserve provenance + canAutoApplyToEmptyFields.
    assert.equal(second.result.researchedBy, "ai_reference_research");
    assert.equal(second.result.canAutoApplyToEmptyFields, true);
  });

  it("forceRefresh bypasses cache and overwrites the row", async () => {
    let calls = 0;
    await researchCulturalReferenceWithModel(INPUT, async () => {
      calls++;
      return VALID_WIRE_JSON;
    });
    const refreshed = await researchCulturalReferenceWithModel(
      INPUT,
      async () => {
        calls++;
        return VALID_WIRE_JSON;
      },
      { forceRefresh: true },
    );
    assert.equal(calls, 2);
    assert.equal(refreshed.fromCache, false);
  });

  it("differs cache keys when factText differs", () => {
    const a = computeReferenceResearchCacheKey({ ...INPUT, factText: "fact A" });
    const b = computeReferenceResearchCacheKey({ ...INPUT, factText: "fact B" });
    assert.notEqual(a, b);
  });

  it("matches cache keys when input is identical", () => {
    const a = computeReferenceResearchCacheKey(INPUT);
    const b = computeReferenceResearchCacheKey({ ...INPUT });
    assert.equal(a, b);
  });

  it("throws ReferenceResearchError(input) when factText is missing", async () => {
    await assert.rejects(
      researchCulturalReferenceWithModel(
        { ...INPUT, factText: "" },
        async () => VALID_WIRE_JSON,
      ),
      (err: unknown) => err instanceof ReferenceResearchError && (err as ReferenceResearchError).phase === "input",
    );
  });

  it("throws ReferenceResearchError(input) when both sourcePhrase and canonicalReference are empty", async () => {
    await assert.rejects(
      researchCulturalReferenceWithModel(
        { ...INPUT, sourcePhrase: "", canonicalReference: "" },
        async () => VALID_WIRE_JSON,
      ),
      (err: unknown) => err instanceof ReferenceResearchError && (err as ReferenceResearchError).phase === "input",
    );
  });

  it("throws ReferenceResearchError(validation) when the model returns non-JSON", async () => {
    await assert.rejects(
      researchCulturalReferenceWithModel(INPUT, async () => "not json at all"),
      (err: unknown) =>
        err instanceof ReferenceResearchError && (err as ReferenceResearchError).phase === "validation",
    );
  });

  it("throws ReferenceResearchError(validation) when business rules reject (no source + high confidence on public ref)", async () => {
    const bad = JSON.parse(VALID_WIRE_JSON) as Record<string, unknown>;
    bad["sources"] = [];
    await assert.rejects(
      researchCulturalReferenceWithModel(INPUT, async () => JSON.stringify(bad)),
      (err: unknown) =>
        err instanceof ReferenceResearchError && (err as ReferenceResearchError).phase === "validation",
    );
  });

  it("sets canAutoApplyToEmptyFields=false when ambiguity warnings are present", async () => {
    const withWarnings = JSON.parse(VALID_WIRE_JSON) as Record<string, unknown>;
    withWarnings["ambiguityWarnings"] = ["Could also mean Apple Inc. or the fruit"];
    const outcome = await researchCulturalReferenceWithModel(INPUT, async () =>
      JSON.stringify(withWarnings),
    );
    assert.equal(outcome.result.canAutoApplyToEmptyFields, false);
  });
});
