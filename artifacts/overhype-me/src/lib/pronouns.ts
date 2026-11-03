/**
 * The three common preset pronoun pairs shown as one-click options.
 *
 * @purpose The browser's pronoun-set model: the presets, the default, and serialization of custom five-form sets with their verb plurality.
 * @subsystem token-rendering
 */
import { splitCustomPronounSet } from "@workspace/api-zod";
export const PRONOUN_PRESETS = ["he/him", "she/her", "they/them"] as const;

/** Default pronouns used when no preference has been set. */
export const DEFAULT_PRONOUNS = "he/him";
export type PronounPreset = typeof PRONOUN_PRESETS[number];

/** All five grammatical forms + verb conjugation flag for a pronoun set. */
export interface CustomPronounSet {
  subj:    string;  // xe, fae, ey, …
  obj:     string;  // xem, faer, em, …
  poss:    string;  // xyr, faer, eir, …  (possessive adjective: "xyr book")
  possPro: string;  // xyrs, faers, eirs, …  (possessive pronoun: "the book is xyrs")
  refl:    string;  // xemself, faerself, emself, …
  plural:  boolean; // false = singular verb ("xe doesn't"), true = plural ("they don't")
}

export const EMPTY_CUSTOM: CustomPronounSet = {
  subj: "", obj: "", poss: "", possPro: "", refl: "", plural: false,
};

/**
 * Serialize all five forms + conjugation flag to a single storable string.
 * Format: "subj|obj|poss|possPro|refl|p" (p = plural) or "…|s" (s = singular)
 * Pipe-delimited format is unambiguous from presets which use "/".
 */
export function serializeCustom(p: CustomPronounSet): string {
  return `${p.subj}|${p.obj}|${p.poss}|${p.possPro}|${p.refl}|${p.plural ? "p" : "s"}`;
}

/**
 * Parse a pipe-delimited custom pronoun string; null if it is not that format.
 * The one shared parser (`splitCustomPronounSet`, `@workspace/api-zod`), so
 * the browser and the server read a stored set the same way: exactly six
 * parts, the sixth `s` or `p`, forms kept as stored, empty ones included.
 */
export function parseCustom(value: string): CustomPronounSet | null {
  return splitCustomPronounSet(value);
}

/** True when the stored value is the pipe-delimited custom format. */
export function isCustomPronouns(value: string): boolean {
  return value.includes("|");
}

/**
 * Human-readable display string for any stored pronouns value.
 * "he/him" → "he/him"
 * "xe|xem|xyr|xyrs|xemself|s" → "xe/xem"
 */
export function displayPronouns(value: string | null | undefined): string {
  if (!value) return "";
  if (!value.includes("|")) return value;
  const p = parseCustom(value);
  return p ? `${p.subj}/${p.obj}` : value;
}
