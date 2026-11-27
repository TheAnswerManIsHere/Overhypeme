-- A gag's one-line description, and the caption a member's picture was made
-- for (Phase 7 amendment; plan docs/plans/PLAN_PHASE7_AI_PICTURE_FLOW.md,
-- approved by David 2026-11-26, Issue #1331). EXPAND only: one new table and
-- one nullable column. Nothing the previous release reads or writes changes.
--
-- 1. fact_gag_descriptions: one row per gag and content fingerprint (a hash of
--    the scene and bubbles the description describes). A description never
--    lives inside the gag's drawing content, so it never reaches a prompt or
--    render freshness, and publishing content brings its own description with
--    nothing to copy: members see the reviewed row whose fingerprint equals
--    the published content's (Q15: 1).
--      text         the line, with personalization tokens; NULL while the
--                   drafting sweep has not produced one (or failed: last_error)
--      origin       'ai' (drafted by the sweep) or 'moderator' (written or
--                   edited by a moderator); a moderator row is never replaced
--      reviewed_*   set when a moderator reviews it; members see only reviewed
--      attempts / last_error   the sweep's record of failed drafting
--
-- 2. image_prompt_attempts.member_caption: the name and pronouns a member's
--    picture's meme caption was meant to carry ({ name, pronouns }), so a
--    picture returned to later hands the builder the right name. NULL on every
--    other attempt and on member pictures made before this release.
--
-- Row-state matrix: no backfill here. Every existing gag starts with no row
-- (no description; the drafting sweep, a job, fills them as drafts, which
-- publish nothing). Every existing attempt keeps NULL member_caption.
--
-- Recovery: restore the previous application code and leave all of this in
-- place; it neither reads nor writes any of it, and moderators' text survives.

CREATE TABLE IF NOT EXISTS "fact_gag_descriptions" (
  "id" bigserial PRIMARY KEY,
  "gag_id" bigint NOT NULL REFERENCES "fact_gags"("id") ON DELETE CASCADE,
  "content_fingerprint" varchar(64) NOT NULL,
  "text" varchar(160),
  "origin" varchar(16) NOT NULL DEFAULT 'ai',
  "reviewed_by" varchar REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewed_at" timestamptz,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "fact_gag_descriptions_origin" CHECK (((origin)::text = ANY (ARRAY[('ai'::character varying)::text, ('moderator'::character varying)::text]))),
  CONSTRAINT "fact_gag_descriptions_reviewed_has_text" CHECK ((reviewed_at IS NULL) OR (text IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_fact_gag_descriptions_gag_fingerprint"
  ON "fact_gag_descriptions" ("gag_id", "content_fingerprint");

ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "member_caption" jsonb;
