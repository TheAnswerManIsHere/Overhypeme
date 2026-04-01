export type PronounSet = "he/him" | "she/her" | "they/them";

interface PronounMap {
  he: string; He: string;
  him: string; Him: string;
  his: string; His: string;
  himself: string; Himself: string;
  hes: string; Hes: string;
}

const PRONOUN_MAPS: Record<PronounSet, PronounMap> = {
  "he/him": {
    he: "he", He: "He",
    him: "him", Him: "Him",
    his: "his", His: "His",
    himself: "himself", Himself: "Himself",
    hes: "he's", Hes: "He's",
  },
  "she/her": {
    he: "she", He: "She",
    him: "her", Him: "Her",
    his: "her", His: "Her",
    himself: "herself", Himself: "Herself",
    hes: "she's", Hes: "She's",
  },
  "they/them": {
    he: "they", He: "They",
    him: "them", Him: "Them",
    his: "their", His: "Their",
    himself: "themselves", Himself: "Themselves",
    hes: "they're", Hes: "They're",
  },
};

/**
 * Replace {Name} and pronoun tokens in a fact string.
 */
export function renderFact(text: string, name: string, pronouns: PronounSet = "he/him"): string {
  const p = PRONOUN_MAPS[pronouns];
  return text
    .replace(/\{Name\}/g, name || "David Franklin")
    .replace(/\{Himself\}/g, p.Himself)
    .replace(/\{himself\}/g, p.himself)
    .replace(/\{He's\}/g, p.Hes)
    .replace(/\{he's\}/g, p.hes)
    .replace(/\{Him\}/g, p.Him)
    .replace(/\{him\}/g, p.him)
    .replace(/\{His\}/g, p.His)
    .replace(/\{his\}/g, p.his)
    .replace(/\{He\}/g, p.He)
    .replace(/\{he\}/g, p.he);
}

/**
 * Tokenize "Chuck Norris" and he/him/his pronouns in submitted fact text.
 * Preserves existing {Name} / pronoun tokens.
 */
export function tokenizeFact(text: string): string {
  return text
    .replace(/\{First_Name\}\s*\{Last_Name\}/g, "{Name}")
    .replace(/\bchuck norris\b/gi, "{Name}")
    .replace(/\bHimself\b/g, "{Himself}")
    .replace(/\bhimself\b/g, "{himself}")
    .replace(/\bHe's\b/g, "{He's}")
    .replace(/\bhe's\b/g, "{he's}")
    .replace(/\bHim\b/g, "{Him}")
    .replace(/\bhim\b/g, "{him}")
    .replace(/\bHis\b/g, "{His}")
    .replace(/\bhis\b/g, "{his}")
    .replace(/\bHe\b/g, "{He}")
    .replace(/\bhe\b/g, "{he}");
}
