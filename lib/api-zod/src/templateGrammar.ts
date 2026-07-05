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
  // …sses → strip "es"  (passes → pass, misses → miss, kisses → kiss). Narrow on
  // purpose: single-s "-ses" (uses, raises, poses) is ambiguous with e-final bases
  // and correctly falls through to the default strip-"s" rule below.
  if (/sses$/.test(word)) return word.slice(0, -2);
  // default: strip trailing "s"  (keeps → keep, runs → run, loves → love)
  return word.slice(0, -1);
}

/**
 * Regex source for one skippable adverb between a subject token and its verb:
 * an "…ly" word or a known bare adverb. Exported as the single source of truth
 * because TWO passes must recognise the same adverb set to stay complementary —
 * `autoConjugatePersonSubjectVerbs` (creates pairs after {SUBJ}/{Subj}) and
 * `collapseNameSubjectConjugationPairs` (collapses pairs after {NAME}). If the
 * lists drifted, "{NAME} <new adverb> {gives|give}" would survive both passes
 * and render the plural branch after a singular name.
 */
export const SKIPPABLE_ADVERB_RE_SRC =
  "[A-Za-z]+ly|always|never|often|sometimes|still|just|also|secretly|once|only|really|simply";

// Zero or more skippable adverbs, each followed by whitespace.
const ADVERB_RUN_RE_SRC = `(?:(?:${SKIPPABLE_ADVERB_RE_SRC})\\s+)*`;

// A person-pronoun subject token, then whitespace, then any run of skippable adverbs
// (an "…ly" word or a known bare adverb), then the candidate verb. The candidate
// matcher allows a single internal apostrophe so contractions ("doesn't",
// "isn't") are captured; it cannot match a "{...}" token or an existing
// "{a|b}" pair (those start with "{", not a letter), which keeps the pass
// idempotent.
const PERSON_SUBJECT_VERB_RE = new RegExp(
  `(\\{(?:SUBJ|Subj)\\}\\s+${ADVERB_RUN_RE_SRC})([A-Za-z]+(?:['’][A-Za-z]+)?)`,
  "g",
);

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

// ---------------------------------------------------------------------------
// Name-subject conjugation-pair collapse
//
// A {NAME} token renders as a literal singular name for EVERY pronoun set, so a
// verb whose subject is {NAME} must always use its singular form — a pair there
// is wrong by construction ("{NAME} {gives|give}" renders "David give" for
// they/them). The LLM tokenizer intermittently emits such pairs anyway (because
// {SUBJ} verbs DO need them), and older prompts actively required them, so this
// pass collapses each one to its left/singular branch. It lives here — next to
// its sibling grammar passes — so every template-writing path (tokenize route,
// direct fact insert, review submission, retokenize/backfill scripts) shares
// the same guarantee.
// ---------------------------------------------------------------------------

// A conjugation pair, e.g. "{gives|give}".
const PAIR_RE_SRC = "\\{[^|{}]+\\|[^|{}]+\\}";
// One verb unit in a coordination chain: a plain word (contractions allowed) or
// a conjugation pair. "{...}" simple tokens like {Subj} match neither, which is
// what stops the chain before a new subject.
const VERB_UNIT_RE_SRC = `(?:[A-Za-z]+(?:['’][A-Za-z]+)?|${PAIR_RE_SRC})`;

// {NAME}, whitespace, optional adverbs, then a chain of verb units joined by
// coordinating conjunctions (each side may carry its own adverbs): this covers
// both "{NAME} {runs|run} and {hides|hide}" and "{NAME} runs and {hides|hide}".
// The chain stops at anything that is not a bare word or a pair — in particular
// at pronoun tokens — so "{NAME} {runs|run} or {SUBJ} {hides|hide}" collapses
// only the first pair and leaves the {SUBJ}-subject pair alone.
const NAME_SUBJECT_CONJUGATION_CHAIN_RE = new RegExp(
  `(\\{NAME\\}\\s+${ADVERB_RUN_RE_SRC})` +
    `(${VERB_UNIT_RE_SRC}(?:\\s+(?:and|or|but)\\s+${ADVERB_RUN_RE_SRC}${VERB_UNIT_RE_SRC})*)`,
  "g",
);

