/**
 * Shared codes for PATCH /admin/facts/:id's wording refusal, imported by the
 * server and the admin frontend so the two never drift.
 *
 * A fact's wording locks when its submission is accepted at triage (plan
 * docs/plans/PLAN_THREE_GAGS.md, increment 3; David, 2026-11-14, Q5 and Q6):
 * it is edited only at triage, and the database refuses any later change. The
 * approved-fact text edit, its confirmation envelope and impact payload, went
 * with that lock.
 */
export const FACT_TEXT_EDIT_CODES = {
  /** The PATCH tried to change a fact's wording, which is locked. */
  WORDING_LOCKED: "WORDING_LOCKED",
} as const;
