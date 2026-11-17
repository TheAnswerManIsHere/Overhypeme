-- Reject from every step (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md,
-- oracle item 13; Issue #1018, increment 1.2c-i) adds a fifth reason:
-- "couldn't make it work visually" (Q2: 1). Expand only: one enum label.
--
-- ADD VALUE runs inside the migration's transaction on PostgreSQL 12+; the
-- label is not used until a later transaction. IF NOT EXISTS makes a re-run a
-- no-op. Row states: no row changes (no-op).
--
-- Rollback: revert the code. PostgreSQL cannot drop an enum label; an unused
-- label is inert.

ALTER TYPE review_reason ADD VALUE IF NOT EXISTS 'visual';
