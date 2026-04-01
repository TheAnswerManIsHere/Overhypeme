/**
 * Renders a tokenized fact template into a canonical plain-English string
 * using a fixed canonical identity: name "Alex", they/them pronouns, plural verbs.
 *
 * This canonical form is used as the basis for pgvector embeddings so that
 * duplicate checks between plain-English submissions and stored templates
 * work without token-syntax noise.
 */

const CANONICAL_NAME = "Alex";

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
  return template.replace(/\{([^{}]+)\}/g, (_match, inner: string) => {
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
