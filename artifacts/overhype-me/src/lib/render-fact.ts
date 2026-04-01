export type PronounSet = "he/him" | "she/her" | "they/them";

/** Whether verb conjugation should use singular (he/she) or plural (they) forms. */
type Plurality = "singular" | "plural";

interface PronounMap {
  subj: string;     // he, she, they
  obj: string;      // him, her, them
  poss: string;     // his, her, their
  possPro: string;  // his, hers, theirs
  refl: string;     // himself, herself, themselves
  plurality: Plurality;
}

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
};

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function resolveMap(subject: string, object: string): PronounMap {
  const lc = subject.toLowerCase().trim();
  if (KNOWN_MAPS[lc]) return KNOWN_MAPS[lc];
  const sub = subject.trim() || "they";
  const obj = object.trim() || "them";
  return {
    subj: sub, obj, poss: obj, possPro: obj,
    refl: obj + "self",
    plurality: "singular",
  };
}

/**
 * Replace all tokens in a fact template.
 *
 * Pronoun tokens:
 *   {SUBJ} / {Subj}       → he / He / she / She / they / They
 *   {OBJ} / {Obj}         → him / Her / them
 *   {POSS} / {Poss}       → his / her / their
 *   {POSS_PRO} / {Poss_Pro} → his / hers / theirs
 *   {REFL} / {Refl}       → himself / herself / themselves
 *
 * Verb conjugation (he/she get left form, they get right form):
 *   {does|do}  {doesn't|don't}  {was|were}  etc.
 *
 * Legacy tokens (backward compat):
 *   {he} {Him} {his} {His} {himself} {Himself} {he's} {He's} etc.
 *
 * Name:
 *   {NAME}  → user name
 */
export function renderFact(
  text: string,
  name: string,
  pronounSubject: string = "he",
  pronounObject: string = "him",
): string {
  const p = resolveMap(pronounSubject, pronounObject);
  const isSingular = p.plurality === "singular";

  return text
    // Name
    .replace(/\{NAME\}/g, name || "David Franklin")

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

    // Legacy tokens — keep for backward compat with old facts
    .replace(/\{Himself\}/g, cap(p.refl))
    .replace(/\{himself\}/g, p.refl)
    .replace(/\{He's\}/g,    cap(p.subj) + "'s")
    .replace(/\{he's\}/g,    p.subj + "'s")
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
    .replace(/\bchuck norris\b/gi, "{NAME}")
    .replace(/\bHimself\b/g, "{REFL}")
    .replace(/\bhimself\b/g, "{REFL}")
    .replace(/\bHe's\b/g,    "{Subj}'s")
    .replace(/\bhe's\b/g,    "{SUBJ}'s")
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
