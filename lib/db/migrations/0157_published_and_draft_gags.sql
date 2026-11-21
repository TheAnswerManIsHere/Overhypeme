-- A fact's published and draft gag sets (plan
-- docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, 1F and the Source-of-Truth
-- Analysis; Issue #1018, increment 1.3a). The two versions fact_gags already
-- holds per gag take new meanings, and no third state is added:
--
--   approved_* + stage 'approved' examples  = the PUBLISHED set: what members
--     are offered. Written only by a publish (Approve for production now;
--     Publish changes from Phase 3).
--   pending_*  + stage 'pending' examples   = the DRAFT, per gag: a gag whose
--     pending content is null is unchanged in the draft (its draft is its
--     published version and examples); a gag with pending content is edited
--     in the draft, and its pending examples are its whole draft set.
--   draft_removed                            = a published gag the draft
--     removes; it stays offered until the draft is published.
--
-- 1. fact_gags.draft_removed, with its check: only a published gag with no
--    draft change can be marked removed in the draft.
-- 2. A fact that was never approved for production (facts.approved_at is
--    null, 0152) has no published set. Today a gag's third render approval
--    copies its content into approved_* during first-time moderation, so
--    such a fact can hold approved content. Each of its non-removed gags with
--    approved content is converted:
--      a. no draft change: the approved content and examples become the
--         draft (pending) content and examples;
--      b. a draft change exists: the approved examples, which show older
--         content, are deleted and the draft is kept as it is.
--    In both, the approved version is cleared (content, approver, time,
--    grandfathering marks). Nothing is deleted from a fact ever approved.
-- 3. A constraint trigger: a non-removed gag can hold published content only
--    on a fact that has been approved for production. Deferred, so the
--    approval and the publish land in one transaction in either order.
-- 4. Draft more gags on a live fact is removed (below).
--
-- Row states:
--   ever-approved fact's gags -> untouched (counted).
--   never-approved fact's gag with approved content, no draft -> case a.
--   never-approved fact's gag with approved content and a draft -> case b.
--   never-approved fact's gag with only a draft -> untouched (no-op, counted).
--   removed gags -> untouched (skipped, counted).
--   a never-approved fact that is LIVE -> the migration aborts and names it
--     (failed): 0152 recorded every live fact as approved, so this would be a
--     fact made live outside Approve for production.
--   Re-run: step 2 finds nothing (no-op); steps 1 and 3 are IF NOT EXISTS / OR
--   REPLACE.
--
-- Rollback: revert the code. The column is additive and inert to the previous
-- release. Step 2 moves content and never deletes it except case b's
-- superseded examples; reversing it is not needed, since the previous release
-- reads a never-approved fact's pending content the same way.

ALTER TABLE fact_gags ADD COLUMN IF NOT EXISTS draft_removed boolean NOT NULL DEFAULT false;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fact_gags_draft_removed_is_published' AND conrelid = 'fact_gags'::regclass) THEN
    ALTER TABLE fact_gags ADD CONSTRAINT fact_gags_draft_removed_is_published
      CHECK (NOT draft_removed OR (approved_content IS NOT NULL AND pending_content IS NULL));
  END IF;
END $$;--> statement-breakpoint
DO $$
DECLARE
  v_live_ids text;
  v_published integer := 0;
  v_to_draft integer := 0;
  v_superseded integer := 0;
  v_examples_moved integer := 0;
  v_examples_dropped integer := 0;
  v_draft_only integer := 0;
  v_removed integer := 0;
