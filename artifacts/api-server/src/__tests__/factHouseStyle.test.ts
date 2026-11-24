/**
 * The fact wording house style (plan docs/plans/PLAN_FACT_HOUSE_STYLE.md,
 * Phase 1): the rule's table, its idempotence and its must-not-change
 * invariants, the write paths that apply it, and the draft-ideas freshness
 * record (R1).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { db, factsTable } from "@workspace/db";
import { applyHouseStyle, validateTemplate } from "../lib/templateGrammar.js";
import { duplicateMatchText } from "../lib/duplicateText.js";
import { computeSplitTokenIndex } from "../lib/splitTokenIndex.js";
import {
  hasFactPronounMarkersForStorage,
  normalizeFactTemplateForPendingReview,
  normalizeFactTemplateForStorage,
} from "../lib/normalizeFactTemplateForStorage.js";
import { ensureStagingFact } from "../lib/moderationStaging.js";
import { factTextForFreshness } from "../lib/visualConceptJobs.js";
import { renderCanonical } from "../lib/renderCanonical.js";
import { HOUSE_STYLE_TABLE } from "./helpers/houseStyleCases.js";

const TABLE = HOUSE_STYLE_TABLE;

describe("applyHouseStyle — the rule table", () => {
  for (const [input, expected] of TABLE) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      assert.equal(applyHouseStyle(input), expected);
    });
  }

  it("is idempotent over every row", () => {
    for (const [input] of TABLE) {
      const once = applyHouseStyle(input);
      assert.equal(applyHouseStyle(once), once, `not idempotent for ${JSON.stringify(input)}`);
    }
  });

  it("leaves an empty or blank wording empty", () => {
    assert.equal(applyHouseStyle(""), "");
    assert.equal(applyHouseStyle("   "), "");
  });
});

describe("applyHouseStyle — must not change", () => {
  it("keeps every valid template valid", () => {
    for (const [input] of TABLE) {
      if (!validateTemplate(input).valid) continue;
      assert.deepEqual(validateTemplate(applyHouseStyle(input)), { valid: true }, JSON.stringify(input));
    }
  });

  it("keeps the caption split and the has-pronouns flag of the wording as written", () => {
    // Raw input, untidied spacing included: Phase 2's pass keeps each fact's
    // stored split, so the rule must not move it from the wording as stored.
    for (const [input] of [...TABLE, ["  two  spaces   here and there ", ""] as const, ["tabs\tand\nlines here", ""] as const]) {
      const out = applyHouseStyle(input);
      assert.equal(computeSplitTokenIndex(out), computeSplitTokenIndex(input), JSON.stringify(input));
      assert.equal(hasFactPronounMarkersForStorage(out), hasFactPronounMarkersForStorage(input), JSON.stringify(input));
    }
  });

  it("keeps what the duplicate check treats as identical", async () => {
    for (const [input] of TABLE) {
      const out = applyHouseStyle(input);
      const { rows } = await db.execute(sql`SELECT ${duplicateMatchText(input)} = ${duplicateMatchText(out)} AS eq`);
      assert.equal(rows[0]!.eq, true, JSON.stringify(input));
    }
  });
});

describe("the write paths apply the house style", () => {
  it("a submission and a triage edit are tidied after the grammar cleanup", () => {
    const pending = normalizeFactTemplateForPendingReview("{NAME} can divide by zero");
    assert.equal(pending.valid, true);
    assert.equal(pending.text, "{NAME} can divide by zero.");
    const stored = normalizeFactTemplateForStorage("{SUBJ} counts to infinity twice");
    assert.equal(stored.valid, true);
    assert.equal(stored.text, "{Subj} {counts|count} to infinity twice.");
    if (stored.valid) assert.equal(stored.canonicalText, renderCanonical(stored.text));
  });

  const created: number[] = [];
  after(async () => {
    for (const id of created) await db.delete(factsTable).where(eq(factsTable.id, id));
  });

  it("acceptance locks in a tidied fact even from untidied review wording", async () => {
    const { factId, created: made } = await ensureStagingFact({
      id: 0,
      submittedText: "  {NAME} counted the stars,  ",
      submittedById: null,
      stagingFactId: null,
    });
    created.push(factId);
    assert.equal(made, true);
    const [fact] = await db.select().from(factsTable).where(eq(factsTable.id, factId));
    assert.equal(fact!.text, "{NAME} counted the stars.");
    assert.equal(fact!.canonicalText, renderCanonical("{NAME} counted the stars."));
    assert.equal(fact!.splitTokenIndex, computeSplitTokenIndex("{NAME} counted the stars."));
  });
});

describe("factTextForFreshness — the draft-ideas record (R1)", () => {
  it("uses the fact's wording when nothing is recorded", () => {
    assert.equal(factTextForFreshness("{NAME} wins.", undefined), "{NAME} wins.");
  });

  it("uses the fact's wording when it is the recorded wording", () => {
    assert.equal(factTextForFreshness("{NAME} wins", "{NAME} wins"), "{NAME} wins");
  });

  it("uses the recorded wording while the fact is its house-style form", () => {
    assert.equal(factTextForFreshness("{NAME} wins.", "{NAME} wins"), "{NAME} wins");
    assert.equal(factTextForFreshness("Chuck wins.", "chuck wins,"), "chuck wins,");
  });

  it("uses the fact's wording after any other change, so the ideas stale", () => {
    assert.equal(factTextForFreshness("{NAME} loses.", "{NAME} wins"), "{NAME} loses.");
    assert.equal(factTextForFreshness("{NAME} wins!", "{NAME} wins"), "{NAME} wins!");
  });
});
