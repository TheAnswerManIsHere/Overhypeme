/**
 * Prompt-identity token budget contract (PR-A, rev 7 plan §10.3 / §11.5).
 *
 * The moderator Concept and fact templates carry personalization tokens
 * ({NAME}, {SUBJ}, {a|b} conjugation pairs, …) that expand at render time. Two
 * consumers must agree on their maximum expansion:
 *
 *   1. save-time budget projection (`projectWorstCaseRenderedLength`) — rejects
 *      a template whose WORST-CASE rendered length would blow the prompt budget,
 *      even when its raw length is under cap (100 repeated {NAME} tokens render
 *      far longer than 100 chars);
 *   2. the prompt-identity snapshot's per-token reserves used by the compiler's
 *      `measureRequiredPromptBudget` proof.
 *
 * This module is the ONE source of those maxima, versioned so the projection can
 * never silently drift from the reserves the budget proof assumes. The token
 * vocabulary mirrors `templateGrammar.ts` (`ALLOWED_SIMPLE_TOKENS` +
 * conjugation pairs); a pure `projectWorstCaseRenderedLength` here must stay ≥
 * the api-server renderer's actual output for every identity within these
 * bounds (asserted by a projection-vs-actual test matrix).
 *
 * These are PROMPT-specific bounds, deliberately independent of the
 * admin-config-driven profile name limits (`validators/personalName.ts`): a
 * stored display name may be longer, but the prompt uses a reduced short name
 * (≤ RENDERED_IDENTITY_NAME_MAX) so the budget stays provable.
 */

import { ALLOWED_SIMPLE_TOKENS } from "./templateGrammar";
import type { ResolvedIdentityTokenKey } from "./resolvedIdentityForms";

/** Bump when any maximum below changes, so budget fixtures re-derive. */
export const PROMPT_IDENTITY_BUDGET_VERSION = 1 as const;

/** Max chars of the reduced prompt name (first-name / short form). */
export const RENDERED_IDENTITY_NAME_MAX = 20;

/**
 * Worst-case rendered length of each simple token. Names are the reduced prompt
 * name; pronoun-derived tokens are bounded by the prompt-specific per-word cap
 * (a stored pronoun word is validated to `name_validation_max_chars_per_word`,
 * default 20 — we reserve that same 20 here rather than couple to admin config).
 * `NAME_POSSESSIVE` adds the possessive suffix ("'s").
 */
// Typed against the SAME token-key type `resolvedIdentityForms.ts` uses for its
// resolved-forms map — a compile-time guarantee (not just the runtime
// `unbudgetedSimpleTokens` check below) that a reserve can never exist for a
// token the resolver doesn't produce, or vice versa.
export const PROMPT_IDENTITY_TOKEN_MAX: Readonly<Record<ResolvedIdentityTokenKey, number>> = {
  NAME: RENDERED_IDENTITY_NAME_MAX,
  NAME_POSSESSIVE: RENDERED_IDENTITY_NAME_MAX + 2, // "…'s"
  SUBJ: 20, Subj: 20,
  OBJ: 20, Obj: 20,
  POSS: 20, Poss: 20,
  POSS_PRO: 20, Poss_Pro: 20,
  REFL: 20, Refl: 20,
};

// Sanity: every grammar simple token has a reserve (guards future token
// additions from silently escaping the budget). Not thrown at import in prod —
// surfaced by the dedicated test — but kept here as executable documentation.
export function unbudgetedSimpleTokens(): string[] {
  return [...ALLOWED_SIMPLE_TOKENS].filter((t) => !(t in PROMPT_IDENTITY_TOKEN_MAX));
}

/**
 * Worst-case rendered length of `template` under the maxima above. Literal text
 * counts as-is; a recognized `{TOKEN}` counts as its reserve; a `{a|b}`
 * conjugation pair counts as its longest branch (it renders a literal branch,
 * no identity expansion); an unrecognized `{…}` counts as its own literal
 * length (it is not a personalization token — the grammar validator rejects
 * genuinely unknown tokens upstream, so this is a safe over-count).
 *
 * Pure. Guarantee: return value ≥ actual rendered length for every identity
 * whose token expansions respect PROMPT_IDENTITY_TOKEN_MAX.
 */
