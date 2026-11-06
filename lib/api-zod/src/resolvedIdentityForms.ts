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
 *
 * @purpose Resolves a name and a slash-form or six-part custom pronoun set into the form each template token takes (custom forms and verb number kept; malformed input falls back to they/them), and defines the substitution function renderCanonical wraps, with the token-key set the prompt-identity budget is typed against.
 * @subsystem token-rendering
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
 * "they/them", "xe/xem", "ze/zir" — the full `PRONOUN_ALLOWLIST` set) into
 * the full token-form map used by both budget projection and template
 * rendering. Pure. Defaults to they/them when `pronouns` is absent or
 * malformed — the historical `renderCanonical`/`renderPersonalized` behavior.
 *
 * A custom pronoun set, `subj|obj|poss|possPro|refl|s|p` (the pronoun
 * editor's `serializeCustom`), resolves to its own forms and its own verb
 * number, the way the client's `resolveMap` (`render-fact.ts`) does: an empty
 * form falls back to the they/them form in its slot, `p` picks the plural
 * branch and `s` the singular. Until identity-flow Phase 2 every such set
 * fell back to they/them here, so a stored custom choice rendered wrongly in
 * every server-made output. A pipe string without exactly six parts is
 * malformed and still falls back, never leaking its literal text.
 */
export function resolveIdentityForms(name: string, pronouns: string | null | undefined): ResolvedIdentityForms {
  const custom = parseCustomPronounSet(pronouns);
  if (custom) return formsFrom(name, custom);
  const raw = (pronouns ?? "they/them").toLowerCase().trim();
  const lower = raw.includes("|") ? "they/them" : raw;
  const [subj = "they", obj = "them"] = lower.split("/");

  let poss: string;
  let possPro: string;
  let refl: string;
  if (subj === "he") {
    poss = "his"; possPro = "his"; refl = "himself";
  } else if (subj === "she") {
    poss = "her"; possPro = "hers"; refl = "herself";
  } else if (subj === "ze") {
    poss = "zir"; possPro = "zirs"; refl = "zirself";
  } else if (subj === "xe") {
    poss = "xyr"; possPro = "xyrs"; refl = "xemself";
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

/** A custom pronoun set's five forms and verb number. */
interface CustomPronounForms {
  subj: string; obj: string; poss: string; possPro: string; refl: string;
  grammaticalNumber: "singular" | "plural";
}

/** A custom pronoun set's five forms exactly as stored (any may be empty), and its verb number. */
export interface CustomPronounSetParts {
  subj: string; obj: string; poss: string; possPro: string; refl: string;
  plural: boolean;
}

/**
 * THE parser of the custom pronoun format, `subj|obj|poss|possPro|refl|s|p`
 * (the pronoun editor's `serializeCustom`), shared by the browser and the
 * server so the two can never read one stored set differently: exactly six
 * parts, the sixth `s` or `p`, each form trimmed and kept as stored, empty
 * ones included (the editor needs them). Null for anything else.
 */
export function splitCustomPronounSet(pronouns: string | null | undefined): CustomPronounSetParts | null {
  if (!pronouns || !pronouns.includes("|")) return null;
  const parts = pronouns.split("|").map((p) => p.trim());
  if (parts.length !== 6) return null;
  const [subj, obj, poss, possPro, refl, marker] = parts as [string, string, string, string, string, string];
  if (marker !== "s" && marker !== "p") return null;
  return { subj, obj, poss, possPro, refl, plural: marker === "p" };
}

/**
 * A custom set ready to render: `splitCustomPronounSet`, refusing a set with
 * no form at all, each empty form filled from they/them in its slot.
 */
export function parseCustomPronounSet(pronouns: string | null | undefined): CustomPronounForms | null {
  const split = splitCustomPronounSet(pronouns);
  if (!split) return null;
  const { subj, obj, poss, possPro, refl } = split;
  if (![subj, obj, poss, possPro, refl].some(Boolean)) return null;
  return {
    subj: subj || "they",
    obj: obj || "them",
    poss: poss || "their",
    possPro: possPro || "theirs",
    refl: refl || "themselves",
    grammaticalNumber: split.plural ? "plural" : "singular",
  };
}

function formsFrom(name: string, f: CustomPronounForms): ResolvedIdentityForms {
  return {
    tokens: {
      NAME: name,
      NAME_POSSESSIVE: possessive(name),
      SUBJ: f.subj, Subj: capitalize(f.subj),
      OBJ: f.obj, Obj: capitalize(f.obj),
      POSS: f.poss, Poss: capitalize(f.poss),
      POSS_PRO: f.possPro, Poss_Pro: capitalize(f.possPro),
      REFL: f.refl, Refl: capitalize(f.refl),
    },
    grammaticalNumber: f.grammaticalNumber,
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

/**
 * The same render as `renderTemplateWithIdentityForms`, in runs, with the
 * name and its possessive marked (`isName`) so a caption can draw them in
 * their own colour (#870). Joining the runs' text gives exactly
 * `renderTemplateWithIdentityForms(template, forms)`; a test holds the two equal.
 */
export function renderTemplateSegments(
  template: string,
  forms: ResolvedIdentityForms,
): { text: string; isName: boolean }[] {
  const useSingular = forms.grammaticalNumber === "singular";
  const withArticles = template.replace(ARTICLE_BEFORE_NAME_RE, (_m, art: string, sp: string) =>
    indefiniteArticle(art, forms.tokens.NAME) + sp + "{NAME}");
  const out: { text: string; isName: boolean }[] = [];
  const push = (text: string, isName: boolean) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && !last.isName && !isName) last.text += text;
    else out.push({ text, isName });
  };
  const re = /\{([^{}]+)\}/g;
  let from = 0;
  for (let m = re.exec(withArticles); m; m = re.exec(withArticles)) {
    push(withArticles.slice(from, m.index), false);
    const inner = m[1]!;
    if (inner in forms.tokens) {
      push(forms.tokens[inner as ResolvedIdentityTokenKey], inner === "NAME" || inner === "NAME_POSSESSIVE");
    } else if (inner.includes("|")) {
      const parts = inner.split("|");
      push((useSingular ? parts[0] : parts[parts.length - 1]) ?? m[0], false);
    } else {
      push(m[0], false);
    }
    from = m.index + m[0].length;
  }
  push(withArticles.slice(from), false);
  return out;
}
