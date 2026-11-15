-- Every gag in one place (plan docs/plans/PLAN_THREE_GAGS.md, increment 1,
-- approved by David 2026-11-14, Issue #949). Expand AND contract in one
-- release: the policy allows it before Seed
-- (docs/engineering/migrations-and-backfills.md, "When it binds: from Seed"),
-- and a two-release split leaves a release that can neither approve nor
-- refresh a fact (plan, "Data Model and Migration Impact").
--
-- 1. fact_gags: one row per gag, slots 1-3, an approved version (with its
--    example render) and a pending change. Its checks: slot range, one
--    non-removed gag per fact and slot, a version present, an approved version
--    has an example unless carried over here, non-empty scenes, refresh-only
--    operations owned by a review.
-- 2. image_prompt_attempts.gag_id: the gag an attempt drew. A plain value: a
--    gag is deleted only with its fact, which deletes its attempts too.
-- 3. The data move. CAPTURED FIRST into feature_permissions_migration_log
--    under '0139_fact_gags': every fact's visual-strategy override and every
--    open refresh candidate's, whole, so the reverse script
--    (lib/db/reverse/0139_fact_gags.reverse.sql) can rebuild every prior state.
--    Then, per fact whose override has a non-empty scene, a slot-1 gag:
--      live, or ever production-approved  -> approved version, carried over
--                                            (no example on record; decision 14)
--      otherwise (staging)                -> pending content only
--    An open refresh candidate whose override differs from the fact's
--    (ignoring updatedBy/updatedAt) becomes the gag's pending content, owned
--    by the candidate's review. Then the override is removed from
--    facts.enrichment, facts.enrichment_ai_derived and the open candidate
--    (its enrichment and visual_override). Promoted, superseded and rejected
--    version rows are history and keep theirs.
--    Row-state matrix (counts are RAISEd as a NOTICE):
--      fact with scene, live / approved before   -> approved, carried over
--      fact with scene, never approved           -> pending
--      fact with an override but an empty scene  -> no gag; override removed
--      fact with no override                     -> untouched
--      open candidate differing / identical      -> pending on the gag / nothing
--      fact that already has a gag (re-run)      -> skipped
--      moderation test render of a moved gag     -> gag_id set to that gag
--    Each moved override is compared with what landed in fact_gags; any
--    difference, or a live fact left without an approved gag, aborts.
-- 4. One home, by construction: CHECKs refuse a gag in facts.enrichment,
--    facts.enrichment_ai_derived, or an open refresh candidate
--    (facts_enrichment_holds_no_gag, fev_open_candidate_holds_no_gag).
-- 5. facts_active_requires_concept (it read the gag from the enrichment) is
--    replaced by the constraint trigger enforce_live_fact_has_approved_gag:
--    a fact may be active only while it has a non-removed gag with an
--    approved version. It locks the fact row and then validates, so two
--    transactions removing different gags of one fact are serialised, and
--    the second sees the first's committed removal (READ COMMITTED, the
--    application's and psql's default).
--
-- A second run finds every gag in place and no override left: it captures
-- nothing and changes nothing.
-- Rollback: lib/db/reverse/0139_fact_gags.reverse.sql, valid until the first
-- gag is added, changed or approved under the new model; after that, fix
-- forward. Running it is David's call.
CREATE TABLE IF NOT EXISTS "fact_gags" (
  "id" bigserial PRIMARY KEY,
  "fact_id" integer NOT NULL REFERENCES "facts"("id") ON DELETE CASCADE,
  "slot" smallint NOT NULL,
  "approved_content" jsonb,
  "approved_example_attempt_id" bigint REFERENCES "image_prompt_attempts"("id"),
  "approved_carried_over" boolean NOT NULL DEFAULT false,
  "approved_by" varchar REFERENCES "users"("id") ON DELETE SET NULL,
  "approved_at" timestamp with time zone,
  "pending_content" jsonb,
  "pending_review_id" integer REFERENCES "pending_reviews"("id") ON DELETE SET NULL,
  "pending_example_attempt_id" bigint REFERENCES "image_prompt_attempts"("id"),
  "pending_remove" boolean NOT NULL DEFAULT false,
  "pending_by" varchar REFERENCES "users"("id") ON DELETE SET NULL,
  "pending_at" timestamp with time zone,
  "removed_at" timestamp with time zone,
  "removed_by" varchar REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by" varchar REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "fact_gags_slot_range" CHECK ("slot" BETWEEN 1 AND 3),
  CONSTRAINT "fact_gags_has_a_version" CHECK ("removed_at" IS NOT NULL OR "approved_content" IS NOT NULL OR "pending_content" IS NOT NULL),
  CONSTRAINT "fact_gags_approved_has_example" CHECK ("approved_content" IS NULL OR "approved_example_attempt_id" IS NOT NULL OR "approved_carried_over"),
  CONSTRAINT "fact_gags_approved_scene_nonempty" CHECK ("approved_content" IS NULL OR COALESCE(jsonb_typeof("approved_content" -> 'coreSceneOverride') = 'string' AND ("approved_content" ->> 'coreSceneOverride') ~ '\S', false)),
  CONSTRAINT "fact_gags_pending_scene_nonempty" CHECK ("pending_content" IS NULL OR COALESCE(jsonb_typeof("pending_content" -> 'coreSceneOverride') = 'string' AND ("pending_content" ->> 'coreSceneOverride') ~ '\S', false)),
  CONSTRAINT "fact_gags_pending_ops_owned" CHECK (("pending_example_attempt_id" IS NULL AND NOT "pending_remove") OR "pending_review_id" IS NOT NULL),
  CONSTRAINT "fact_gags_pending_example_has_content" CHECK ("pending_example_attempt_id" IS NULL OR "pending_content" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_fact_gags_fact_id" ON "fact_gags" ("fact_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_fact_gags_fact_slot_live" ON "fact_gags" ("fact_id", "slot") WHERE "removed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "image_prompt_attempts" ADD COLUMN IF NOT EXISTS "gag_id" bigint;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_ipa_gag_scenario_created" ON "image_prompt_attempts" ("gag_id", "review_render_scenario_key", "created_at" DESC);--> statement-breakpoint
-- The old rule read the gag from the enrichment, which the data move below
-- strips; a CHECK is enforced on each row as it is written, so it goes first
-- (Codex, PR #956 round 1). Outside the block, so an empty database loses it
-- too; the whole file is one transaction, so a later abort restores it.
ALTER TABLE "facts" DROP CONSTRAINT IF EXISTS "facts_active_requires_concept";--> statement-breakpoint
DO $$
DECLARE
  v_facts jsonb;
  v_candidates jsonb;
  v_approved integer := 0;
  v_pending integer := 0;
  v_empty integer := 0;
  v_refresh_pending integer := 0;
  v_refresh_same integer := 0;
  v_mismatch integer := 0;
  v_orphan integer := 0;
  v_attempts integer := 0;
BEGIN
  -- Capture: facts that still carry an override and have no gag yet, and the
  -- open candidates of those facts.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', f.id,
           'is_active', f.is_active,
           'override', f.enrichment -> 'visualPromptStrategyOverride',
           'ai_derived_override', f.enrichment_ai_derived -> 'visualPromptStrategyOverride'
         ) ORDER BY f.id), '[]'::jsonb)
    INTO v_facts
    FROM facts f
   WHERE (f.enrichment ? 'visualPromptStrategyOverride' OR f.enrichment_ai_derived ? 'visualPromptStrategyOverride')
     AND NOT EXISTS (SELECT 1 FROM fact_gags g WHERE g.fact_id = f.id);

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', v.id,
           'fact_id', v.fact_id,
           'source_review_id', v.source_review_id,
           'visual_override', v.visual_override,
           'enrichment_override', v.enrichment -> 'visualPromptStrategyOverride'
         ) ORDER BY v.id), '[]'::jsonb)
    INTO v_candidates
    FROM fact_enrichment_versions v
   WHERE v.status = 'candidate'
     AND (v.visual_override IS NOT NULL OR v.enrichment ? 'visualPromptStrategyOverride');

  IF v_facts = '[]'::jsonb AND v_candidates = '[]'::jsonb THEN
    RAISE NOTICE '0139_fact_gags: nothing to move';
    RETURN;
  END IF;

  INSERT INTO feature_permissions_migration_log (migration_name, deleted_rows)
    VALUES ('0139_fact_gags', jsonb_build_object('facts', v_facts, 'candidates', v_candidates));

  -- Slot-1 gags.
  WITH src AS (
    SELECT (x ->> 'id')::integer AS fact_id,
           (x ->> 'is_active')::boolean AS is_active,
           x -> 'override' AS ov
      FROM jsonb_array_elements(v_facts) x
     WHERE jsonb_typeof(x -> 'override' -> 'coreSceneOverride') = 'string'
       AND (x -> 'override' ->> 'coreSceneOverride') ~ '\S'
  ), classified AS (
    SELECT s.*,
           (s.is_active OR EXISTS (
              SELECT 1 FROM pending_reviews r
               WHERE r.approved_fact_id = s.fact_id AND r.workflow_stage = 'production_approved'
           )) AS approved
      FROM src s
  ), ins AS (
    INSERT INTO fact_gags (fact_id, slot, approved_content, approved_carried_over, pending_content)
    SELECT c.fact_id, 1,
           CASE WHEN c.approved THEN c.ov END,
           c.approved,
           CASE WHEN c.approved THEN NULL ELSE c.ov END
      FROM classified c
    RETURNING approved_content IS NOT NULL AS approved
  )
  SELECT count(*) FILTER (WHERE approved), count(*) FILTER (WHERE NOT approved)
    INTO v_approved, v_pending FROM ins;

  SELECT count(*) INTO v_empty
    FROM jsonb_array_elements(v_facts) x
   WHERE NOT (jsonb_typeof(x -> 'override' -> 'coreSceneOverride') = 'string'
              AND (x -> 'override' ->> 'coreSceneOverride') ~ '\S');

  -- Every moved override landed byte-for-byte.
  SELECT count(*) INTO v_mismatch
    FROM jsonb_array_elements(v_facts) x
    JOIN fact_gags g ON g.fact_id = (x ->> 'id')::integer AND g.slot = 1 AND g.removed_at IS NULL
   WHERE coalesce(g.approved_content, g.pending_content) IS DISTINCT FROM x -> 'override';
  IF v_mismatch > 0 THEN
    RAISE EXCEPTION '0139_fact_gags: % moved gags differ from their source override', v_mismatch;
  END IF;

  -- The moderation test renders already made drew the fact's only gag: they
  -- now name it, so an in-flight review's grid keeps its renders (a render's
  -- input hash is unchanged by the move, so they keep their freshness too).
  WITH upd AS (
    UPDATE image_prompt_attempts a
       SET gag_id = g.id
      FROM fact_gags g
     WHERE a.gag_id IS NULL
       AND a.review_render_scenario_key IS NOT NULL
       AND g.fact_id = a.fact_id AND g.slot = 1 AND g.removed_at IS NULL
       AND a.fact_id IN (SELECT (x ->> 'id')::integer FROM jsonb_array_elements(v_facts) x)
    RETURNING 1
  )
  SELECT count(*) INTO v_attempts FROM upd;

  -- Open refresh candidates whose gag differs become that gag's pending change.
  WITH cand AS (
    SELECT (c ->> 'fact_id')::integer AS fact_id,
           (c ->> 'source_review_id')::integer AS review_id,
           coalesce(c -> 'visual_override', c -> 'enrichment_override') AS ov
      FROM jsonb_array_elements(v_candidates) c
  ), upd AS (
    UPDATE fact_gags g
       SET pending_content = cand.ov,
           pending_review_id = cand.review_id,
           pending_at = now(),
           updated_at = g.created_at
      FROM cand
     WHERE g.fact_id = cand.fact_id AND g.slot = 1 AND g.removed_at IS NULL
       AND g.approved_content IS NOT NULL
       AND jsonb_typeof(cand.ov -> 'coreSceneOverride') = 'string'
       AND (cand.ov ->> 'coreSceneOverride') ~ '\S'
       AND (cand.ov - 'updatedBy' - 'updatedAt') IS DISTINCT FROM (g.approved_content - 'updatedBy' - 'updatedAt')
    RETURNING 1
  )
  SELECT count(*) INTO v_refresh_pending FROM upd;
  v_refresh_same := jsonb_array_length(v_candidates) - v_refresh_pending;

  -- The enrichment and the open candidates stop carrying a gag.
  UPDATE facts
     SET enrichment = enrichment - 'visualPromptStrategyOverride',
         enrichment_ai_derived = enrichment_ai_derived - 'visualPromptStrategyOverride'
   WHERE id IN (SELECT (x ->> 'id')::integer FROM jsonb_array_elements(v_facts) x);
  UPDATE fact_enrichment_versions
     SET visual_override = NULL,
         enrichment = enrichment - 'visualPromptStrategyOverride'
   WHERE id IN (SELECT (c ->> 'id')::integer FROM jsonb_array_elements(v_candidates) c);

  SELECT count(*) INTO v_orphan
    FROM facts f
   WHERE f.is_active
     AND NOT EXISTS (SELECT 1 FROM fact_gags g
                      WHERE g.fact_id = f.id AND g.removed_at IS NULL AND g.approved_content IS NOT NULL);
  IF v_orphan > 0 THEN
    RAISE EXCEPTION '0139_fact_gags: % live facts would have no approved gag', v_orphan;
  END IF;

  RAISE NOTICE '0139_fact_gags: % approved (carried over), % pending, % empty-scene overrides removed, % refresh candidates moved to pending, % identical, % test renders now name their gag',
    v_approved, v_pending, v_empty, v_refresh_pending, v_refresh_same, v_attempts;
