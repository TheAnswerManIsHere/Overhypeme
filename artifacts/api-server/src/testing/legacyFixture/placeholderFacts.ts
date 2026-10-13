/**
 * Placeholder fact templates for every row whose text is not the live text of
 * an active fact (plan D4; David's option 1, 2026-10-08: "rejected, pending
 * and reported facts get placeholder text").
 *
 * They are written in the template grammar, half with pronoun tokens, and are
 * distinct from `scripts/src/seed.ts`'s facts so the two seeds never collide.
 * A placeholder is content-keyed — the same source text always gets the same
 * placeholder — and carries a short case tag, so two different source texts
 * never become equal on the fixture (an exact-text duplicate check would read
 * a false match otherwise). `canonical_text`, `split_token_index` and
 * `has_pronouns` are recomputed from it by the real normaliser.
 */
import { normalizeFactTemplateForStorage } from "../../lib/normalizeFactTemplateForStorage";
import type { Scrubber } from "./scrub";

interface PlaceholderTemplate {
  template: string;
  hashtags: readonly string[];
}

const WITHOUT_PRONOUNS: readonly PlaceholderTemplate[] = [
  { template: "{NAME} once taught a sundial to tell the time at night", hashtags: ["fixture", "time", "legend"] },
  { template: "{NAME} can fold a fitted sheet on the first try", hashtags: ["fixture", "domestic", "legend"] },
  { template: "Thunder checks the forecast for {NAME}", hashtags: ["fixture", "weather", "legend"] },
  { template: "{NAME} once won a staring contest against a lighthouse", hashtags: ["fixture", "strength", "legend"] },
  { template: "The moon waits for {NAME} to go to bed first", hashtags: ["fixture", "space", "legend"] },
  { template: "{NAME} can parallel park a cloud", hashtags: ["fixture", "driving", "legend"] },
];

const WITH_PRONOUNS: readonly PlaceholderTemplate[] = [
  { template: "{NAME} {doesn't|don't} set alarms. Mornings ask {OBJ} for permission", hashtags: ["fixture", "time", "legend"] },
  { template: "When {NAME} whistles, {SUBJ} {is|are} tuning the wind", hashtags: ["fixture", "music", "legend"] },
  { template: "{NAME} once lost a game of chess on purpose, and {POSS} opponent apologised", hashtags: ["fixture", "games", "legend"] },
  { template: "Mountains move out of {NAME}'s way because {SUBJ} asked nicely", hashtags: ["fixture", "nature", "legend"] },
  { template: "{NAME} {doesn't|don't} need a map. The road follows {OBJ}", hashtags: ["fixture", "travel", "legend"] },
  { template: "{NAME} taught {REFL} to read upside down, then taught the book", hashtags: ["fixture", "wisdom", "legend"] },
];

const PRONOUN_TOKEN = /\{(SUBJ|Subj|OBJ|Obj|POSS|Poss|REFL|Refl|[a-z']+\|[a-z']+)\}/;

export interface PlaceholderFact {
  text: string;
  canonicalText: string;
  splitTokenIndex: number | null;
  hasPronouns: boolean;
  hashtags: readonly string[];
}

/** Every placeholder template, for the corpus test. */
export const PLACEHOLDER_TEMPLATES: readonly PlaceholderTemplate[] = [...WITHOUT_PRONOUNS, ...WITH_PRONOUNS];

/**
 * The placeholder for a source template. Content-keyed: equal sources map to
 * equal placeholders within a run; distinct sources stay distinct through the
 * case tag.
 */
export function placeholderFor(sourceText: string, scrubber: Scrubber): PlaceholderFact {
  const h = scrubber.hmac("placeholder-fact", sourceText);
  const pool = PRONOUN_TOKEN.test(sourceText) ? WITH_PRONOUNS : WITHOUT_PRONOUNS;
  const pick = pool[parseInt(h.slice(0, 8), 16) % pool.length]!;
  const raw = `${pick.template} (case ${h.slice(8, 14)}).`;
  const normalized = normalizeFactTemplateForStorage(raw);
  if (!normalized.valid) {
    throw new Error(`[legacy-fixture] a placeholder template failed the grammar: ${pick.template}`);
  }
  return {
    text: normalized.text,
    canonicalText: normalized.canonicalText,
    splitTokenIndex: normalized.splitTokenIndex,
    hasPronouns: normalized.hasPronouns,
    hashtags: pick.hashtags,
  };
}
