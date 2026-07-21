/**
 * Renders a tokenized fact template into a canonical plain-English string
 * using a fixed canonical identity: name "Alex", they/them pronouns, plural verbs.
 *
 * This canonical form is used as the basis for pgvector embeddings so that
 * duplicate checks between plain-English submissions and stored templates
 * work without token-syntax noise.
 *
 * Token resolution + substitution are owned by the shared
 * `@workspace/api-zod` module (`resolvedIdentityForms.ts`) — this file is a
 * thin, byte-identical-output wrapper so budget projection and rendering can
 * never drift on pronoun-form derivation.
 */

import {
  resolveIdentityForms,
  renderTemplateWithIdentityForms,
  possessive as possessiveShared,
} from "@workspace/api-zod";

export const CANONICAL_NAME = "Alex";

export const possessive = possessiveShared;

/**
 * Canonical placeholder names the renderer injects for the personalized subject.
 * The subject-name semantic-entity guard matches against this list (exact,
 * case-insensitive). Only canonical placeholders the renderer produces belong
 * here — NEVER arbitrary real user names. Today there is exactly one ("Alex");
 * keeping it a list lets a future placeholder be added without touching call
 * sites.
 */
export const CANONICAL_SUBJECT_NAMES: readonly string[] = [CANONICAL_NAME];

const CANONICAL_FORMS = resolveIdentityForms(CANONICAL_NAME, "they/them");

/**
 * Renders a template to canonical plain English.
 * - {NAME} → "Alex"
 * - {NAME_POSSESSIVE} → "Alex's"
 * - {SUBJ}/{Subj} → "they"/"They"
 * - {OBJ}/{Obj} → "them"/"Them"
 * - {POSS}/{Poss} → "their"/"Their"
 * - {POSS_PRO}/{Poss_Pro} → "theirs"/"Theirs"
 * - {REFL}/{Refl} → "themselves"/"Themselves"
 * - {singular|plural} → plural form (right side)
 */
export function renderCanonical(template: string): string {
  return renderTemplateWithIdentityForms(template, CANONICAL_FORMS);
}

/**
 * After personalization a fact string should carry no residual identity tokens
 * ({NAME}/{NAME_POSSESSIVE}/{SUBJ}/…) and no leftover {singular|plural} pairs. We
 * intentionally do NOT flag every `{`/`}` — supporting text, math, or emoji
 * shortcodes can carry braces legitimately — only the recognized template-token
 * shapes. Used to guard render-time prompt inputs against leaking template syntax
 * to the image model.
 */
const UNRESOLVED_FACT_TOKEN_RE =
  /\{(?:NAME_POSSESSIVE|NAME|SUBJ|Subj|OBJ|Obj|POSS_PRO|Poss_Pro|POSS|Poss|REFL|Refl)\}|\{[^{}|]+\|[^{}|]+\}/;

export function hasUnresolvedFactTokens(text: string): boolean {
  return UNRESOLVED_FACT_TOKEN_RE.test(text);
}

/**
 * Narrow check for SUBJECT identity tokens only ({NAME}/{NAME_POSSESSIVE}/{SUBJ}/
 * {OBJ}/{POSS}/{POSS_PRO}/{REFL} in either case). Deliberately excludes the
 * {singular|plural} pluralization pairs that `hasUnresolvedFactTokens` also
 * matches — those are not the subject, so a legitimate non-subject template
 * referent that happens to carry a pluralization pair must not be treated as the
 * subject.
 */
const SUBJECT_IDENTITY_TOKEN_RE =
  /\{(?:NAME_POSSESSIVE|NAME|SUBJ|Subj|OBJ|Obj|POSS_PRO|Poss_Pro|POSS|Poss|REFL|Refl)\}/;

export function hasSubjectIdentityToken(text: string): boolean {
  return SUBJECT_IDENTITY_TOKEN_RE.test(text);
}

// ─── Subject-name semantic-entity guard ──────────────────────────────────────

/**
 * Exact surface forms that ARE the personalized subject: each canonical
 * placeholder name plus its possessive ("alex", "alex's"). Lower-cased for
 * case-insensitive exact matching. The possessive form is included because the
 * renderer can emit `Alex's` (from {NAME_POSSESSIVE}); once rendered it is no
 * longer a token, so the token regex alone would miss it. Kept to EXACT forms
 * only — never substring — so multi-word referents that merely contain the name
 * ("Alex Honnold", "Alex Honnold's climb") are preserved (PR #111).
 */
const CANONICAL_SUBJECT_NAME_FORMS_LC = new Set(
  CANONICAL_SUBJECT_NAMES.flatMap((n) => [n.toLowerCase(), possessive(n).toLowerCase()]),
);

/**
 * True when a semantic entity is actually the personalized SUBJECT rather than a
 * non-subject referent. The personalized subject is owned by the identity/
 * rendering layer and must never be a semantic entity (otherwise it pollutes the
 * visual prompt and the image-prompt validator forces it to be echoed).
 *
 * Matches when `surfaceText` or `normalizedText` EXACTLY equals a canonical
 * placeholder name or its possessive (case-insensitive, trimmed: "Alex" /
 * "Alex's") — so multi-word referents that merely contain the name ("Alex
 * Honnold", "Alex Honnold's climb") are preserved — or when either field still
 * carries a subject identity token ({NAME}/{NAME_POSSESSIVE}/{SUBJ}/…).
 * Structurally typed and tolerant of missing/partial fields, since it also
 * guards possibly-stale stored enrichment blobs that may omit `normalizedText`.
 */
export function isSubjectNameSemanticEntity(
  entity: { surfaceText?: string | null; normalizedText?: string | null },
): boolean {
  const surface = (entity.surfaceText ?? "").trim();
  const normalized = (entity.normalizedText ?? "").trim();
  if (surface && CANONICAL_SUBJECT_NAME_FORMS_LC.has(surface.toLowerCase())) return true;
  if (normalized && CANONICAL_SUBJECT_NAME_FORMS_LC.has(normalized.toLowerCase())) return true;
  return hasSubjectIdentityToken(surface) || hasSubjectIdentityToken(normalized);
}

/** Drop any semantic entities that are actually the personalized subject. */
export function stripSubjectNameSemanticEntities<
  T extends { surfaceText?: string | null; normalizedText?: string | null },
>(entities: readonly T[]): T[] {
  return entities.filter((e) => !isSubjectNameSemanticEntity(e));
}

/**
 * Renders a tokenized fact template personalized to a specific person. Uses
 * the singular {singular|plural} branch unless the subject pronoun is
 * literally "they" (so he/she AND any neopronoun subject render singular).
 */
export function renderPersonalized(template: string, name: string, pronouns: string | null | undefined): string {
  return renderTemplateWithIdentityForms(template, resolveIdentityForms(name, pronouns));
}
