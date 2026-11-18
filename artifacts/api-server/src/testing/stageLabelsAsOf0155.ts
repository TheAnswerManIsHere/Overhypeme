/**
 * @purpose Run a migration written before 0155 against today's schema: its retired review-stage labels rewritten as 0155 maps them.
 * @subsystem moderation
 *
 * Migration 0155 (Issue #1018, increment 1.2c-ii) replaced the review stages;
 * the enum no longer has the old labels, so SQL that names one cannot run on a
 * migrated database. Two places run such SQL again on purpose: the legacy
 * fixture loader (0152's ever-approved backfill) and the historical migration
 * tests. They read it through this map, never a copy of their own. A label
 * that 0155 maps by data (the three prep stages: reading, or gags when the
 * staging fact has an approved note) maps to the stage an open review without
 * a note reaches, which is all those callers need: an unresolved review.
 */
export const STAGE_AS_OF_0155: Readonly<Record<string, string>> = {
  triage_pending: "triage",
  prep_pending: "reading",
  prep_failed: "reading",
  concept_review: "gags",
  production_review: "test_renders",
  production_approved: "approved",
  triage_rejected: "rejected",
  production_rejected: "rejected",
};

/** The SQL with every quoted retired stage label replaced by 0155's. */
export function sqlAsOf0155(sql: string): string {
  return sql.replace(/'(triage_pending|prep_pending|prep_failed|concept_review|production_review|production_approved|triage_rejected|production_rejected)'/g, (_m, label: string) => `'${STAGE_AS_OF_0155[label]}'`);
}