// A bare indefinite article ("a"/"A") immediately before {NAME} can expand to
// "an"/"An" at render time (article agreement: "a {NAME}" → "an Alex"), adding
// one char. Count each such site as +1 slack so projection stays ≥ actual.
// (Matches "an" too — harmless over-count.)
const ARTICLE_BEFORE_NAME_RE = /\b[Aa]n?\s+\{NAME\}/g;

export function projectWorstCaseRenderedLength(template: string): number {
  if (!template) return 0;
  let total = (template.match(ARTICLE_BEFORE_NAME_RE) ?? []).length; // article-expansion slack
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{", i);
    if (open === -1) {
      total += template.length - i;
      break;
    }
    total += open - i; // literal run before the brace
    const close = template.indexOf("}", open + 1);
    if (close === -1) {
      // Unmatched brace — count the rest literally (grammar validator rejects
      // this upstream; be safe, not clever).
      total += template.length - open;
      break;
    }
    const inner = template.slice(open + 1, close);
    if (inner in PROMPT_IDENTITY_TOKEN_MAX) {
      total += PROMPT_IDENTITY_TOKEN_MAX[inner as ResolvedIdentityTokenKey];
    } else if (inner.includes("|")) {
      // Conjugation pair {a|b}: renders one literal branch — the longer one.
      const longest = inner.split("|").reduce((m, b) => Math.max(m, b.length), 0);
      total += longest;
    } else {
      // Unknown {…}: over-count as its literal span (incl. braces).
      total += close - open + 1;
    }
    i = close + 1;
  }
  return total;
}

/**
 * Worst-case RENDERED STRING for `template` — the same token-substitution
 * walk as `projectWorstCaseRenderedLength`, but returns actual text instead
 * of a length. Literal characters the moderator actually authored (INCLUDING
 * any quotes/backslashes) pass through verbatim, so an escaping-aware
 * downstream measurement (`serializeLiteralPromptString`) sees their true
 * cost instead of an anonymized placeholder; only recognized `{TOKEN}` spans
 * are replaced with a safe non-quote filler sized to their
 * `PROMPT_IDENTITY_TOKEN_MAX` reserve (worst-case token LENGTH, not
 * worst-case token content — a resolved identity name is not expected to
 * contain literal quote/backslash characters). A `{a|b}` conjugation pair
 * substitutes its longest literal branch verbatim (no further identity
 * expansion, matching `projectWorstCaseRenderedLength`); an unrecognized
 * `{…}` is kept verbatim.
 *
 * Guarantee: for every identity whose token expansions respect
 * `PROMPT_IDENTITY_TOKEN_MAX`, this projection's length equals
 * `projectWorstCaseRenderedLength(template)` — so any length-based budget
 * invariant carries over — while its actual (non-token) characters are the
 * real authored text, making it safe to feed to a real serializer/compiler
 * for a precise-and-still-safe upper bound.
 */
export function projectWorstCaseRenderedText(template: string): string {
  if (!template) return "";
  let out = "";
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{", i);
    if (open === -1) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, open); // literal run before the brace, verbatim
    const close = template.indexOf("}", open + 1);
    if (close === -1) {
      out += template.slice(open); // unmatched brace — rest kept verbatim
      break;
    }
    const inner = template.slice(open + 1, close);
    if (inner in PROMPT_IDENTITY_TOKEN_MAX) {
      out += "x".repeat(PROMPT_IDENTITY_TOKEN_MAX[inner as ResolvedIdentityTokenKey]);
    } else if (inner.includes("|")) {
      const branches = inner.split("|");
      out += branches.reduce((longest, b) => (b.length > longest.length ? b : longest), "");
    } else {
      out += template.slice(open, close + 1); // unknown {…} kept verbatim
    }
    i = close + 1;
  }
  // Article-expansion slack ("a {NAME}" -> "an Alex"): pad with one extra
  // non-escaping char per site so this projection's LENGTH matches
  // `projectWorstCaseRenderedLength` exactly (the padding's exact position
  // doesn't matter — only the length guarantee does).
  const articleSites = (template.match(ARTICLE_BEFORE_NAME_RE) ?? []).length;
  return out + "x".repeat(articleSites);
}
