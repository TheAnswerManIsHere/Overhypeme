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
 * @param name        - Person's display name  ({NAME} token)
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

  return text
    // Name — when no name is set (cold visitor) we render an underscored
    // placeholder so the sentence still scans and signals "fill me in".
    .replace(/\{NAME\}/g, name || "___")

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
