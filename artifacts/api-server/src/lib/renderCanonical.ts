/**
 * Renders a tokenized fact template into a canonical plain-English string
 * using a fixed canonical identity: name "Alex", they/them pronouns, plural verbs.
 *
 * This canonical form is used as the basis for pgvector embeddings so that
 * duplicate checks between plain-English submissions and stored templates
 * work without token-syntax noise.
 */

export const CANONICAL_NAME = "Alex";

/**
 * Canonical placeholder names the renderer injects for the personalized subject.
 * The subject-name semantic-entity guard matches against this list (exact,
 * case-insensitive). Only canonical placeholders the renderer produces belong
 * here — NEVER arbitrary real user names. Today there is exactly one ("Alex");
 * keeping it a list lets a future placeholder be added without touching call
 * sites.
 */
export const CANONICAL_SUBJECT_NAMES: readonly string[] = [CANONICAL_NAME];

const TOKEN_MAP: Record<string, string> = {
  NAME: CANONICAL_NAME,
  SUBJ: "they",
  Subj: "They",
  OBJ: "them",
  Obj: "Them",
  POSS: "their",
  Poss: "Their",
  POSS_PRO: "theirs",
  Poss_Pro: "Theirs",
  REFL: "themselves",
  Refl: "Themselves",
};

// Matches a standalone indefinite article ("a"/"an", any case) immediately
// before a {NAME} token, capturing the whitespace between them.
const ARTICLE_BEFORE_NAME_RE = /\b([Aa]n?)(\s+)\{NAME\}/g;

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
  if (/^[A-Z]/.test(original)) {
    return article.charAt(0).toUpperCase() + article.slice(1);
  }
  return article;
}

/**
 * Renders a template to canonical plain English.
 * - {NAME} → "Alex"
 * - {SUBJ}/{Subj} → "they"/"They"
 * - {OBJ}/{Obj} → "them"/"Them"
 * - {POSS}/{Poss} → "their"/"Their"
 * - {POSS_PRO}/{Poss_Pro} → "theirs"/"Theirs"
 * - {REFL}/{Refl} → "themselves"/"Themselves"
 * - {singular|plural} → plural form (right side)
 */
export function renderCanonical(template: string): string {
  return template
    // Fix indefinite-article agreement ("a {NAME}" → "an Alex") before the
    // token substitution fills {NAME} with the canonical name.
    .replace(ARTICLE_BEFORE_NAME_RE, (_m, art: string, sp: string) =>
      indefiniteArticle(art, CANONICAL_NAME) + sp + "{NAME}")
    .replace(/\{([^{}]+)\}/g, (_match, inner: string) => {
      if (inner in TOKEN_MAP) {
        return TOKEN_MAP[inner];
      }
      if (inner.includes("|")) {
        const parts = inner.split("|");
        return parts[parts.length - 1];
      }
      return _match;
    });
}

/**
 * Parses a "subj/obj" pronoun string (e.g. "he/him", "she/her", "they/them")
 * into a full pronoun map for token substitution.
 */
function parsePronounMap(name: string, pronouns: string | null | undefined): Record<string, string> {
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
    NAME: name,
    SUBJ: subj,   Subj: subj.charAt(0).toUpperCase() + subj.slice(1),
    OBJ: obj,     Obj: obj.charAt(0).toUpperCase() + obj.slice(1),
    POSS: poss,   Poss: poss.charAt(0).toUpperCase() + poss.slice(1),
    POSS_PRO: possPro,  Poss_Pro: possPro.charAt(0).toUpperCase() + possPro.slice(1),
    REFL: refl,   Refl: refl.charAt(0).toUpperCase() + refl.slice(1),
  };
}

/**
 * After personalization a fact string should carry no residual identity tokens
 * ({NAME}/{SUBJ}/…) and no leftover {singular|plural} pairs. We intentionally do
 * NOT flag every `{`/`}` — supporting text, math, or emoji shortcodes can carry
 * braces legitimately — only the recognized template-token shapes. Used to guard
 * render-time prompt inputs against leaking template syntax to the image model.
 */
