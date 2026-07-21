/**
 * Unit tests for the prompt-identity token budget contract (PR-A, plan §10.3).
 *
 * The load-bearing invariant: `projectWorstCaseRenderedLength` must NEVER
 * under-count the actual rendered length produced by `renderPersonalized` for
 * any identity whose token expansions respect PROMPT_IDENTITY_TOKEN_MAX. If it
 * did, save-time budget validation would accept a template that overflows the
 * engine prompt at render time — exactly the failure this contract prevents.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  projectWorstCaseRenderedLength,
  PROMPT_IDENTITY_TOKEN_MAX,
  RENDERED_IDENTITY_NAME_MAX,
  unbudgetedSimpleTokens,
} from "@workspace/api-zod";
import { renderPersonalized } from "../lib/renderCanonical";

// A maximum-length prompt-reduced name (RENDERED_IDENTITY_NAME_MAX chars) and
// the longest pronoun forms permitted by the prompt per-word bound (20). We use
// a 20-char pronoun set to probe the pronoun-token reserves at their bound.
const MAX_NAME = "X".repeat(RENDERED_IDENTITY_NAME_MAX);
const LONG_PRONOUNS = `${"s".repeat(20)}/${"o".repeat(20)}`; // subj/obj each 20 chars

// Identity permutations that stay within the contract's per-token maxima.
const IDENTITIES: Array<{ name: string; pronouns: string | null }> = [
  { name: "Alex", pronouns: "they/them" },
  { name: "David", pronouns: "he/him" },
  { name: "Sam", pronouns: "she/her" },
  { name: MAX_NAME, pronouns: "they/them" },
  { name: MAX_NAME, pronouns: LONG_PRONOUNS },
];

const TEMPLATES = [
  "",
  "no tokens here at all",
  "{NAME} does a thing",
  "a {NAME} appears",           // article expansion a→an
  "A {NAME} appears",           // capitalized article
  "an {NAME} is fine too",
  "{NAME_POSSESSIVE} car is fast",
  "{Subj} {runs|run} and {POSS} dog {barks|bark}",
  "{NAME} tells {OBJ} that {POSS_PRO} is {REFL}",
  // token-dense: many repeats, the case raw-length caps miss
  "{NAME} ".repeat(40),
  "{NAME_POSSESSIVE} ".repeat(30),
  "{Subj} {POSS} {OBJ} {REFL} {POSS_PRO} ".repeat(10),
];

describe("projectWorstCaseRenderedLength", () => {
  it("every grammar simple token has a budget reserve", () => {
    assert.deepEqual(unbudgetedSimpleTokens(), []);
  });

  it("empty template projects 0", () => {
    assert.equal(projectWorstCaseRenderedLength(""), 0);
  });

  it("literal-only text projects its own length", () => {
    const s = "just some literal text, no braces";
    assert.equal(projectWorstCaseRenderedLength(s), s.length);
  });

  it("token-dense template projects far above raw length", () => {
    const t = "{NAME} ".repeat(40); // raw 280
    // 40 names × 20 + 40 spaces = 840 ≫ 280 raw
    assert.ok(projectWorstCaseRenderedLength(t) > t.length);
  });

  it("NAME_POSSESSIVE reserve covers the possessive suffix", () => {
    assert.equal(PROMPT_IDENTITY_TOKEN_MAX.NAME_POSSESSIVE, RENDERED_IDENTITY_NAME_MAX + 2);
  });

  it("projection is NEVER below actual rendered length (the load-bearing bound)", () => {
    for (const tpl of TEMPLATES) {
      const projected = projectWorstCaseRenderedLength(tpl);
      for (const id of IDENTITIES) {
        const actual = renderPersonalized(tpl, id.name, id.pronouns).length;
        assert.ok(
          projected >= actual,
          `projection ${projected} < actual ${actual} for template ${JSON.stringify(
            tpl,
          )} identity ${JSON.stringify(id)}`,
        );
      }
    }
  });
});
