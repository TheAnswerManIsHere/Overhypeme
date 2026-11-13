-- The Eval page as two wizards (plan docs/plans/PLAN_EVAL_PAGE.md, C and D).
-- Expand only; every existing set reads exactly as before.
--
-- comparison_sets.finished_at: when the admin pressed Finish after judging
--   every judgeable panel; null until then (and on every older set).
-- comparison_sets.request_token: the token the wizard sends with Generate
--   Images, so a repeated request (a lost response, a double tap) returns the
--   evaluation it already made instead of buying a second batch. Null on sets
--   made any other way.
-- comparison_cells.state gains "waiting": admitted and reserved with its
--   panel's preparation, queued the moment the panel is prepared. The column
--   is varchar with no check constraint, so no DDL is needed for it.
ALTER TABLE "comparison_sets" ADD COLUMN IF NOT EXISTS "finished_at" timestamp with time zone;
ALTER TABLE "comparison_sets" ADD COLUMN IF NOT EXISTS "request_token" varchar(64);
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_comparison_sets_request_token" ON "comparison_sets" ("request_token") WHERE "request_token" IS NOT NULL;
