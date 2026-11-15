-- Variants are retired (plan docs/plans/PLAN_RETIRE_VARIANTS.md; David
-- 2026-11-15, Q1 option 1; Issue #962). Every fact stands alone.
--
-- Deletes every fact that has a parent (a variant), active or not, whether or
-- not its parent still exists, together with what it owns, then drops the
-- parent link: facts.parent_id, facts.use_case and pending_reviews.parent_fact_id.
--
-- Order matters:
-- 1. Lock facts and pending_reviews, so no parent-linked row can appear
--    between the selection below and the column drop.
-- 2. Capture the variant facts (V), their memes and comments, and the reviews
--    that staged or approved them (R), before anything changes.
-- 3. Delete what V owns that no foreign key cascades: reactions on V's facts,
--    memes and comments (polymorphic, no FK), and activity entries recording a
--    fact in V or a review in R. A review or activity entry that only MATCHED
--    a variant is not owned and is kept (its matching_fact_id nulls by its FK).
-- 4. Take V's hashtag links off each hashtag's fact count (the count is only
--    ever incremented at approval), then delete V; cascades remove its
--    comments, memes, gags, hashtag links and the rest.
-- 5. Then delete R. Never before V: a gag with a pending example or a pending
--    removal must keep its review pointer (fact_gags_pending_ops_owned), so
--    deleting the review first would abort this migration.
-- 6. Refuse to continue if any fact still has a parent; a variant is never
--    turned into a standalone fact by clearing its link.
-- 7. Drop the columns and their indexes.
--
-- Kept under their existing retention: image provenance records, moderation
-- records, transient renders and stored image files. A review that carried a
-- parent and never became a fact stays in triage as an ordinary submission.
--
-- Runs once per database and is a no-op where the column is already gone (a
-- fresh database, or production after Replit's publish applied the structural
-- change first: replit-environment.md carries the first-publish step that
-- makes sure production has no variant by then). Rollback: the columns could
-- be re-added by a new migration; the deleted rows cannot be restored.

DO $$
DECLARE
  v_variants integer := 0;
  v_reactions integer := 0;
  v_activity integer := 0;
  v_activity_reworded integer := 0;
  v_reviews integer := 0;
  v_memes integer := 0;
  v_comments integer := 0;
  v_hashtags integer := 0;
  v_left integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'facts' AND column_name = 'parent_id'
  ) THEN
    RAISE NOTICE '0142_retire_variants: facts.parent_id is already gone; nothing to delete';
    RETURN;
  END IF;

  LOCK TABLE facts, pending_reviews IN EXCLUSIVE MODE;

  CREATE TEMP TABLE retire_v ON COMMIT DROP AS
    SELECT id FROM facts WHERE parent_id IS NOT NULL;
  CREATE TEMP TABLE retire_memes ON COMMIT DROP AS
    SELECT m.id FROM memes m JOIN retire_v v ON v.id = m.fact_id;
  CREATE TEMP TABLE retire_comments ON COMMIT DROP AS
    SELECT c.id FROM comments c JOIN retire_v v ON v.id = c.fact_id;
  CREATE TEMP TABLE retire_r ON COMMIT DROP AS
    SELECT r.id FROM pending_reviews r
     WHERE r.staging_fact_id IN (SELECT id FROM retire_v)
        OR r.approved_fact_id IN (SELECT id FROM retire_v);

  SELECT count(*) INTO v_variants FROM retire_v;
  SELECT count(*) INTO v_memes FROM retire_memes;
  SELECT count(*) INTO v_comments FROM retire_comments;

  DELETE FROM reactions x
   WHERE (x.target_type = 'fact' AND x.target_id IN (SELECT id FROM retire_v))
      OR (x.target_type = 'meme' AND x.target_id IN (SELECT id FROM retire_memes))
      OR (x.target_type = 'comment' AND x.target_id IN (SELECT id FROM retire_comments));
  GET DIAGNOSTICS v_reactions = ROW_COUNT;

  DELETE FROM activity_feed a
   WHERE (jsonb_typeof(a.metadata -> 'factId') = 'number'
          AND (a.metadata ->> 'factId')::numeric IN (SELECT id FROM retire_v))
      OR (jsonb_typeof(a.metadata -> 'reviewId') = 'number'
          AND (a.metadata ->> 'reviewId')::numeric IN (SELECT id FROM retire_r));
  GET DIAGNOSTICS v_activity = ROW_COUNT;

  -- A kept submission that matched an existing fact was told it was "flagged
  -- as a possible variant"; the word is retired, the meaning was "duplicate".
  UPDATE activity_feed
     SET message = replace(message, 'flagged as a possible variant at', 'flagged as a possible duplicate at')
   WHERE message LIKE '%flagged as a possible variant at%';
  GET DIAGNOSTICS v_activity_reworded = ROW_COUNT;

  UPDATE hashtags h
     SET fact_count = greatest(h.fact_count - l.n, 0)
    FROM (SELECT hashtag_id, count(*)::integer AS n
            FROM fact_hashtags WHERE fact_id IN (SELECT id FROM retire_v)
           GROUP BY hashtag_id) l
   WHERE h.id = l.hashtag_id;
  GET DIAGNOSTICS v_hashtags = ROW_COUNT;

  DELETE FROM facts WHERE id IN (SELECT id FROM retire_v);

  DELETE FROM pending_reviews WHERE id IN (SELECT id FROM retire_r);
  GET DIAGNOSTICS v_reviews = ROW_COUNT;

  SELECT count(*) INTO v_left FROM facts WHERE parent_id IS NOT NULL;
  IF v_left > 0 THEN
    RAISE EXCEPTION '0142_retire_variants: % facts still have a parent after the deletion', v_left;
  END IF;

  RAISE NOTICE '0142_retire_variants: deleted % variant facts (% memes, % comments with them), % reactions, % activity entries, % reviews; % hashtag counts lowered; reworded % activity entries',
    v_variants, v_memes, v_comments, v_reactions, v_activity, v_reviews, v_hashtags, v_activity_reworded;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "facts_parent_id_idx";--> statement-breakpoint
ALTER TABLE "facts" DROP COLUMN IF EXISTS "parent_id";--> statement-breakpoint
ALTER TABLE "facts" DROP COLUMN IF EXISTS "use_case";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_pending_reviews_parent_fact";--> statement-breakpoint
ALTER TABLE "pending_reviews" DROP COLUMN IF EXISTS "parent_fact_id";
