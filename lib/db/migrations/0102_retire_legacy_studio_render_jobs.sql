-- Launch Phase 4, removal 1: the legacy meme studio is deleted (#744; plan
-- docs/plans/PLAN_PHASE4_CUT_AND_PRUNE.md, approved by David 2026-10-22).
--
-- The studio's user routes (the no-photo branch of POST /memes/ai/:factId/generate,
-- and /generate-v2) were the only producers of USER-OWNED render attempts. Their
-- queued work lives in the shared render queues (image_prompt_generation and its
-- chained image_generation) beside moderation and eval renders, which stay. With
-- the routes gone, a pending or interrupted user job would still run — and spend
-- on a vendor — after nothing can ever read its result. This retires exactly
-- those jobs and nothing else.
--
-- WHICH ATTEMPTS ARE THE STUDIO'S, by provenance (imagePromptAttempts.ts:99 and
-- its callers at the plan's base 8b42ee5):
--   * moderation scenario renders carry review_id               -> kept
--   * the single-review admin render carries render_controls.reviewAudit
--     and a request_id starting 'admin-review:' (userId is NULL)  -> kept
--   * eval-run renders carry eval_run_id                          -> kept
--   * the studio's user renders carry user_id and none of the above -> retired
-- A missing review_id alone is NOT the predicate: the single-review and eval
-- paths lack one too. An attempt whose user was deleted has user_id NULL
-- (ON DELETE SET NULL) and is indistinguishable from an admin row, so it is
-- left alone and only counted.
--
-- RETIRED means terminal: status 'failed' with a last_error naming why. The
-- attempt rows themselves are untouched; user attempts are rating data for the
-- eval harness.
--
-- ORDERING: this must run only after every old process is stopped — an
-- executing handler enqueues its successor without re-reading its row, and a
-- retry finalization can write 'pending' back over this. The close-out runs it
-- under the plan's stop-first cutover (Data Model and Migration Impact).
--
-- IDEMPOTENT: a second run finds no nonterminal job to retire and reports 0.

DO $$
DECLARE
  retired_count integer;
  kept_count integer;
  orphan_count integer;
BEGIN
  WITH studio_attempts AS (
    SELECT id FROM image_prompt_attempts
    WHERE user_id IS NOT NULL
      AND review_id IS NULL
      AND eval_run_id IS NULL
      AND (render_controls -> 'reviewAudit') IS NULL
      AND (request_id IS NULL OR request_id NOT LIKE 'admin-review:%')
  ), retired AS (
    UPDATE async_jobs j
    SET status = 'failed',
        last_error = 'retired: the legacy meme studio was removed (launch Phase 4, removal 1)',
        updated_at = now()
    WHERE j.queue IN ('image_prompt_generation', 'image_generation')
      AND j.status IN ('pending', 'processing')
      AND (j.payload ->> 'attemptId') ~ '^[0-9]+$'
      AND (j.payload ->> 'attemptId')::bigint IN (SELECT id FROM studio_attempts)
    RETURNING j.id
  )
  SELECT count(*) INTO retired_count FROM retired;

  SELECT count(*) INTO kept_count
  FROM async_jobs j
  WHERE j.queue IN ('image_prompt_generation', 'image_generation')
    AND j.status IN ('pending', 'processing');

  SELECT count(*) INTO orphan_count
  FROM async_jobs j
  JOIN image_prompt_attempts a ON a.id = (j.payload ->> 'attemptId')::bigint
  WHERE j.queue IN ('image_prompt_generation', 'image_generation')
    AND j.status IN ('pending', 'processing')
    AND (j.payload ->> 'attemptId') ~ '^[0-9]+$'
    AND a.user_id IS NULL AND a.review_id IS NULL AND a.eval_run_id IS NULL
    AND (a.render_controls -> 'reviewAudit') IS NULL
    AND (a.request_id IS NULL OR a.request_id NOT LIKE 'admin-review:%');

  RAISE NOTICE '[0102] legacy studio render jobs retired: %, nonterminal render jobs kept: %, of which unattributable (owner deleted, left alone): %',
    retired_count, kept_count, orphan_count;
END $$;
