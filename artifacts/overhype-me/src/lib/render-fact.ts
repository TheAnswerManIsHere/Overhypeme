import { parseCustom } from "@/lib/pronouns";

/** Whether verb conjugation should use singular (he/she/ze/xe/…) or plural (they) forms. */
type Plurality = "singular" | "plural";

interface PronounMap {
  subj:     string;  // he, she, they, ze, xe, …
  obj:      string;  // him, her, them, zir, xem, …
  poss:     string;  // his, her, their, zir, xyr, …
  possPro:  string;  // his, hers, theirs, zirs, xyrs, …
  refl:     string;  // himself, herself, themselves, zirself, xemself, …
  plurality: Plurality;
}

/**
 * Known pronoun sets covering common presets and neopronouns.
 * Keyed by subject pronoun (lowercase).
 * Verb conjugation: only they/them uses plural form; every other set uses singular.
 */
const KNOWN_MAPS: Record<string, PronounMap> = {
  "he": {
    subj: "he", obj: "him", poss: "his", possPro: "his", refl: "himself",
    plurality: "singular",
  },
  "she": {
    subj: "she", obj: "her", poss: "her", possPro: "hers", refl: "herself",
    plurality: "singular",
  },
  "they": {
    subj: "they", obj: "them", poss: "their", possPro: "theirs", refl: "themselves",
    plurality: "plural",
  },
  "ze": {
    subj: "ze", obj: "zir", poss: "zir", possPro: "zirs", refl: "zirself",
    plurality: "singular",
  },
  "xe": {
    subj: "xe", obj: "xem", poss: "xyr", possPro: "xyrs", refl: "xemself",
    plurality: "singular",
  },
  "ey": {
    subj: "ey", obj: "em", poss: "eir", possPro: "eirs", refl: "emself",
    plurality: "singular",
  },
  "fae": {
    subj: "fae", obj: "faer", poss: "faer", possPro: "faers", refl: "faerself",
    plurality: "singular",
  },
  "it": {
    subj: "it", obj: "it", poss: "its", possPro: "its", refl: "itself",
    plurality: "singular",
  },
};

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Possessive form of the resolved name for {NAME_POSSESSIVE}. Per the product
 * decision we ALWAYS append "'s" — including for names already ending in "s"
 * ("James" → "James's") — mirroring the server's canonical `possessive()`
 * helper (renderCanonical.ts) so canonical and user-facing rendering agree.
 */
function possessiveName(resolvedName: string): string {
  return `${resolvedName}'s`;
}

/**
 * Words that can only follow "has"/"have", never "is"/"are", directly after a
 * subject-pronoun contraction — "is got"/"is been"/"is had" are not
 * grammatical English. Must stay in sync with the identical set in
 * `lib/api-zod/src/templateGrammar.ts` (`HAS_ONLY_FOLLOWING_WORDS`) — this is
 * the renderer's defense-in-depth fallback for legacy/stale text that never
 * went through that deterministic ingress pass.
 */
const HAS_ONLY_FOLLOWING_WORDS = new Set(["got", "gotten", "been", "had"]);

/** Whether the plain text immediately following a matched contraction/token signals "has", not "is". */
function nextWordIsHasSignal(rest: string): boolean {
  const nextWord = /^\s+([A-Za-z]+)/.exec(rest)?.[1]?.toLowerCase();
  return !!nextWord && HAS_ONLY_FOLLOWING_WORDS.has(nextWord);
}

/**
 * Render a subject-pronoun + "'s" contraction, given the plain text
 * immediately following the match (`rest`) so the small has-only-follows set
 * can be checked. `{Subj}'s`/`{SUBJ}'s` is defense-in-depth for stale/legacy
 * stored text — the deterministic grammar pass expands new writes to an
 * explicit pair before storage, so a fresh template should never reach this
 * path. For a SINGULAR set the bare contraction ("He's") is valid English
 * either way (is or has), so it's kept as-is. For a PLURAL set (they/them and
 * any custom plural set) "They's" is never valid, so it must fully expand —
 * to "They have" when `rest` signals "has" ("He's got it" → "They have got
 * it"), otherwise to the copula "They are".
 */
function subjectContraction(subj: string, isSingular: boolean, capitalize: boolean, rest: string): string {
  const rendered = isSingular ? `${subj}'s` : `${subj} ${nextWordIsHasSignal(rest) ? "have" : "are"}`;
  return capitalize ? cap(rendered) : rendered;
}

