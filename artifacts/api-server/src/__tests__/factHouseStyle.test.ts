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

/** [as written, in the house style] — the plan's rule table, row by row. */
const TABLE: ReadonlyArray<readonly [string, string]> = [
  // Spacing
  ["  lots   of\tspace  ", "Lots of space."],
  ["two\n\nlines", "Two lines."],
  // Start
  ["chuck norris can divide by zero", "Chuck norris can divide by zero."],
  ['"when {NAME} sneezes, the earth moves"', '"When {NAME} sneezes, the earth moves."'],
  ["'twas {NAME}", "'Twas {NAME}."],
  ["{NAME} beats the sun", "{NAME} beats the sun."],
  ["{NAME_POSSESSIVE} shadow runs", "{NAME_POSSESSIVE} shadow runs."],
  ["{SUBJ} wins", "{Subj} wins."],
  ["{POSS_PRO} is the best", "{Poss_Pro} is the best."],
  ["{does|do} {SUBJ} ever lose", "{Does|Do} {SUBJ} ever lose."],
  ["{doesn't|don't} {SUBJ} sleep", "{Doesn't|Don't} {SUBJ} sleep."],
  ["7 days a week {NAME} works", "7 days a week {NAME} works."],
  ["ßtraße bows to {NAME}", "ßtraße bows to {NAME}."],
  // Q3: a brand-style first word stays as written
  ["iPhone fears {NAME}", "iPhone fears {NAME}."],
  ["eBay sells {POSS} shadows", "eBay sells {POSS} shadows."],
  // End: kept
  ["Done.", "Done."],
  ["Really?!", "Really?!"],
  ["Wait...", "Wait..."],
  ["And then…", "And then…"],
  ['{NAME} said "no!"', '{NAME} said "no!"'],
  // End: Q5 replaced
  ["divide by zero,", "Divide by zero."],
  ["{NAME} wins;", "{NAME} wins."],
  ["{NAME} wins:", "{NAME} wins."],
  // End: Q4 emoji left
  ["{NAME} wins 🏆", "{NAME} wins 🏆"],
  ["{NAME} wins 👍🏽", "{NAME} wins 👍🏽"],
  ["{NAME} flies to 🇺🇸", "{NAME} flies to 🇺🇸"],
  // End: added, placed around closers and tokens
  ["costs $5", "Costs $5."],
  ["{NAME} beats {NAME}", "{NAME} beats {NAME}."],
  ["{NAME} {doesn't|don't} sleep", "{NAME} {doesn't|don't} sleep."],
  ['said "no"', 'Said "no."'],
  ["said “no”", "Said “no.”"],
  ["zero (really)", "Zero (really)."],
  ['("no")', '("No.")'],
  ["[{NAME} wins]", "[{NAME} wins.]"],
  ['"he did it (twice)"', '"He did it (twice)."'],
  ["said 'no'", "Said 'no.'"],
  ["said ‘no’", "Said ‘no.’"],
  ["the Joneses'", "The Joneses'."],
  ["don't say 'no'", "Don't say 'no.'"],
  ["the Joneses' dog said 'hi'", "The Joneses' dog said 'hi.'"],
  ["{NAME}'s dog", "{NAME}'s dog."],
  // End: a trailing bracket is matched to its own opener (PR #1213 round 1)
  ["(unlike others) {NAME} can divide by zero (really)", "(Unlike others) {NAME} can divide by zero (really)."],
  ["({NAME} wins) (really)", "({NAME} wins) (really)."],
  ["({NAME} wins (really))", "({NAME} wins (really).)"],
  ["(({NAME} wins) twice)", "(({NAME} wins) twice.)"],
  ["[{NAME} wins (really)]", "[{NAME} wins (really).]"],
  ["[(a) b] c (d)", "[(A) b] c (d)."],
  ['{NAME} said ("no")', '{NAME} said ("no").'],
  ["{NAME} wins :)", "{NAME} wins :)."],
  // End: a mark already inside a trailing bracket is kept, with nothing added
  ["{NAME} counted to infinity. (Twice.)", "{NAME} counted to infinity. (Twice.)"],
  ["{NAME} can divide by zero (yes, really!)", "{NAME} can divide by zero (yes, really!)"],
  ["{NAME} wins. [Citation needed.]", "{NAME} wins. [Citation needed.]"],
  ["(unlike others) {NAME} counted to infinity. (Twice.)", "(Unlike others) {NAME} counted to infinity. (Twice.)"],
  ['{NAME} said (and meant "no!")', '{NAME} said (and meant "no!")'],
  ["{NAME} won (🏆)", "{NAME} won (🏆)"],
];

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

  it("keeps the caption split and the has-pronouns flag", () => {
    for (const [input] of TABLE) {
      const spaced = input.replace(/\s+/gu, " ").trim();
      const out = applyHouseStyle(input);
      assert.equal(computeSplitTokenIndex(out), computeSplitTokenIndex(spaced), JSON.stringify(input));
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
