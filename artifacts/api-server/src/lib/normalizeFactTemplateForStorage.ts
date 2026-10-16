/**
 * The single normalization contract every route that ingests new
 * fact-template text shares: run the full deterministic grammar cleanup and validate the result.
 * For a `facts` row the storage variant then, on success, computes the
 * text-derived metadata (`canonicalText`, `splitTokenIndex`, `hasPronouns`)
 * every row must keep in sync, from the FINAL normalized text, never the raw
 * input. A new-text `pending_reviews` write takes the pending-review variant,
 * which stops at validation; the metadata is derived when the review becomes
 * a staging fact (`moderationStaging.ts`). The send-back and resubmit paths,
 * which copy an existing fact's text into a review, use neither variant. Centralizing this here
 * means no route can independently forget a pass, validate before
 * normalizing, or derive metadata from stale text.
 *
 * @purpose The normalize-validate step every new-text template ingress shares, in two variants: the pending-review variant, which the submission, variant and import routes run and which stops at validation, and the storage variant, which the approved-text edit and the legacy-fixture builder run to also derive canonical text, split index and hasPronouns from the final text.
 * @subsystem token-rendering
 */

import { applyDeterministicGrammar, validateTemplate, type GrammarValidationResult } from "./templateGrammar";
import { renderCanonical } from "./renderCanonical";
import { computeSplitTokenIndex } from "./splitTokenIndex";

/**
 * Storage-oriented pronoun/conjugation detector — the authoritative source
 * for `facts.hasPronouns`. Mirrors the ingress detector every create path
 * already used before this helper existed (facts.ts, the backfill scripts):
 * it must NOT treat `{NAME}` or `{NAME_POSSESSIVE}` alone as pronoun-bearing,
 * since a name substitution carries no pronoun/verb-agreement information.
 * Deliberately separate from the frontend's `hasPronouns()` in
 * `render-fact.ts` (that one is client-oriented; do not import it here).
 */
const HAS_PRONOUN_RE =
  /\{(SUBJ|OBJ|POSS|POSS_PRO|REFL|Subj|Obj|Poss|Poss_Pro|Refl|he|him|his|himself|He|Him|His|Himself|he's|He's|[^|{}]+\|[^|{}]+)\}/;

export function hasFactPronounMarkersForStorage(template: string): boolean {
  return HAS_PRONOUN_RE.test(template);
}

export type NormalizeFactTemplateForStorageResult =
  | {
      valid: true;
      text: string;
      canonicalText: string;
      splitTokenIndex: number;
      hasPronouns: boolean;
    }
  | {
      valid: false;
      text: string;
      grammarResult: GrammarValidationResult;
    };

/**
 * Normalize a raw fact template for a `facts` row: run
 * `applyDeterministicGrammar`, validate, and on success compute
 * `canonicalText`/`splitTokenIndex`/`hasPronouns` from the normalized text.
 * A discriminated union on `valid` so a caller cannot accidentally read
 * derived metadata off an invalid template — TypeScript narrows `text`-only
 * access to the `valid: false` branch.
 */
export function normalizeFactTemplateForStorage(rawText: string): NormalizeFactTemplateForStorageResult {
  const text = applyDeterministicGrammar(rawText);
  const grammarResult = validateTemplate(text);
  if (!grammarResult.valid) {
    return { valid: false, text, grammarResult };
  }
  return {
    valid: true,
    text,
    canonicalText: renderCanonical(text),
    splitTokenIndex: computeSplitTokenIndex(text),
    hasPronouns: hasFactPronounMarkersForStorage(text),
  };
}

export type NormalizeFactTemplateForPendingReviewResult =
  | { valid: true; text: string }
  | { valid: false; text: string; grammarResult: GrammarValidationResult };

/**
 * Like `normalizeFactTemplateForStorage`, but for
 * `pending_reviews.submittedText` — no fact-only derived metadata is
 * computed here (canonicalText/splitTokenIndex/hasPronouns are computed
 * later, when a pending review becomes a staging fact).
 */
export function normalizeFactTemplateForPendingReview(
  rawText: string,
): NormalizeFactTemplateForPendingReviewResult {
  const text = applyDeterministicGrammar(rawText);
  const grammarResult = validateTemplate(text);
  if (!grammarResult.valid) {
    return { valid: false, text, grammarResult };
  }
  return { valid: true, text };
}
