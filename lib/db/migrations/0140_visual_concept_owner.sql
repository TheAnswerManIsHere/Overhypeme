-- The gag writer's generation owner (plan docs/plans/PLAN_THREE_GAGS.md,
-- increment 2, section F, approved by David 2026-11-14, Issue #957).
--
-- A fact's candidate gags (visual_concept_candidates) and their status
-- (visual_concept_status) are written by one generation at a time, and the
-- column below names which: 'review:<id>' for a review cycle, 'live:<id>' for
-- a Draft more gags request on a live fact. A generation's success, failure or
-- abandonment changes the fact's candidate state only while its owner holds
-- it, and opening a review takes ownership, so a live draft finishing after a
-- review opened cannot overwrite the review's candidates or status.
--
-- Additive and nullable: a fact with no owner recorded (every fact today) is
-- written by a review cycle's generation as before. Nothing is backfilled.
-- Reversal: ALTER TABLE facts DROP COLUMN visual_concept_owner (no data in it
-- outlives the generation it names).

ALTER TABLE facts ADD COLUMN IF NOT EXISTS visual_concept_owner varchar(64);
