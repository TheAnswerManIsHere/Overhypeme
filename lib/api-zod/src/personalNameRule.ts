/**
 * The one name rule (David, 2026-10-21; identity-flow plan, Phase 2): what a
 * personal name may be, wherever a name is typed, saved or rendered. The
 * browser and the server both import this module, so the two sides cannot
 * drift — before it, three rules disagreed (the sheet: anything up to 100
 * characters; the account save: stripped, at most 3 words of 20; the meme
 * download: refused, up to 50).
 *
 * A name may hold Unicode letters and marks, digits, space, `'`, `-`, `.`,
 * and the zero-width joiner and non-joiner some Persian and Indic names need.
 * There is no adjacency rule on the joiners: an Indic joiner legitimately
 * follows a virama, which is a mark, not a letter (`क्‍ष`). Curly apostrophes
 * become `'`, whitespace runs become one space, the ends are trimmed, and the
 * result is NFC. It is at most 50 visible characters (grapheme clusters).
 * There is no word-count limit.
 *
 * Why: names render into meme fonts with no emoji shapes, and they feed AI
 * prompts, where punctuation such as quotes and brackets is the risk.
 *
 * @purpose The shared personal-name rule for browser and server: normalizes a name (NFC, curly apostrophes, whitespace), refuses one with a disallowed character or more than 50 grapheme clusters, cleans a provider-supplied name to what the rule admits, and filters typed input without breaking IME composition.
 * @subsystem accounts-auth
 */

/** The limit, in visible characters (grapheme clusters). */
export const PERSONAL_NAME_MAX_GRAPHEMES = 50;

const ZWNJ = "‌";
const ZWJ = "‍";

/** One character the rule admits, tested on a single code point. */
const ALLOWED_CHAR = /^[\p{L}\p{M}\p{N} '.\-‌‍]$/u;

/** The short hint an input shows when it refuses a character. */
export const PERSONAL_NAME_HINT = "Letters, numbers, spaces, apostrophes, hyphens and periods only.";

export type PersonalNameCheck =
  | { ok: true; value: string }
  | { ok: false; error: string; reason: "empty" | "characters" | "length" | "type" };

/** Count visible characters (grapheme clusters). */
export function countGraphemes(s: string): number {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    let n = 0;
    for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)) n++;
    return n;
  }
  // Fallback: code points, with marks and joiners attached to what precedes.
  return [...s].filter((c) => !/[\p{M}‌‍]/u.test(c)).length;
}

/** The conversions the rule makes before it judges: NFC, apostrophes, whitespace. */
export function normalizePersonalName(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[\s ]+/gu, " ")
    .trim();
}

/** True when every character of `s` is one the rule admits. */
export function hasOnlyAllowedNameChars(s: string): boolean {
  for (const c of s) if (!ALLOWED_CHAR.test(c)) return false;
  return true;
}

/**
 * Judge a name a person typed. Never strips: a disallowed character is a
 * refusal the person can see and fix, not a silent change to their name.
 */
export function checkPersonalName(raw: unknown): PersonalNameCheck {
  if (typeof raw !== "string") return { ok: false, error: "Name must be text", reason: "type" };
  const value = normalizePersonalName(raw);
  if (value.length === 0 || /^[‌‍ ]*$/u.test(value)) {
    return { ok: false, error: "Name cannot be empty", reason: "empty" };
  }
  if (!hasOnlyAllowedNameChars(value)) return { ok: false, error: PERSONAL_NAME_HINT, reason: "characters" };
  if (countGraphemes(value) > PERSONAL_NAME_MAX_GRAPHEMES) {
    return { ok: false, error: `Name must be ${PERSONAL_NAME_MAX_GRAPHEMES} characters or fewer`, reason: "length" };
  }
  return { ok: true, value };
}

/**
 * Clean a name the visitor did not type — a Google or Apple first or last
 * name — to what the rule admits: disallowed characters are dropped and the
 * result is cut at the grapheme limit. Returns null when nothing is left, so
 * the sign-in proceeds without that name rather than failing.
 */
export function cleanProvidedPersonalName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let kept = "";
  for (const c of normalizePersonalName(raw)) kept += ALLOWED_CHAR.test(c) ? c : " ";
  let value = normalizePersonalName(kept);
  if (countGraphemes(value) > PERSONAL_NAME_MAX_GRAPHEMES) {
    const clusters =
      typeof Intl !== "undefined" && "Segmenter" in Intl
        ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map((s) => s.segment)
        : [...value];
    value = clusters.slice(0, PERSONAL_NAME_MAX_GRAPHEMES).join("").trim();
  }
  return checkPersonalName(value).ok ? value : null;
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
  let value = "";
  let refused = false;
  for (const c of next.replace(/[‘’ʼ]/g, "'")) {
    if (ALLOWED_CHAR.test(c) || c === " ") value += c;
    else refused = true;
  }
  return { value, refused };
}

export const PERSONAL_NAME_JOINERS = { ZWNJ, ZWJ } as const;
