/**
 * @purpose The needs-attention reasons, shared by the server's checks and the admin's Facts list and fact sheet, so a new reason is one edit.
 * @subsystem moderation
 *
 * Plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, 2C. Each reason's SQL
 * predicate is api-server lib/factAttention.ts; its words are the admin's
 * components/admin/factSheet/factSheetView.ts.
 */
export const ATTENTION_REASONS = [
  "taxonomy_missing",
  "example_stale",
  "example_missing",
  "fingerprint_missing",
  "pictures_failing",
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/** The reason a value names, or undefined when it names none. */
export function attentionReasonOf(value: unknown): AttentionReason | undefined {
  return ATTENTION_REASONS.find((r) => r === value);
}
