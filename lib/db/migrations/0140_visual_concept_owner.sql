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
-- Additive and nullable. Backfill: a fact with an open review is owned by
-- that review (its latest, as openReviewForFact reads it), so its generation
-- in flight at deploy still lands; a job queued before owners existed derives
-- the same 'review:<id>'. A fact with no open review has no generation
-- running, and stays null until one claims it. Idempotent: only null owners
-- are filled.
-- Reversal: ALTER TABLE facts DROP COLUMN visual_concept_owner (no data in it
-- outlives the generation it names).

ALTER TABLE facts ADD COLUMN IF NOT EXISTS visual_concept_owner varchar(64);--> statement-breakpoint
UPDATE facts f
   SET visual_concept_owner = 'review:' || r.id
  FROM (
    SELECT DISTINCT ON (staging_fact_id) staging_fact_id, id
      FROM pending_reviews
     WHERE status = 'pending' AND staging_fact_id IS NOT NULL
     ORDER BY staging_fact_id, id DESC
  ) r
 WHERE f.id = r.staging_fact_id
   AND f.visual_concept_owner IS NULL;
