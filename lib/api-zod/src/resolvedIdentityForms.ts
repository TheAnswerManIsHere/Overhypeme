/**
 * Resolved identity/token-form contract (PR-A follow-up, plan §11.5).
 *
 * The template grammar (`templateGrammar.ts`) defines which tokens are
 * ALLOWED; this module defines what each token RESOLVES TO for a given
 * identity, and the ONE rendering function that substitutes them. Before this
 * module, pronoun-form derivation (subj→poss/possPro/refl, singular/plural
 * branch selection) lived only inside `renderCanonical.ts` (api-server), while
 * the budget-projection helper (`promptIdentityBudget.ts`) reserved space per
 * token WITHOUT sharing that derivation — two independent definitions that
 * could silently drift. Now there is one: `resolveIdentityForms` produces the
 * resolved forms, `renderTemplateWithIdentityForms` is the one substitution
 * definition, and `promptIdentityBudget.ts`'s reserves are typed against the
 * same token-key set. `renderCanonical.ts` becomes a thin wrapper.
 *
 * Pure, dependency-light (only `templateGrammar`), so it is safe for both
 * frontend and backend to import.
 */

import { ALLOWED_SIMPLE_TOKENS } from "./templateGrammar";

/** The exact token keys a resolved identity supplies — the same twelve simple
 *  tokens `templateGrammar.ts` allows (kept as a literal union here since
 *  `ALLOWED_SIMPLE_TOKENS` itself is widened to `ReadonlySet<string>`;
 *  `unresolvedSimpleTokens()` below is the runtime cross-check that the two
 *  lists can never drift). */
export type ResolvedIdentityTokenKey =
  | "NAME" | "NAME_POSSESSIVE"
  | "SUBJ" | "Subj"
  | "OBJ" | "Obj"
  | "POSS" | "Poss"
  | "POSS_PRO" | "Poss_Pro"
  | "REFL" | "Refl";

export type ResolvedIdentityTokenMap = Record<ResolvedIdentityTokenKey, string>;

export interface ResolvedIdentityForms {
  tokens: ResolvedIdentityTokenMap;
  /** Governs {singular|plural} conjugation-pair branch selection: "plural"
   *  picks the right-hand branch (they/them and any pronoun set not
   *  he/she — the historical default), "singular" picks the left-hand
   *  branch. */
  grammaticalNumber: "singular" | "plural";
}

/** Runtime cross-check: every simple token the grammar allows has a key in
 *  `ResolvedIdentityTokenMap`. Exercised by a test, not a startup assertion,
 *  so a future grammar addition fails loudly in CI rather than silently. */
export function unresolvedSimpleTokens(): string[] {
  const known = new Set<ResolvedIdentityTokenKey>([
    "NAME", "NAME_POSSESSIVE", "SUBJ", "Subj", "OBJ", "Obj",
    "POSS", "Poss", "POSS_PRO", "Poss_Pro", "REFL", "Refl",
  ]);
  return [...ALLOWED_SIMPLE_TOKENS].filter((t) => !known.has(t as ResolvedIdentityTokenKey));
}

/** Possessive form of a name. Per product decision we ALWAYS append "'s" —
 *  including names already ending in "s" (Chris → Chris's) — so the rule is
 *  unambiguous and viewer-independent. Empty input yields empty output. */
export function possessive(name: string): string {
  return name ? `${name}'s` : "";
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Resolve a name + "subj/obj" pronoun string (e.g. "he/him", "she/her",
 * "they/them") into the full token-form map used by both budget projection
 * and template rendering. Pure. Defaults to they/them when `pronouns` is
 * absent or malformed — the historical `renderCanonical`/`renderPersonalized`
 * behavior, preserved exactly.
 */
export function resolveIdentityForms(name: string, pronouns: string | null | undefined): ResolvedIdentityForms {
  const lower = (pronouns ?? "they/them").toLowerCase().trim();
  const [subj = "they", obj = "them"] = lower.split("/");

  let poss: string;
  let possPro: string;
  let refl: string;
  if (subj === "he") {
    poss = "his"; possPro = "his"; refl = "himself";
  } else if (subj === "she") {
    poss = "her"; possPro = "hers"; refl = "herself";
  } else {
    poss = "their"; possPro = "theirs"; refl = "themselves";
  }

  return {
    tokens: {
      NAME: name,
      NAME_POSSESSIVE: possessive(name),
      SUBJ: subj, Subj: capitalize(subj),
      OBJ: obj, Obj: capitalize(obj),
      POSS: poss, Poss: capitalize(poss),
      POSS_PRO: possPro, Poss_Pro: capitalize(possPro),
      REFL: refl, Refl: capitalize(refl),
    },
    // Mirrors the historical rule EXACTLY: only the literal subject "they"
    // renders the plural conjugation branch — every other subject (he, she,
    // any neopronoun, malformed/absent input) renders SINGULAR. This is not
    // "everything but he/she is plural" — a neopronoun subject (e.g. "xe")
    // gets singular verbs, same as he/she, because it isn't literally "they".
    grammaticalNumber: subj === "they" ? "plural" : "singular",
  };
}

// Matches a standalone indefinite article ("a"/"an", any case) immediately
// before a {NAME} token, capturing the whitespace between them.
const ARTICLE_BEFORE_NAME_RE = /\b([Aa]n?)(\s+)\{NAME\}/g;

/**
 * Choose "a" or "an" so the indefinite article agrees with the word that
 * follows it once {NAME} is filled in ("a {NAME}" → "an Alex" but "a David").
 * Original capitalization is preserved. Agreement is decided purely from the
 * first letter (vowel a/e/i/o/u → "an"); rare phonetic exceptions ("a Uma",
 * "an Hugo") are not special-cased.
 */
function indefiniteArticle(original: string, nextWord: string): string {
  const article = /^[aeiou]/i.test(nextWord) ? "an" : "a";
  if (/^[A-Z]/.test(original)) {
    return article.charAt(0).toUpperCase() + article.slice(1);
  }
  return article;
}

/**
 * Render a template against resolved identity forms: fixes indefinite-article
 * agreement before {NAME}, substitutes every recognized simple token, and
 * selects the correct {singular|plural} conjugation-pair branch. Pure. THE
 * single rendering definition — `renderPersonalized`/`renderCanonical`
 * (api-server) delegate to this rather than reimplementing substitution.
 */
export function renderTemplateWithIdentityForms(template: string, forms: ResolvedIdentityForms): string {
  const useSingular = forms.grammaticalNumber === "singular";
  return template
    .replace(ARTICLE_BEFORE_NAME_RE, (_m, art: string, sp: string) =>
      indefiniteArticle(art, forms.tokens.NAME) + sp + "{NAME}")
    .replace(/\{([^{}]+)\}/g, (_match, inner: string) => {
      if (inner in forms.tokens) {
        return forms.tokens[inner as ResolvedIdentityTokenKey];
      }
      if (inner.includes("|")) {
        const parts = inner.split("|");
        return useSingular ? (parts[0] ?? _match) : (parts[parts.length - 1] ?? _match);
      }
      return _match;
    });
}