/**
 * Choose "a" or "an" so the indefinite article agrees with the word that
 * follows it. English article agreement is decided by the *following* word, so
 * once {NAME} is filled in, the article in front of it has to match the actual
 * name: "a {NAME}" renders "an Alex" but "a David". Because the name varies per
 * viewer, this can only be resolved at render time — the stored template keeps a
 * plain "a"/"an". The original article's capitalization is preserved so a
 * sentence-initial "A {NAME}" becomes "An Alex".
 *
 * Agreement is decided purely from the first letter (vowel a/e/i/o/u → "an").
 * This is correct for the overwhelming majority of names; rare phonetic
 * exceptions ("a Uma", "an Hugo") are not special-cased.
 */
function indefiniteArticle(original: string, nextWord: string): string {
  const article = /^[aeiou]/i.test(nextWord) ? "an" : "a";
  return /^[A-Z]/.test(original) ? cap(article) : article;
}

// Matches a standalone indefinite article ("a"/"an", any case) immediately
// before a {NAME} token, capturing the whitespace between them.
const ARTICLE_BEFORE_NAME_RE = /\b([Aa]n?)(\s+)\{NAME\}/g;

/**
 * Resolve a stored pronouns value to a full PronounMap.
 *
 * Handles three formats:
 *   "he/him"  → preset → look up KNOWN_MAPS["he"]
 *   "ze/hir"  → split subject, look up KNOWN_MAPS["ze"] (ze/hir variant has hir obj)
 *   "xe|xem|xyr|xyrs|xemself|s" → pipe-delimited custom → use all 5 fields directly
 */
function resolveMap(pronounsValue: string): PronounMap {
  // Pipe-delimited custom format takes precedence
  const custom = parseCustom(pronounsValue);
  if (custom) {
    return {
      subj:     custom.subj     || "they",
      obj:      custom.obj      || "them",
      poss:     custom.poss     || "their",
      possPro:  custom.possPro  || "theirs",
      refl:     custom.refl     || "themselves",
      plurality: custom.plural ? "plural" : "singular",
    };
  }

  // Preset / "subject/object" format
  const slashIdx = pronounsValue.indexOf("/");
  const subject = slashIdx >= 0 ? pronounsValue.slice(0, slashIdx) : pronounsValue;
  const object  = slashIdx >= 0 ? pronounsValue.slice(slashIdx + 1) : "";

  const lc = subject.toLowerCase().trim();
  if (KNOWN_MAPS[lc]) {
    // For ze/hir variant (KNOWN_MAPS has ze → zir, but user might have ze/hir stored)
    const known = KNOWN_MAPS[lc];
    if (object && object !== known.obj) {
      // Partially override the object pronoun; derive other forms heuristically
      return {
        ...known,
        obj: object,
        poss: object,
        possPro: object + "s",
        refl: object + "self",
      };
    }
    return known;
  }

  // Fallback: use subject/object with heuristic derivation (they/them plurality)
  const sub = subject.trim() || "they";
  const obj = object.trim() || "them";
  return {
    subj: sub, obj, poss: obj, possPro: obj + "s",
    refl: obj + "self",
    plurality: "singular",
  };
}

/**
 * Replace all tokens in a fact template.
 *
 * @param text        - Tokenized fact template
 * @param name        - Person's display name  ({NAME} / {NAME_POSSESSIVE} tokens)
 * @param pronouns    - Full stored pronouns value: "he/him" | "she/her" | "they/them"
 *                      or pipe-delimited custom "subj|obj|poss|possPro|refl|s"
 *
 * Pronoun tokens:
 *   {SUBJ} / {Subj}           → he / He / she / She / they / They / …
 *   {OBJ} / {Obj}             → him / Her / them / …
 *   {POSS} / {Poss}           → his / her / their / …
 *   {POSS_PRO} / {Poss_Pro}   → his / hers / theirs / …
 *   {REFL} / {Refl}           → himself / herself / themselves / …
 *
 * Verb conjugation (singular: he/she/ze/xe/…; plural: they):
 *   {does|do}  {doesn't|don't}  {was|were}  etc.
 */
