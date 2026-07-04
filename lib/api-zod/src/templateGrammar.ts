/**
 * The closed set of simple (non-conjugation) tokens the template grammar
 * accepts. Exported as the single source of truth so consumers that need to
 * recognise valid tokens — e.g. the tokenize route's `stripUnknownTokens`
 * cleanup — cannot drift from what `validateTemplate` accepts.
 */
export const ALLOWED_SIMPLE_TOKENS: ReadonlySet<string> = new Set([
  "NAME",
  "NAME_POSSESSIVE",
  "SUBJ", "Subj",
  "OBJ", "Obj",
  "POSS", "Poss",
  "POSS_PRO", "Poss_Pro",
  "REFL", "Refl",
]);

const CONJUGATION_PAIR_RE = /^[^|]+\|[^|]+$/;

export interface GrammarValidationResult {
  valid: boolean;
  error?: string;
}

export function validateTemplate(template: string): GrammarValidationResult {
  if (!template || template.length === 0) {
    return { valid: false, error: "Template is empty" };
  }

  let i = 0;
  while (i < template.length) {
    const openIdx = template.indexOf("{", i);
    if (openIdx === -1) break;

    if (template[openIdx + 1] === "{") {
      return { valid: false, error: "Nested braces detected" };
    }

    const closeIdx = template.indexOf("}", openIdx + 1);
    if (closeIdx === -1) {
      return { valid: false, error: "Unmatched opening brace" };
    }

    const inner = template.slice(openIdx + 1, closeIdx);

    if (inner.includes("{")) {
      return { valid: false, error: "Nested braces detected" };
    }

    if (ALLOWED_SIMPLE_TOKENS.has(inner)) {
      i = closeIdx + 1;
      continue;
    }

    if (CONJUGATION_PAIR_RE.test(inner)) {
      const parts = inner.split("|");
      if (parts.length !== 2) {
        return { valid: false, error: `Conjugation pair "${inner}" must have exactly two alternatives` };
      }
      if (!parts[0] || !parts[1]) {
        return { valid: false, error: `Conjugation pair "${inner}" must have non-empty alternatives` };
      }
      i = closeIdx + 1;
      continue;
    }

    return { valid: false, error: `Unknown token "{${inner}}"` };
  }

  const trailingOpen = template.lastIndexOf("{");
  if (trailingOpen !== -1) {
    const trailingClose = template.indexOf("}", trailingOpen);
    if (trailingClose === -1) {
      return { valid: false, error: "Unmatched opening brace at end of template" };
    }
  }

  const unmatched = (template.match(/\}/g) ?? []).length - (template.match(/\{/g) ?? []).length;
  if (unmatched > 0) {
    return { valid: false, error: "Unmatched closing brace" };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Deterministic verb-conjugation safety net
//
// The LLM tokenizer is *told* to wrap a verb whose subject is the personalized
// person as a {singular|plural} pair, but it intermittently leaves one as plain
// text (e.g. "{Subj} keeps it" instead of "{Subj} {keeps|keep} it"), which then
// renders "They keeps" for they/them. This pass is the actual guarantee: it
// finds a present-tense 3rd-person-singular verb directly following a person
// subject token and rewrites it to the conjugation pair. It is deliberately
// narrow — it only fires right after {SUBJ}/{Subj}, so it can never
// mis-pluralize a verb whose subject is a literal name ("{NAME} gives…") or
// some other noun ("Sharks have…").
// ---------------------------------------------------------------------------

/** Irregular 3rd-person-singular → they/base form. Keys are lowercase. */
const IRREGULAR_THIRD_PERSON: Record<string, string> = {
  is: "are",
  was: "were",
  has: "have",
  does: "do",
  goes: "go",
  "isn't": "aren't",
  "wasn't": "weren't",
  "hasn't": "haven't",
  "doesn't": "don't",
};

/**
 * Lowercase words that end in -s but are nouns, not 3rd-person-singular verbs.
 * Without this a naive "strip the trailing s" rule would mangle a noun that
 * happens to follow {NAME} (e.g. "{NAME} news") into a bogus pair.
 */
const NOUN_STOPLIST: ReadonlySet<string> = new Set([
  "news", "games", "series", "species", "lens", "bus", "gas", "bias",
  "focus", "campus", "process", "class", "glass", "crisis",
]);

/**
 * Given a candidate word that directly follows a person subject token, return
 * its they/base form if it is a present-tense 3rd-person-singular verb, or
 * `null` if the word should be left untouched (not a conjugatable form, a
 * proper noun/title, or a risky noun ending).
 */
function thirdPersonToBase(word: string): string | null {
  // Only conjugate normally-cased (lowercase-initial) words. A capitalized word
  // after a subject token is a proper noun / title / label ("{NAME} News",
  // "{NAME} Fitness") or malformed input — leave it alone.
  if (word[0] !== word[0].toLowerCase()) return null;

  if (IRREGULAR_THIRD_PERSON[word]) return IRREGULAR_THIRD_PERSON[word];

  if (word.length <= 2) return null;
  if (!word.endsWith("s")) return null;          // past tense / base form — not 3rd-sing
  if (NOUN_STOPLIST.has(word)) return null;
  // -ss / -us / -is endings are overwhelmingly nouns (fitness, virus, status,
  // analysis), not verbs — never strip them. The copula "is" is handled by the
  // irregular map above, before this guard.
  if (/(?:ss|us|is)$/.test(word)) return null;

  // …consonant + ies → …y  (flies → fly, tries → try)
  if (/[bcdfghjklmnpqrstvwxz]ies$/.test(word)) return word.slice(0, -3) + "y";
  // …(ch|sh|x|z|o)es → strip "es"  (catches → catch, pushes → push, fixes → fix)
  if (/(?:ch|sh|x|z|o)es$/.test(word)) return word.slice(0, -2);
  // default: strip trailing "s"  (keeps → keep, runs → run, loves → love)
  return word.slice(0, -1);
}

// A person-pronoun subject token, then whitespace, then any run of skippable adverbs
// (an "…ly" word or a known bare adverb), then the candidate verb. The candidate
// matcher allows a single internal apostrophe so contractions ("doesn't",
// "isn't") are captured; it cannot match a "{...}" token or an existing
// "{a|b}" pair (those start with "{", not a letter), which keeps the pass
// idempotent.
const PERSON_SUBJECT_VERB_RE =
  /(\{(?:SUBJ|Subj)\}\s+(?:(?:[A-Za-z]+ly|always|never|often|sometimes|still|just|also|secretly|once|only|really|simply)\s+)*)([A-Za-z]+(?:['’][A-Za-z]+)?)/g;

/**
 * Repair missed verb conjugations: wrap a present-tense 3rd-person-singular verb
 * that directly follows a person pronoun subject token ({SUBJ}/{Subj}) as a
 * {singular|plural} pair. Pure and idempotent — running it twice equals running
 * it once.
 */
export function autoConjugatePersonSubjectVerbs(template: string): string {
  if (!template) return template;
  return template.replace(PERSON_SUBJECT_VERB_RE, (full, prefix: string, word: string) => {
    const base = thirdPersonToBase(word);
    if (base === null || base === word) return full;
    return `${prefix}{${word}|${base}}`;
  });
}

// A conjugation pair whose two branches are byte-for-byte identical, e.g.
// {can|can}. The backreference \1 is what enforces "identical" — a real pair
// like {is|are} can never match. Matching is exact (no whitespace trimming): a
// weird `{can | can}` stays untouched until such input is actually observed.
const IDENTICAL_CONJUGATION_PAIR_RE = /\{([^|{}]+)\|\1\}/g;

/**
 * Collapse a conjugation token whose singular and plural branches are identical:
 * `{can|can}` → `can`. Non-conjugating verbs (modals like can/will/should/must)
 * have the same he/she and they form, so the LLM tokenizer sometimes wraps them
 * into a useless duplicate pair. Both branches render identically, so dropping the
 * braces is output-preserving. Pure and idempotent; legitimate pairs are untouched.
 */
export function collapseIdenticalConjugationBranches(template: string): string {
  if (!template) return template;
  return template.replace(IDENTICAL_CONJUGATION_PAIR_RE, "$1");
}
