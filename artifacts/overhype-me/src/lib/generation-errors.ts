/**
 * Turns an error string from the AI image generation endpoints into text a
 * user can read.
 *
 * Those endpoints answer with a mix of readable sentences ("Fact not found",
 * the storage-limit notice) and machine codes (`style_invalid`,
 * `generate_v2_failed`, …). A machine code must never reach the screen (#686):
 * a known one gets its own sentence, any other identifier-shaped string gets
 * the caller's fallback, and a sentence passes through unchanged.
 */

const MESSAGES: Readonly<Record<string, string>> = {
  // An admin disabled (or removed) the style the user picked; nothing was enqueued.
  style_invalid: "That style isn't available right now. Pick a different style and try again.",
};

/** snake_case or SCREAMING_SNAKE with at least one underscore, no spaces. */
const MACHINE_CODE = /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/;

export function generationErrorMessage(raw: string | null | undefined, fallback: string): string {
  const text = raw?.trim();
  if (!text) return fallback;
  const known = MESSAGES[text];
  if (known) return known;
  return MACHINE_CODE.test(text) ? fallback : text;
}