export function renderFact(
  text: string,
  name: string,
  pronouns: string = "he/him",
): string {
  const p = resolveMap(pronouns);
  const isSingular = p.plurality === "singular";
  const resolvedName = name || "___";

  return text
    // Name — when no name is set (cold visitor) we render an underscored
    // placeholder so the sentence still scans and signals "fill me in".
    // Fix indefinite-article agreement ("a {NAME}" → "an Alex") before filling
    // the remaining {NAME} tokens.
    .replace(ARTICLE_BEFORE_NAME_RE, (_m, art: string, sp: string) =>
      indefiniteArticle(art, resolvedName) + sp + resolvedName)
    .replace(/\{NAME\}/g, resolvedName)
    .replace(/\{NAME_POSSESSIVE\}/g, possessiveName(resolvedName))

    // Subject-pronoun contraction — defense-in-depth for stale/legacy text
    // (new writes are expanded to an explicit pair before storage). Must run
    // BEFORE the generic {Subj}/{SUBJ} substitution below, or a plural set
    // would fall through to the literal (never-valid) "They's". Function
    // replacers so subjectContraction() can peek at the following text to
    // disambiguate is/has (see HAS_ONLY_FOLLOWING_WORDS).
    .replace(/\{Subj\}['’]s\b/g, (m: string, offset: number, full: string) =>
      subjectContraction(p.subj, isSingular, true, full.slice(offset + m.length)))
    .replace(/\{SUBJ\}['’]s\b/g, (m: string, offset: number, full: string) =>
      subjectContraction(p.subj, isSingular, false, full.slice(offset + m.length)))

    // Verb conjugation: {singular_form|plural_form}
    .replace(/\{([^|{}]+)\|([^|{}]+)\}/g, (_, singular, plural) =>
      isSingular ? singular : plural
    )

    // New pronoun tokens — capitalized (sentence-start) first
    .replace(/\{Subj\}/g,     cap(p.subj))
    .replace(/\{SUBJ\}/g,     p.subj)
    .replace(/\{Obj\}/g,      cap(p.obj))
    .replace(/\{OBJ\}/g,      p.obj)
    .replace(/\{Poss\}/g,     cap(p.poss))
    .replace(/\{POSS\}/g,     p.poss)
    .replace(/\{Poss_Pro\}/g, cap(p.possPro))
    .replace(/\{POSS_PRO\}/g, p.possPro)
    .replace(/\{Refl\}/g,     cap(p.refl))
    .replace(/\{REFL\}/g,     p.refl)

    // Legacy tokens — kept for backward compat with old facts
    .replace(/\{Himself\}/g, cap(p.refl))
    .replace(/\{himself\}/g, p.refl)
    .replace(/\{He's\}/g,    (m: string, offset: number, full: string) =>
      subjectContraction(p.subj, isSingular, true, full.slice(offset + m.length)))
    .replace(/\{he's\}/g,    (m: string, offset: number, full: string) =>
      subjectContraction(p.subj, isSingular, false, full.slice(offset + m.length)))
    .replace(/\{Him\}/g,     cap(p.obj))
    .replace(/\{him\}/g,     p.obj)
    .replace(/\{His\}/g,     cap(p.poss))
    .replace(/\{his\}/g,     p.poss)
    .replace(/\{He\}/g,      cap(p.subj))
    .replace(/\{he\}/g,      p.subj);
}

/**
 * Tokenize a plain-English fact into a template.
 * Used for backward-compat tokenization on submission (non-AI path).
 */
export function tokenizeFact(text: string): string {
  return text
    .replace(/\{First_Name\}\s*\{Last_Name\}/g, "{NAME}")
    .replace(/\bHimself\b/g, "{REFL}")
    .replace(/\bhimself\b/g, "{REFL}")
    // "'s" is ambiguous (is/has); expanding always keeps this path from ever
    // emitting the never-valid "{Subj}'s" → "They's". Peeks at the following
    // word to avoid "he's got it" → "{Subj} {is|are} got it" (see
    // HAS_ONLY_FOLLOWING_WORDS / nextWordIsHasSignal).
    .replace(/\bHe's\b/g,    (m: string, offset: number, full: string) =>
      `{Subj} {${nextWordIsHasSignal(full.slice(offset + m.length)) ? "has|have" : "is|are"}}`)
    .replace(/\bhe's\b/g,    (m: string, offset: number, full: string) =>
      `{SUBJ} {${nextWordIsHasSignal(full.slice(offset + m.length)) ? "has|have" : "is|are"}}`)
    .replace(/\bHim\b/g,     "{Obj}")
    .replace(/\bhim\b/g,     "{OBJ}")
    .replace(/\bHis\b/g,     "{Poss}")
    .replace(/\bhis\b/g,     "{POSS}")
    .replace(/\bHe\b/g,      "{Subj}")
    .replace(/\bhe\b/g,      "{SUBJ}");
}

/**
 * Detect whether a template contains any pronoun or verb-conjugation tokens.
 */
export function hasPronouns(template: string): boolean {
  return /\{(SUBJ|OBJ|POSS|POSS_PRO|REFL|Subj|Obj|Poss|Poss_Pro|Refl|he|him|his|himself|He|Him|His|Himself|he's|He's|[^|{}]+\|[^|{}]+)\}/.test(template);
}

/**
 * Like `renderFact`, but returns a list of text segments where the name
 * substitution is annotated with `isName: true`. Use this when the caller
 * needs to render the name in a different colour (e.g. canvas or a React span)
 * while rendering all other tokens normally.
 *
 * @example
 *   renderFactSegments("{NAME} once punched a shark", "Sam", "she/her")
 *   // → [{ text: "Sam", isName: true }, { text: " once punched a shark", isName: false }]
 */
export function renderFactSegments(
  text: string,
  name: string,
  pronouns: string = "he/him",
): { text: string; isName: boolean }[] {
  const p = resolveMap(pronouns);
  const isSingular = p.plurality === "singular";
  const resolvedName = name || "___";

  // Distinct NUL-prefixed placeholders — survive the pronoun substitution
  // passes intact, then we split on them to identify which text segments are
  // the name vs. its possessive (each needs different final text, so they
  // can't share one placeholder without losing which token produced it).
  const PLACEHOLDER = "\u0000\u0001\u0000";
  const POSSESSIVE_PLACEHOLDER = "\u0000\u0002\u0000";

  const processed = text
    // Fix indefinite-article agreement against the resolved name before swapping
    // {NAME} for the placeholder (e.g. "a {NAME}" → "an " + placeholder).
    .replace(ARTICLE_BEFORE_NAME_RE, (_m, art: string, sp: string) =>
      indefiniteArticle(art, resolvedName) + sp + PLACEHOLDER)
    .replace(/\{NAME\}/g, PLACEHOLDER)
    .replace(/\{NAME_POSSESSIVE\}/g, POSSESSIVE_PLACEHOLDER)

    // Subject-pronoun contraction — see renderFact() for rationale. Must run
    // before the generic {Subj}/{SUBJ} substitution below.
    .replace(/\{Subj\}['’]s\b/g, (m: string, offset: number, full: string) =>
      subjectContraction(p.subj, isSingular, true, full.slice(offset + m.length)))
    .replace(/\{SUBJ\}['’]s\b/g, (m: string, offset: number, full: string) =>
      subjectContraction(p.subj, isSingular, false, full.slice(offset + m.length)))

    .replace(/\{([^|{}]+)\|([^|{}]+)\}/g, (_, singular, plural) =>
      isSingular ? singular : plural
    )
    .replace(/\{Subj\}/g,     cap(p.subj))
    .replace(/\{SUBJ\}/g,     p.subj)
    .replace(/\{Obj\}/g,      cap(p.obj))
    .replace(/\{OBJ\}/g,      p.obj)
    .replace(/\{Poss\}/g,     cap(p.poss))
    .replace(/\{POSS\}/g,     p.poss)
    .replace(/\{Poss_Pro\}/g, cap(p.possPro))
    .replace(/\{POSS_PRO\}/g, p.possPro)
    .replace(/\{Refl\}/g,     cap(p.refl))
    .replace(/\{REFL\}/g,     p.refl)
    .replace(/\{Himself\}/g,  cap(p.refl))
    .replace(/\{himself\}/g,  p.refl)
    .replace(/\{He's\}/g,     (m: string, offset: number, full: string) =>
      subjectContraction(p.subj, isSingular, true, full.slice(offset + m.length)))
    .replace(/\{he's\}/g,     (m: string, offset: number, full: string) =>
      subjectContraction(p.subj, isSingular, false, full.slice(offset + m.length)))
    .replace(/\{Him\}/g,      cap(p.obj))
    .replace(/\{him\}/g,      p.obj)
    .replace(/\{His\}/g,      cap(p.poss))
    .replace(/\{his\}/g,      p.poss)
    .replace(/\{He\}/g,       cap(p.subj))
    .replace(/\{he\}/g,       p.subj);

  const parts = processed.split(new RegExp(`(${PLACEHOLDER}|${POSSESSIVE_PLACEHOLDER})`));
  const out: { text: string; isName: boolean }[] = [];
  for (const part of parts) {
    if (part === PLACEHOLDER) {
      out.push({ text: resolvedName, isName: true });
    } else if (part === POSSESSIVE_PLACEHOLDER) {
      out.push({ text: possessiveName(resolvedName), isName: true });
    } else if (part) {
      out.push({ text: part, isName: false });
    }
  }
  return out;
}
