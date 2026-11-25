/**
 * Default example subject names hinted to the tokenizer when authoring Visual
 * Strategy prose (`tokenizeAndSaveVisualOverride`'s `subjectNames` argument).
 * Shared across every save surface (moderation, Facts page) so the hint list
 * can never drift between them. The set is the product's example people
 * (decisions.md, 2026-11-17): David, Raena, Alex where neutral, Mango the cat.
 */
export const DEFAULT_SUBJECT_EXAMPLE_NAMES = [
  "David Franklin",
  "Raena Franklin",
  "Alex Franklin",
  "Mango",
] as const;