// Inside a matched chain: a pair with its singular branch captured.
const CHAIN_PAIR_RE = /\{([^|{}]+)\|[^|{}]+\}/g;

// ---------------------------------------------------------------------------
// {NAME}-subject conjugation-pair collapse — object-separated coordination
//
// The chain above only reaches a coordinated verb that is itself a bare word
// or pair joined DIRECTLY to the previous unit ("{NAME} runs and
// {hides|hide}"). It does not reach a pair separated from {NAME} by an object
// noun phrase ("{NAME} eats cake and {drinks|drink} soda") because "cake"
// breaks the verb-unit chain. This second, independent pass covers exactly
// that gap: it walks from {NAME} through plain text up to a coordinating
// conjunction and collapses a pair that sits directly after it (+ skippable
// adverbs). It only ever collapses a pre-existing pair — it never creates
// one — so it can never mis-target a pronoun-subject verb.
//
// The reach is deliberately narrow: the span between {NAME} and the
// conjunction must not cross a brace (a different subject token intervened,
// e.g. "{NAME} runs or {SUBJ} hides") or clause-boundary punctuation (`.`,
// `,`, `;`, `:`, `?`, `!`, newline, or a quote) — so "{NAME} eats cake, and
// {drinks|drink} soda" and "{NAME} eats cake. And {drinks|drink} soda" are
// left untouched (the comma/period reads as a new clause, not unambiguously
// the same coordinated predicate).
// ---------------------------------------------------------------------------

// A character allowed inside the plain span between {NAME} and the
// conjunction: anything except a brace (a token — a different subject — would
// have intervened) or clause-boundary punctuation.
const NAME_SAFE_SPAN_CHAR_RE_SRC = `[^{}.,;:?!\\n"“”]`;

const NAME_OBJECT_SEPARATED_PAIR_RE = new RegExp(
  `(\\{NAME\\}${NAME_SAFE_SPAN_CHAR_RE_SRC}*?\\s+(?:and|or|but)\\s+${ADVERB_RUN_RE_SRC})` +
    `(${PAIR_RE_SRC})`,
  "g",
);

/**
 * Collapse a {NAME}-subject conjugation pair separated from {NAME} by an
 * object/complement, when it sits directly after a coordinating conjunction:
 * "{NAME} eats cake and {drinks|drink} soda" → "... and drinks soda". Never
 * creates a pair, and stops at any brace or clause-boundary punctuation (see
 * above), so it can never reach past a different subject token or into a new
 * clause/sentence. Pure and idempotent.
 */
function collapseNameObjectSeparatedConjugationPair(template: string): string {
  if (!template) return template;
  return template.replace(
    NAME_OBJECT_SEPARATED_PAIR_RE,
    (_match, prefix: string, pair: string) => `${prefix}${pair.replace(CHAIN_PAIR_RE, "$1")}`,
  );
}

/**
 * Collapse conjugation pairs whose grammatical subject is {NAME} to their
 * singular branch: "{NAME} {gives|give} you" → "{NAME} gives you", including
 * coordinated verbs ("{NAME} {runs|run} and {hides|hide}" → "{NAME} runs and
 * hides") and pairs separated from {NAME} by an object ("{NAME} eats cake and
 * {drinks|drink} soda" → "... and drinks soda"). Pairs after a different
 * subject ({SUBJ}/{Subj} or a literal noun) are untouched. Pure and
 * idempotent — running it twice equals running it once.
 */
export function collapseNameSubjectConjugationPairs(template: string): string {
  if (!template) return template;
  const chainCollapsed = template.replace(
    NAME_SUBJECT_CONJUGATION_CHAIN_RE,
    (_match, prefix: string, chain: string) => `${prefix}${chain.replace(CHAIN_PAIR_RE, "$1")}`,
  );
  return collapseNameObjectSeparatedConjugationPair(chainCollapsed);
}