BEGIN
  LOCK TABLE facts, fact_gags, fact_gag_examples IN EXCLUSIVE MODE;

  SELECT string_agg(f.id::text, ',' ORDER BY f.id) INTO v_live_ids
    FROM facts f WHERE f.is_active AND f.approved_at IS NULL;
  IF v_live_ids IS NOT NULL THEN
    RAISE EXCEPTION '0157_published_and_draft_gags: live facts with no approval on record (ids: %); record their approval first', v_live_ids;
  END IF;

  SELECT count(*) INTO v_published FROM fact_gags g JOIN facts f ON f.id = g.fact_id
   WHERE f.approved_at IS NOT NULL AND g.removed_at IS NULL;
  SELECT count(*) INTO v_removed FROM fact_gags g WHERE g.removed_at IS NOT NULL;
  SELECT count(*) INTO v_draft_only FROM fact_gags g JOIN facts f ON f.id = g.fact_id
   WHERE f.approved_at IS NULL AND g.removed_at IS NULL AND g.approved_content IS NULL;

  DROP TABLE IF EXISTS convert_gags;
  CREATE TEMP TABLE convert_gags ON COMMIT DROP AS
    SELECT g.id, g.pending_content IS NULL AS to_draft
      FROM fact_gags g JOIN facts f ON f.id = g.fact_id
     WHERE f.approved_at IS NULL AND g.removed_at IS NULL AND g.approved_content IS NOT NULL;

  -- b. The draft is newer: the approved examples show older content.
  DELETE FROM fact_gag_examples
   WHERE stage = 'approved' AND gag_id IN (SELECT id FROM convert_gags WHERE NOT to_draft);
  GET DIAGNOSTICS v_examples_dropped = ROW_COUNT;
  UPDATE fact_gags
     SET approved_content = NULL, approved_by = NULL, approved_at = NULL,
         approved_before_example_sets = false, approved_carried_over = false, updated_at = now()
   WHERE id IN (SELECT id FROM convert_gags WHERE NOT to_draft);
  GET DIAGNOSTICS v_superseded = ROW_COUNT;

  -- a. The approved version is the draft.
  DELETE FROM fact_gag_examples
   WHERE stage = 'pending' AND gag_id IN (SELECT id FROM convert_gags WHERE to_draft);
  UPDATE fact_gag_examples SET stage = 'pending'
   WHERE stage = 'approved' AND gag_id IN (SELECT id FROM convert_gags WHERE to_draft);
  GET DIAGNOSTICS v_examples_moved = ROW_COUNT;
  UPDATE fact_gags
     SET pending_content = approved_content, pending_by = approved_by, pending_at = coalesce(approved_at, now()),
         approved_content = NULL, approved_by = NULL, approved_at = NULL,
         approved_before_example_sets = false, approved_carried_over = false, updated_at = now()
   WHERE id IN (SELECT id FROM convert_gags WHERE to_draft);
  GET DIAGNOSTICS v_to_draft = ROW_COUNT;

  RAISE NOTICE '0157_published_and_draft_gags: gags of approved facts untouched %; never-approved facts: approved version moved to the draft %, superseded by a draft %, draft only (no-op) %; examples moved to the draft %, superseded examples deleted %; removed gags skipped %',
    v_published, v_to_draft, v_superseded, v_draft_only, v_examples_moved, v_examples_dropped, v_removed;
END $$;--> statement-breakpoint
-- The conversion above queued the deferred gag triggers (0139, 0143);
-- PostgreSQL refuses DDL on a table with pending trigger events, so they fire
-- now, before the trigger below is created (the 0153 precedent).
SET CONSTRAINTS ALL IMMEDIATE;--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_published_gag_needs_approved_fact() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  g record;
BEGIN
  SELECT * INTO g FROM fact_gags WHERE id = NEW.id;
  IF NOT FOUND OR g.removed_at IS NOT NULL OR g.approved_content IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM facts f WHERE f.id = g.fact_id AND f.approved_at IS NOT NULL) THEN
    RAISE EXCEPTION 'gag % holds published content on fact %, which was never approved for production', g.id, g.fact_id
      USING ERRCODE = '23514', CONSTRAINT = 'fact_gags_published_needs_approved_fact';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "fact_gags_published_needs_approved_fact" ON "fact_gags";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "fact_gags_published_needs_approved_fact"
  AFTER INSERT OR UPDATE ON "fact_gags"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION enforce_published_gag_needs_approved_fact();
--> statement-breakpoint
-- 4. Draft more gags on a live fact is removed with live gag editing (plan
--    1.3: "removal of live gag editing from the old Facts page"). Its queued
--    jobs, its ownership marks and the ideas it stored are deleted: nothing
--    reads them any more, and a stored live draft no longer parses.
--    Row states: a live draft's job -> deleted; a fact a live draft owns ->
--    owner and status cleared; ideas a live draft wrote -> cleared; a
--    review's ideas -> untouched. Re-run: nothing left to match (no-op).
DO $$
DECLARE
  v_jobs integer := 0;
  v_owned integer := 0;
  v_ideas integer := 0;
BEGIN
  DELETE FROM async_jobs
   WHERE queue = 'fact_visual_concepts' AND coalesce(jsonb_typeof(payload -> 'reviewId'), 'null') = 'null';
  GET DIAGNOSTICS v_jobs = ROW_COUNT;
  UPDATE facts SET visual_concept_owner = NULL, visual_concept_status = NULL
   WHERE visual_concept_owner LIKE 'live:%';
  GET DIAGNOSTICS v_owned = ROW_COUNT;
  UPDATE facts SET visual_concept_candidates = NULL
   WHERE visual_concept_candidates ->> 'source' = 'live_fact'
      OR (visual_concept_candidates IS NOT NULL AND coalesce(jsonb_typeof(visual_concept_candidates -> 'reviewId'), 'null') = 'null');
  GET DIAGNOSTICS v_ideas = ROW_COUNT;
  RAISE NOTICE '0157_published_and_draft_gags (Draft more gags removed): live-draft jobs deleted %, ownership marks cleared %, stored live ideas cleared %',
    v_jobs, v_owned, v_ideas;
END $$;
