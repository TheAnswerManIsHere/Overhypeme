export type PronounSet = "he/him" | "she/her" | "they/them";

interface PronounMap {
  he: string; He: string;
  him: string; Him: string;
  his: string; His: string;
  himself: string; Himself: string;
  hes: string; Hes: string;
}

const KNOWN_MAPS: Record<string, PronounMap> = {
  "he": {
    he: "he", He: "He",
    him: "him", Him: "Him",
    his: "his", His: "His",
    himself: "himself", Himself: "Himself",
    hes: "he's", Hes: "He's",
  },
  "she": {
    he: "she", He: "She",
    him: "her", Him: "Her",
    his: "her", His: "Her",
    himself: "herself", Himself: "Herself",
    hes: "she's", Hes: "She's",
  },
  "they": {
    he: "they", He: "They",
    him: "them", Him: "Them",
    his: "their", His: "Their",
    himself: "themselves", Himself: "Themselves",
    hes: "they're", Hes: "They're",
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
    he: sub,       He: cap(sub),
    him: obj,      Him: cap(obj),
    his: obj,      His: cap(obj),
    himself: obj + "self", Himself: cap(obj + "self"),
    hes: sub + "'s", Hes: cap(sub + "'s"),
  };
}

/**
 * Replace {Name} and pronoun tokens.
 * Accepts subject pronoun ("he", "she", "they", or custom)
 * and object pronoun ("him", "her", "them", or custom).
 */
export function renderFact(
  text: string,
  name: string,
  pronounSubject: string = "he",
  pronounObject: string = "him",
): string {
  const p = resolveMap(pronounSubject, pronounObject);
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
