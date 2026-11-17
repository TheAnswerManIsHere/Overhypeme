-- Refresh reviews and resubmission reviews are retired (plan
-- docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, 1H, approved by David
-- 2026-11-17; Issue #1018, increment 1.2a). The moderation queue holds new
-- submissions only.
--
-- A refresh review is a review of an already-live fact (its
-- candidate_version_id is set). A resubmission review is an open review
-- against a fact that existed before the review did: "Resubmit for
-- moderation" pointed a new review at an existing, deactivated fact. A
-- first-time submission's staging fact is created at provisional approval,
-- after its review, so it never matches.
--
-- What this does, in order:
-- 1. Refresh-owned gag operations are discarded: a gag the refresh created and
--    never approved is removed; a gag it changed keeps its approved version
--    and loses the change; every pick and removal it made is cleared. Gags
--    outside a refresh are untouched, so a published gag set never changes.
-- 2. Gag-idea state a closed review owned is cleared, and a fact's "prep
--    running" mark left by a closed review is cleared. Every other stored set
--    of gag ideas loses its candidateVersionId key (always null outside a
--    refresh; the code no longer reads or writes it), and one drafted for a
--    refresh candidate is cleared. Nothing a member sees changes: the fact's
--    active state, published gags and member content stay.
-- 3. Queued work that only served these reviews is deleted: every send-back
--    job (the queue is gone), and unfinished refresh-candidate enrichment and
--    gag-idea jobs for a closed review.
-- 4. Workflow records are deleted, never kept as inert rows (decisions.md,
--    2026-11-17, "Deprecated means removed"): every refresh review whatever
--    its state, every open resubmission review, and every enrichment version
--    that never became the fact's (status candidate or rejected). Promoted and
--    superseded versions are the fact's classification history and stay for
--    the taxonomy rework (the plan's Phase 2); their source review pointer
--    nulls by its foreign key. A resubmission that reached approval is kept: it
--    is a record of the fact's approval.
--
-- Row states: open refresh -> closed (deleted) with its operations discarded;
-- finished refresh (promoted or declined) -> deleted; open resubmission ->
-- deleted; approved resubmission -> kept; every other review -> untouched
-- (no-op). Re-running finds nothing left to close and changes nothing. Rows
-- the previous release writes after this ran (a new send-back on an old
-- instance during a publish) are closed by re-running this file's logic in
-- the next increment's contract migration, which drops the columns.
--
-- Guarded: if pending_reviews.candidate_version_id is already gone (a
-- database where a later contract migration's drop was applied first), there
-- is nothing it can identify, and it reports that and stops.
--
-- Rollback: revert the code. Deleted reviews, versions and jobs cannot be
-- restored; the live facts they touched are unchanged.

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
    RAISE NOTICE '0151_retire_refresh_reviews: pending_reviews.candidate_version_id is already gone; nothing to identify';
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

  RAISE NOTICE '0151_retire_refresh_reviews: refresh reviews %, open resubmissions %, deleted reviews %; gags removed %, changes discarded %, marks cleared %, pending picks %; idea states cleared %, idea sets rekeyed %, prep marks cleared %; jobs deleted %; versions deleted %',
    v_refresh, v_resubmit, v_reviews, v_gags_removed, v_gags_reverted, v_gags_unmarked, v_examples, v_concepts, v_blobs, v_status, v_jobs, v_versions;
END $$;
