/**
 * Default example subject names hinted to the tokenizer when authoring Visual
 * Strategy prose (`tokenizeAndSaveVisualOverride`'s `subjectNames` argument).
 * Shared across every save surface (moderation, Facts page) so the hint list
 * can never drift between them.
 */
export const DEFAULT_SUBJECT_EXAMPLE_NAMES = [
  "David Franklin",
  "Raena Franklin",
  "Alex Franklin",
  "Sarah Franklin",
  "Jordan Franklin",
] as const;