END $$;--> statement-breakpoint
ALTER TABLE "facts" DROP CONSTRAINT IF EXISTS "facts_enrichment_holds_no_gag";--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_enrichment_holds_no_gag" CHECK (
  NOT coalesce("enrichment" ? 'visualPromptStrategyOverride', false)
  AND NOT coalesce("enrichment_ai_derived" ? 'visualPromptStrategyOverride', false));--> statement-breakpoint
ALTER TABLE "fact_enrichment_versions" DROP CONSTRAINT IF EXISTS "fev_open_candidate_holds_no_gag";--> statement-breakpoint
ALTER TABLE "fact_enrichment_versions" ADD CONSTRAINT "fev_open_candidate_holds_no_gag" CHECK (
  "status" <> 'candidate' OR ("visual_override" IS NULL AND NOT coalesce("enrichment" ? 'visualPromptStrategyOverride', false)));--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_live_fact_has_approved_gag() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_fact integer;
  v_active boolean;
BEGIN
  IF TG_TABLE_NAME = 'facts' THEN
    v_fact := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_fact := OLD.fact_id;
  ELSE
    v_fact := NEW.fact_id;
  END IF;
  -- Lock the fact first, then validate in a fresh statement: a concurrent
  -- change to another of this fact's gags has either committed (and is seen
  -- here) or waits for this transaction.
  SELECT f.is_active INTO v_active FROM facts f WHERE f.id = v_fact FOR UPDATE;
  IF NOT FOUND OR NOT v_active THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM fact_gags g
     WHERE g.fact_id = v_fact AND g.removed_at IS NULL AND g.approved_content IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'fact % is live and would have no approved gag', v_fact
      USING ERRCODE = '23514', CONSTRAINT = 'facts_live_requires_approved_gag';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "facts_live_requires_approved_gag" ON "facts";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "facts_live_requires_approved_gag"
  AFTER INSERT OR UPDATE OF "is_active" ON "facts"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.is_active)
  EXECUTE FUNCTION enforce_live_fact_has_approved_gag();--> statement-breakpoint
DROP TRIGGER IF EXISTS "fact_gags_live_fact_keeps_approved_gag" ON "fact_gags";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "fact_gags_live_fact_keeps_approved_gag"
  AFTER INSERT OR UPDATE OR DELETE ON "fact_gags"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION enforce_live_fact_has_approved_gag();
