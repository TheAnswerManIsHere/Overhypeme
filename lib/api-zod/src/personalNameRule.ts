/**
 * The one name rule (identity-flow plan, Phase 2): what a personal name may
 * be, wherever a name is typed, saved or rendered. The browser and the server
 * both import this module, so the two sides cannot drift — before it, three
 * rules disagreed (the sheet: anything up to 100 characters; the account
 * save: stripped, at most 3 words of 20; the meme download: refused, up to 50).
 *
 * A name is one that can be written in English (David, 2026-11-02: the site
 * launches US-only and English-only; other scripts are an internationalization
 * effort after launch). After NFC it may hold Latin letters — A–Z and the
 * accented Latin letters of Latin-1 and Latin Extended-A (José, Zoë, Siobhán,
 * Łukasz) — digits 0–9, space, `'`, `-` and `.`. Every one of those has a
 * glyph in the bundled meme font, Anton (its charset covers U+0020–U+007E and
 * U+00A0–U+0181), so every admitted name renders. Curly apostrophes become
 * `'`, whitespace runs become one space, the ends are trimmed. It is at most
 * 50 visible characters. There is no word-count limit.
 *
 * Why: names render into meme fonts with no emoji shapes, and they feed AI
 * prompts, where punctuation such as quotes and brackets is the risk. (The
 * 2026-10-21 rule admitted letters in any script; David narrowed it on
 * 2026-11-02.)
 *
 * @purpose The shared personal-name rule for browser and server, English-script names only (David, 2026-11-02): normalizes a name (NFC, curly apostrophes, whitespace), refuses one with a character outside Latin letters, digits, space, apostrophe, hyphen and period or over 50 graphemes, cleans a provider-supplied name to what the rule admits, filters typed input without breaking IME composition, and owns the shared grapheme count and cut.
 * @subsystem accounts-auth
 */

/** The limit, in visible characters (grapheme clusters). */
export const PERSONAL_NAME_MAX_GRAPHEMES = 50;

/**
 * The characters the rule admits: Basic Latin letters and digits, the
 * Latin-1 and Latin Extended-A letters (U+00C0–U+017F without × and ÷),
 * space, apostrophe, hyphen and period. One character, and a whole string.
 */
const ALLOWED_CHAR = /^[A-Za-z0-9À-ÖØ-öø-ſ '.-]$/;
const ALLOWED_NAME = /^[A-Za-z0-9À-ÖØ-öø-ſ '.-]*$/;

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
 * Clean a name the visitor did not type — a Google or Apple first or last
 * name — to what the rule admits: disallowed characters become spaces and the
 * result is cut at the limit. Returns null when nothing is left, so the
 * sign-in proceeds without that name rather than failing.
 */
export function cleanProvidedPersonalName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let kept = "";
  for (const c of normalizePersonalName(raw)) kept += ALLOWED_CHAR.test(c) ? c : " ";
  const value = truncateGraphemes(normalizePersonalName(kept), PERSONAL_NAME_MAX_GRAPHEMES).trim();
  return checkPersonalName(value).ok ? value : null;
}

/**
 * What a name input shows after an edit: the new text with any disallowed
 * character removed, and whether one was (so the input can show the hint).
 * The curly apostrophe is converted as it is typed. The length limit is not
 * applied here: the name field (`useNameField`) stops at it and says so
 * (David, 2026-11-02). Callers skip this while an IME composition is open and
 * apply it when the composition commits.
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
