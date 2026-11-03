/**
 * The one name rule (identity-flow plan, Phase 2): what a personal name may
 * be, wherever a name is typed, saved or rendered. The browser and the server
 * both import this module, so the two sides cannot drift — before it, three
 * rules disagreed (the sheet: anything up to 100 characters; the account
 * save: stripped, at most 3 words of 20; the meme download: refused, up to 50).
 *
 * A name is one that can be written in English (David, 2026-11-02: the site
 * launches US-only and English-only; other scripts are an internationalization
 * effort after launch). After NFC it may hold Latin letters, digits 0–9,
 * space, `'`, `-` and `.`. The letters are exactly those every caption font
 * draws in both cases (names-and-fonts plan, David 2026-11-03): A–Z, the
 * Western and Central European accents (José, Zoë, Siobhán, Łukasz), and the
 * Vietnamese, Romanian and Turkish letters (Nguyễn, Ștefan, Türkoğlu). They
 * are derived from the font files into `personalNameLetters.generated.ts`, so
 * every admitted name renders in every caption face. Curly apostrophes become
 * `'`, whitespace runs become one space, the ends are trimmed. It is at most
 * 50 visible characters. There is no word-count limit.
 *
 * Why: names render into meme fonts with no emoji shapes, and they feed AI
 * prompts, where punctuation such as quotes and brackets is the risk. (The
 * 2026-10-21 rule admitted letters in any script; David narrowed it on
 * 2026-11-02.)
 *
 * @purpose The shared personal-name rule for browser and server, English-script names only (David, 2026-11-02): normalizes a name (NFC, curly apostrophes, whitespace), refuses one with a character outside the Latin letters every caption font draws, digits, space, apostrophe, hyphen and period or over 50 graphemes, accepts a provider-supplied name only whole, filters typed input without breaking IME composition, and owns the shared grapheme count and cut.
 * @subsystem accounts-auth
 */

import { PERSONAL_NAME_LETTER_RANGES } from "./personalNameLetters.generated";

/** The limit, in visible characters (grapheme clusters). */
export const PERSONAL_NAME_MAX_GRAPHEMES = 50;

/**
 * The characters the rule admits: the derived letters, digits, space,
 * apostrophe, hyphen and period. One character, and a whole string.
 */
const LETTER_CLASS = PERSONAL_NAME_LETTER_RANGES.map(([a, b]) =>
  a === b ? `\\u{${a.toString(16)}}` : `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`,
).join("");
const ALLOWED_CHAR = new RegExp(`^[${LETTER_CLASS}0-9 '.\\-]$`, "u");
const ALLOWED_NAME = new RegExp(`^[${LETTER_CLASS}0-9 '.\\-]*$`, "u");

/** The short hint an input shows when it refuses a character. */
export const PERSONAL_NAME_HINT = "English letters, numbers, spaces, apostrophes, hyphens and periods only.";

export type PersonalNameCheck =
  | { ok: true; value: string }
  | { ok: false; error: string; reason: "empty" | "characters" | "length" | "type" };

/** Built once: constructing a Segmenter is the expensive part, and it is stateless. */
const SEGMENTER =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** A string's grapheme clusters (code points where Intl.Segmenter is unavailable). */
export function graphemeClusters(s: string): string[] {
  return SEGMENTER ? Array.from(SEGMENTER.segment(s), (g) => g.segment) : Array.from(s);
}

/** Count visible characters (grapheme clusters). */
export function countGraphemes(s: string): number {
  // A string no longer than the limit in UTF-16 units cannot be longer in
  // graphemes, so the common case never segments.
  if (s.length <= PERSONAL_NAME_MAX_GRAPHEMES) return Array.from(s).length;
  return graphemeClusters(s).length;
}

/** Cut a string to at most `max` grapheme clusters, never splitting one. */
export function truncateGraphemes(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  const clusters = graphemeClusters(s);
  return clusters.length <= max ? s : clusters.slice(0, max).join("");
}

/** The conversions the rule makes before it judges: NFC, apostrophes, whitespace. */
export function normalizePersonalName(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when every character of `s` is one the rule admits. */
export function hasOnlyAllowedNameChars(s: string): boolean {
  return ALLOWED_NAME.test(s);
}

/**
 * Judge a name a person typed. Never strips: a disallowed character is a
 * refusal the person can see and fix, not a silent change to their name.
 */
export function checkPersonalName(raw: unknown): PersonalNameCheck {
  if (typeof raw !== "string") return { ok: false, error: "Name must be text", reason: "type" };
  const value = normalizePersonalName(raw);
  if (value.length === 0) return { ok: false, error: "Name cannot be empty", reason: "empty" };
  if (!hasOnlyAllowedNameChars(value)) return { ok: false, error: PERSONAL_NAME_HINT, reason: "characters" };
  if (countGraphemes(value) > PERSONAL_NAME_MAX_GRAPHEMES) {
    return { ok: false, error: `Name must be ${PERSONAL_NAME_MAX_GRAPHEMES} characters or fewer`, reason: "length" };
  }
  return { ok: true, value };
}

/**
 * Accept a name the visitor did not type — a Google or Apple first or last
 * name — only whole: the normalized value if it passes the rule, else null.
 * Nothing is stripped, spaced out or cut, so a name is never stored garbled
 * ("Nguyễn" once came out "Nguy n"); sign-in proceeds without it, and
 * onboarding asks for the name in English letters (names-and-fonts plan).
 */
export function acceptProvidedPersonalName(raw: unknown): string | null {
  const checked = checkPersonalName(raw);
  return checked.ok ? checked.value : null;
}

/**
 * What a name input shows after an edit: the new text with any disallowed
 * character removed, and whether one was (so the input can show the hint).
 * The curly apostrophe is converted as it is typed. The length limit is not
 * applied here: the field's own check reports it, so a paste is never cut
 * silently. Callers skip this while an IME composition is open and apply it
 * when the composition commits.
 */
export function filterNameInput(next: string): { value: string; refused: boolean } {
  // Whitespace of any kind (a pasted non-breaking space, a tab) becomes a
  // plain space — a conversion like the apostrophe's, not a refusal — so a
  // pasted name keeps its word breaks. Runs are not collapsed and the ends are
  // not trimmed here: the field holds a trailing space while the next word is
  // typed, and the save-time normalization collapses them.
  const converted = next.normalize("NFC").replace(/[‘’ʼ]/g, "'").replace(/\s/g, " ");
  if (ALLOWED_NAME.test(converted)) return { value: converted, refused: false };
  let value = "";
  for (const c of converted) if (ALLOWED_CHAR.test(c)) value += c;
  return { value, refused: true };
}