const UNRESOLVED_FACT_TOKEN_RE =
  /\{(?:NAME|SUBJ|Subj|OBJ|Obj|POSS|Poss|POSS_PRO|Poss_Pro|REFL|Refl)\}|\{[^{}|]+\|[^{}|]+\}/;

export function hasUnresolvedFactTokens(text: string): boolean {
  return UNRESOLVED_FACT_TOKEN_RE.test(text);
}

/**
 * Narrow check for SUBJECT identity tokens only ({NAME}/{SUBJ}/{OBJ}/{POSS}/
 * {POSS_PRO}/{REFL} in either case). Deliberately excludes the {singular|plural}
 * pluralization pairs that `hasUnresolvedFactTokens` also matches — those are
 * not the subject, so a legitimate non-subject template referent that happens to
 * carry a pluralization pair must not be treated as the subject.
 */
const SUBJECT_IDENTITY_TOKEN_RE =
  /\{(?:NAME|SUBJ|Subj|OBJ|Obj|POSS|Poss|POSS_PRO|Poss_Pro|REFL|Refl)\}/;

export function hasSubjectIdentityToken(text: string): boolean {
  return SUBJECT_IDENTITY_TOKEN_RE.test(text);
}

// ─── Subject-name semantic-entity guard ──────────────────────────────────────

const CANONICAL_SUBJECT_NAMES_LC = new Set(
  CANONICAL_SUBJECT_NAMES.map((n) => n.toLowerCase()),
);

/**
 * True when a semantic entity is actually the personalized SUBJECT rather than a
 * non-subject referent. The personalized subject is owned by the identity/
 * rendering layer and must never be a semantic entity (otherwise it pollutes the
 * visual prompt and the image-prompt validator forces it to be echoed).
 *
 * Matches when `surfaceText` or `normalizedText` EXACTLY equals a canonical
 * placeholder name (case-insensitive, trimmed) — so multi-word referents that
 * merely contain the name ("Alex Honnold") are preserved — or when either field
 * still carries a subject identity token ({NAME}/{SUBJ}/…). Structurally typed
 * so this leaf module stays decoupled from the taxonomy entity type.
 */
export function isSubjectNameSemanticEntity(
  entity: { surfaceText: string; normalizedText: string },
): boolean {
  const surface = entity.surfaceText.trim();
  const normalized = entity.normalizedText.trim();
  if (CANONICAL_SUBJECT_NAMES_LC.has(surface.toLowerCase())) return true;
  if (CANONICAL_SUBJECT_NAMES_LC.has(normalized.toLowerCase())) return true;
  return hasSubjectIdentityToken(surface) || hasSubjectIdentityToken(normalized);
}

/** Drop any semantic entities that are actually the personalized subject. */
export function stripSubjectNameSemanticEntities<
  T extends { surfaceText: string; normalizedText: string },
>(entities: readonly T[]): T[] {
  return entities.filter((e) => !isSubjectNameSemanticEntity(e));
}

/**
 * Renders a tokenized fact template personalized to a specific person.
 * Uses singular verb form for {singular|plural} when the subject is he/she.
 */
export function renderPersonalized(template: string, name: string, pronouns: string | null | undefined): string {
  const map = parsePronounMap(name, pronouns);
  const useSingular = !["they"].includes((pronouns ?? "they/them").toLowerCase().split("/")[0] ?? "they");

  return template
    // Fix indefinite-article agreement against the personalized name ("a {NAME}"
    // → "an Alex" / "a David") before the token substitution fills {NAME}.
    .replace(ARTICLE_BEFORE_NAME_RE, (_m, art: string, sp: string) =>
      indefiniteArticle(art, name) + sp + "{NAME}")
    .replace(/\{([^{}]+)\}/g, (_match, inner: string) => {
      if (inner in map) {
        return map[inner];
      }
      if (inner.includes("|")) {
        const parts = inner.split("|");
        return useSingular ? (parts[0] ?? _match) : (parts[parts.length - 1] ?? _match);
      }
      return _match;
    });
}
