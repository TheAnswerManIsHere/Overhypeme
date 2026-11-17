-- Contract for increment 1.2a (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md
-- 1H; Issue #1018, increment 1.2b): drop the three columns refresh reviews
-- used, which the code stopped declaring in PR #1027 (expand-then-contract,
-- docs/engineering/migrations-and-backfills.md).
--
-- 1. The closing pass of migration 0151, verbatim but for its notice, runs
--    first: a refresh row the previous release wrote after 0151 ran (a send-back
--    on an old instance during a publish) is closed exactly as 0151 closed the
--    rest. On a database 0151 already cleaned it finds nothing and changes
--    nothing. Its guard stops it, and only it, when candidate_version_id is
--    already gone.
-- 2. The deferred checks the pass queued run at once (SET CONSTRAINTS ALL
--    IMMEDIATE), since ALTER TABLE refuses a table with pending trigger events.
-- 3. The drops: fact_gags_pending_ops_owned (the only constraint that reads the
--    gag columns), then fact_gags.pending_remove, fact_gags.pending_review_id
--    and pending_reviews.candidate_version_id. IF EXISTS throughout, so a re-run,
--    or a database whose publish already dropped them, is a no-op.
--
-- Row states: as 0151's, for the closing pass; the drops change no row.
--
-- Rollback: none for the dropped values; nothing reads them. The code that used
-- them is tagged pre-cut/refresh-reviews (docs/retired/README.md).