// ---------------------------------------------------------------------------
// Subject-pronoun contraction expansion
//
// `{Subj}'s` / `{SUBJ}'s` is syntactically valid template text today ({Subj}
// is a valid simple token, followed by plain "'s"), but it renders "They's"
// for they/them — never valid English. The only safe fix is deterministic:
// expand the contraction into an explicit pair before storage, so the
// renderer never has to guess.
//
// "'s" is genuinely ambiguous in general ("he's fast" = is, "he's got it" =
// has), but a SMALL set of following words can only ever mean "has" — "is
// got"/"is been"/"is had" are not grammatical English. So "'s got"/"'s
// been"/"'s had" must expand to {has|have}, never the copula (else "{Subj}'s
// got the keys" would store as "They are got the keys" for they/them).
// Anything else — including genuinely ambiguous cases like "'s done", which
// can mean either "is done" [finished] or "has done" [completed] — defaults
// to the copula {is|are}: a valid sentence, even if occasionally the
// less-likely reading, beats guessing into a guaranteed-ungrammatical one.
// ---------------------------------------------------------------------------

/**
 * Words that can only follow "has"/"have", never "is"/"are", directly after a
 * subject-pronoun contraction — "is got"/"is been"/"is had" are not
 * grammatical English. Exported so the renderer's legacy-text fallback
 * (`render-fact.ts`) and the `They's` backfill can recognise the identical
 * signal set; keep the three in sync.
 */
export const HAS_ONLY_FOLLOWING_WORDS: ReadonlySet<string> = new Set(["got", "gotten", "been", "had"]);

// {Subj}'s or {SUBJ}'s, straight or curly apostrophe.
const SUBJECT_CONTRACTION_RE = /(\{(?:SUBJ|Subj)\})['’]s\b/g;

/**
 * Expand a subject-pronoun contraction into an explicit conjugation pair:
 * "{Subj}'s unstoppable" → "{Subj} {is|are} unstoppable", but "{Subj}'s got
 * the keys" → "{Subj} {has|have} got the keys" (see
 * `HAS_ONLY_FOLLOWING_WORDS`). Prevents the never-valid "They's" render. Pure
 * and idempotent — the output contains no more bare `{Subj}'s`/`{SUBJ}'s`
 * sequences to re-match.
 */
export function expandSubjectContractions(template: string): string {
  if (!template) return template;
  return template.replace(
    SUBJECT_CONTRACTION_RE,
    (match: string, subj: string, offset: number, full: string) => {
      const rest = full.slice(offset + match.length);
      const nextWord = /^\s+([A-Za-z]+)/.exec(rest)?.[1]?.toLowerCase();
      const aux = nextWord && HAS_ONLY_FOLLOWING_WORDS.has(nextWord) ? "has|have" : "is|are";
      return `${subj} {${aux}}`;
    },
  );
}

/**
 * The single canonical deterministic grammar-only cleanup sequence, run at
 * every template-writing ingress (and inside the AI tokenizer's own
 * post-processing, so the two paths can never drift): collapse
 * {NAME}-subject pairs, expand subject-pronoun contractions, auto-conjugate
 * missed person-subject verbs, then collapse identical conjugation branches.
 * Excludes `stripUnknownTokens` — hallucinated-token cleanup is model-specific
 * policy that write routes should not silently apply to admin/user input;
 * they should validate and reject unknown tokens instead. Pure and
 * idempotent.
 */
export function applyDeterministicGrammar(template: string): string {
  const nameCollapsed = collapseNameSubjectConjugationPairs(template);
  const contractionExpanded = expandSubjectContractions(nameCollapsed);
  const conjugated = autoConjugatePersonSubjectVerbs(contractionExpanded);
  return collapseIdenticalConjugationBranches(conjugated);
}
