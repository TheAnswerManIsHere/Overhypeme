/**
 * The ONE literal-string serializer for prompt-embedded exact text.
 *
 * Both places the compiler asks the engine to letter an exact string — the
 * supporting-text `literal_text` elements and the SPEECH & THOUGHT BUBBLES
 * directives — go through this helper, so there is a single deterministic
 * quoting/escaping dialect. Raw `"${text}"` interpolation is ambiguous the
 * moment the text itself contains a double quote (`He said, "now."`).
 *
 * Semantics: serialize for PROMPT CLARITY, not JSON storage — the requested
 * glyph string is never altered, only delimited. Backslashes and embedded
 * straight double quotes are escaped so the delimiters stay unambiguous;
 * curly quotes, apostrophes, and all other Unicode pass through untouched
 * (they don't collide with the delimiter). Whitespace runs are collapsed
 * defensively (upstream save-time normalization should already have done
 * this; the serializer must still never emit a newline into a one-line
 * directive).
 *
 * ORDER CONTRACT: personalization tokens must be rendered BEFORE calling this
 * — escaping first could be invalidated by what a token expands to.
 */
export function serializeLiteralPromptString(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const escaped = normalized.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}