DO $$
DECLARE
  v_refresh integer := 0;
  v_resubmit integer := 0;
  v_gags_removed integer := 0;
  v_gags_reverted integer := 0;
  v_gags_unmarked integer := 0;
  v_examples integer := 0;
  v_concepts integer := 0;
  v_status integer := 0;
  v_blobs integer := 0;
  v_jobs integer := 0;
  v_versions integer := 0;
  v_reviews integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'pending_reviews' AND column_name = 'candidate_version_id'
  ) THEN
    RAISE NOTICE '0153_drop_refresh_review_columns: pending_reviews.candidate_version_id is already gone; nothing to close';
    RETURN;
  END IF;

  LOCK TABLE facts, pending_reviews, fact_gags IN EXCLUSIVE MODE;

  CREATE TEMP TABLE retire_refresh ON COMMIT DROP AS
    SELECT r.id, r.staging_fact_id, r.status
      FROM pending_reviews r
     WHERE r.candidate_version_id IS NOT NULL;
  CREATE TEMP TABLE retire_resubmit ON COMMIT DROP AS
    SELECT r.id, r.staging_fact_id, r.status
      FROM pending_reviews r
      JOIN facts f ON f.id = r.staging_fact_id
     WHERE r.candidate_version_id IS NULL
       AND r.status = 'pending'
       AND f.created_at < r.created_at;
  CREATE TEMP TABLE retire_r ON COMMIT DROP AS
    SELECT id, staging_fact_id, status FROM retire_refresh
    UNION ALL
    SELECT id, staging_fact_id, status FROM retire_resubmit;
  SELECT count(*) INTO v_refresh FROM retire_refresh;
  SELECT count(*) INTO v_resubmit FROM retire_resubmit;

  -- 1. Refresh-owned gag operations.
  CREATE TEMP TABLE retire_gags ON COMMIT DROP AS
    SELECT g.id, g.approved_content IS NULL AS never_approved
      FROM fact_gags g
     WHERE g.pending_review_id IN (SELECT id FROM retire_refresh)
       AND g.removed_at IS NULL;
  DELETE FROM fact_gag_examples
   WHERE stage = 'pending' AND gag_id IN (SELECT id FROM retire_gags);
  GET DIAGNOSTICS v_examples = ROW_COUNT;
  UPDATE fact_gags
     SET removed_at = now(), pending_remove = false, pending_review_id = NULL, updated_at = now()
   WHERE id IN (SELECT id FROM retire_gags WHERE never_approved);
  GET DIAGNOSTICS v_gags_removed = ROW_COUNT;
  UPDATE fact_gags
     SET pending_content = NULL, pending_by = NULL, pending_at = NULL,
         pending_remove = false, pending_review_id = NULL, updated_at = now()
   WHERE id IN (SELECT id FROM retire_gags WHERE NOT never_approved);
  GET DIAGNOSTICS v_gags_reverted = ROW_COUNT;
  -- A removed gag's mark, or one the loop above did not reach, still points at
  -- a closed review: clear it, so the review's deletion below cannot meet
  -- fact_gags_pending_ops_owned.
  UPDATE fact_gags
     SET pending_remove = false, pending_review_id = NULL, updated_at = now()
   WHERE pending_review_id IN (SELECT id FROM retire_r);
  GET DIAGNOSTICS v_gags_unmarked = ROW_COUNT;

  -- 2. Gag-idea state and prep marks a closed review owned.
  UPDATE facts
     SET visual_concept_owner = NULL, visual_concept_status = NULL, visual_concept_candidates = NULL
   WHERE visual_concept_owner IN (SELECT 'review:' || id FROM retire_r);
  GET DIAGNOSTICS v_concepts = ROW_COUNT;
  UPDATE facts
     SET visual_concept_candidates = NULL, visual_concept_status = NULL
   WHERE visual_concept_candidates ->> 'source' = 'candidate_version';
  UPDATE facts
     SET visual_concept_candidates = visual_concept_candidates - 'candidateVersionId'
   WHERE visual_concept_candidates ? 'candidateVersionId';
  GET DIAGNOSTICS v_blobs = ROW_COUNT;
  UPDATE facts f
     SET enrichment_status = CASE WHEN f.is_active THEN 'ok' ELSE NULL END
   WHERE f.enrichment_status = 'pending'
     AND f.id IN (SELECT staging_fact_id FROM retire_r WHERE status = 'pending');
  GET DIAGNOSTICS v_status = ROW_COUNT;

  -- 3. Work that only served these reviews.
  DELETE FROM async_jobs
   WHERE queue = 'fact_send_back'
      OR (status IN ('pending', 'recovering', 'processing') AND (
            (queue = 'enrichment' AND payload ? 'versionId')
         OR (queue = 'fact_visual_concepts' AND (payload ->> 'reviewId') IN (SELECT id::text FROM retire_r))
      ));
  GET DIAGNOSTICS v_jobs = ROW_COUNT;

  -- 4. Workflow records.
  DELETE FROM fact_enrichment_versions WHERE status IN ('candidate', 'rejected');
  GET DIAGNOSTICS v_versions = ROW_COUNT;
  DELETE FROM pending_reviews WHERE id IN (SELECT id FROM retire_r);
  GET DIAGNOSTICS v_reviews = ROW_COUNT;

  RAISE NOTICE '0153_drop_refresh_review_columns (closing pass): refresh reviews %, open resubmissions %, deleted reviews %; gags removed %, changes discarded %, marks cleared %, pending picks %; idea states cleared %, idea sets rekeyed %, prep marks cleared %; jobs deleted %; versions deleted %',
    v_refresh, v_resubmit, v_reviews, v_gags_removed, v_gags_reverted, v_gags_unmarked, v_examples, v_concepts, v_blobs, v_status, v_jobs, v_versions;
END $$;

-- The closing pass may have changed fact_gags rows, which queues the deferred
-- live-fact trigger (enforce_live_fact_has_approved_gag, 0139); PostgreSQL
-- refuses ALTER TABLE on a table with pending trigger events, so they fire now.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE fact_gags DROP CONSTRAINT IF EXISTS fact_gags_pending_ops_owned;
ALTER TABLE fact_gags DROP COLUMN IF EXISTS pending_remove;
ALTER TABLE fact_gags DROP COLUMN IF EXISTS pending_review_id;
ALTER TABLE pending_reviews DROP COLUMN IF EXISTS candidate_version_id;
