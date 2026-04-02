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
 * Renders a tokenized fact template personalized to a specific person.
 * Uses singular verb form for {singular|plural} when the subject is he/she.
 */
export function renderPersonalized(template: string, name: string, pronouns: string | null | undefined): string {
  const map = parsePronounMap(name, pronouns);
  const useSingular = !["they"].includes((pronouns ?? "they/them").toLowerCase().split("/")[0] ?? "they");

  return template.replace(/\{([^{}]+)\}/g, (_match, inner: string) => {
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
