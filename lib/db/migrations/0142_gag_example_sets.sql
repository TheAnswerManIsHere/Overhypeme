-- A gag's examples are one per subject kind: male, female and pet (plan
-- docs/plans/PLAN_GAG_EXAMPLES.md, increment 1; David 2026-11-15, Q8, Q10, Q11;
-- Issue #965).
--
-- 1. fact_gag_examples holds a gag's examples, one per subject kind per stage.
--    "approved" examples belong to the approved version users get; "pending"
--    examples are picks for the gag's pending content, which apply when the set
--    completes (outside a refresh) or at promotion (inside one).
-- 2. Existing selections are COPIED, never moved: approved_example_attempt_id
--    and pending_example_attempt_id stay on fact_gags as unread recovery
--    snapshots. Replit's publish applies its own schema diff before this runner
--    and copies structure, not rows, so dropping them in this release could
--    lose them before the copy reads them. A later migration drops them.
-- 3. approved_before_example_sets marks a gag approved before example sets
--    (every approved gag here: carried over by 0139, or approved with one
--    example). It stays offered with fewer than three examples (Q11) until it
--    first completes a set.
-- 4. The rule "approved content has a complete set, or is grandfathered" spans
--    two tables, so it is a deferred constraint trigger. It replaces the
--    row-level fact_gags_approved_has_example. The two checks that consulted
--    pending_example_attempt_id stop doing so: one is dropped, one rewritten,
--    so a refresh migrated with a pick can still be discarded, declined or
--    promoted.
--
-- Idempotent; correct whichever of the runner and Replit's schema diff reaches
-- a database first. Reversal: lib/db/reverse/0142_gag_example_sets.reverse.sql,
-- exact until examples are approved under the new model.

CREATE TABLE IF NOT EXISTS "fact_gag_examples" (
  "id" bigserial PRIMARY KEY,
  "gag_id" bigint NOT NULL REFERENCES "fact_gags"("id") ON DELETE CASCADE,
  "subject_kind" varchar(16) NOT NULL,
  "stage" varchar(16) NOT NULL,
  "attempt_id" bigint NOT NULL REFERENCES "image_prompt_attempts"("id"),
  "approved_by" varchar REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- The checks are written as Postgres prints them after a dump and restore,
  -- so a restored database compares equal to a built one.
  CONSTRAINT "fact_gag_examples_kind" CHECK ((subject_kind)::text = ANY (ARRAY[('male'::character varying)::text, ('female'::character varying)::text, ('pet'::character varying)::text])),
  CONSTRAINT "fact_gag_examples_stage" CHECK ((stage)::text = ANY (ARRAY[('approved'::character varying)::text, ('pending'::character varying)::text]))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_fact_gag_examples_gag_kind_stage"
  ON "fact_gag_examples" ("gag_id", "subject_kind", "stage");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_fact_gag_examples_attempt" ON "fact_gag_examples" ("attempt_id");--> statement-breakpoint

ALTER TABLE "fact_gags" ADD COLUMN IF NOT EXISTS "approved_before_example_sets" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- The checks that read the retained columns stop governing current state.
ALTER TABLE "fact_gags" DROP CONSTRAINT IF EXISTS "fact_gags_approved_has_example";--> statement-breakpoint
ALTER TABLE "fact_gags" DROP CONSTRAINT IF EXISTS "fact_gags_pending_example_has_content";--> statement-breakpoint
ALTER TABLE "fact_gags" DROP CONSTRAINT IF EXISTS "fact_gags_pending_ops_owned";--> statement-breakpoint
ALTER TABLE "fact_gags" ADD CONSTRAINT "fact_gags_pending_ops_owned"
  CHECK (NOT "pending_remove" OR "pending_review_id" IS NOT NULL);--> statement-breakpoint

-- Copy each existing selection under the subject kind of the render it names.
-- A render of a retired scenario (generic, object/vehicle) maps to no kind and
-- is not copied; its gag is grandfathered below.
DO $$
DECLARE
  v_approved integer;
  v_pending integer;
  v_unmapped integer;
  v_grandfathered integer;
BEGIN
  WITH src AS (
    SELECT g.id AS gag_id, 'approved' AS stage, g.approved_example_attempt_id AS attempt_id, g.approved_by
      FROM fact_gags g WHERE g.approved_example_attempt_id IS NOT NULL
    UNION ALL
    SELECT g.id, 'pending', g.pending_example_attempt_id, g.pending_by
      FROM fact_gags g WHERE g.pending_example_attempt_id IS NOT NULL
  ), mapped AS (
    SELECT s.gag_id, s.stage, s.attempt_id, s.approved_by,
           CASE a.review_render_scenario_key
             WHEN 'i2i_male_default' THEN 'male'
             WHEN 'i2i_female_default' THEN 'female'
             WHEN 'i2i_nonhuman_animal' THEN 'pet'
           END AS kind
      FROM src s JOIN image_prompt_attempts a ON a.id = s.attempt_id
  ), ins AS (
    INSERT INTO fact_gag_examples (gag_id, subject_kind, stage, attempt_id, approved_by)
    SELECT gag_id, kind, stage, attempt_id, approved_by FROM mapped WHERE kind IS NOT NULL
    ON CONFLICT (gag_id, subject_kind, stage) DO NOTHING
    RETURNING stage
  )
  SELECT count(*) FILTER (WHERE stage = 'approved'), count(*) FILTER (WHERE stage = 'pending')
    INTO v_approved, v_pending FROM ins;

  SELECT count(*) INTO v_unmapped FROM (
    SELECT g.approved_example_attempt_id AS attempt_id FROM fact_gags g WHERE g.approved_example_attempt_id IS NOT NULL
    UNION ALL
    SELECT g.pending_example_attempt_id FROM fact_gags g WHERE g.pending_example_attempt_id IS NOT NULL
  ) s JOIN image_prompt_attempts a ON a.id = s.attempt_id
  WHERE a.review_render_scenario_key IS NULL
     OR a.review_render_scenario_key NOT IN ('i2i_male_default', 'i2i_female_default', 'i2i_nonhuman_animal');

  -- Every approved gag without a complete approved set predates example sets.
  WITH upd AS (
    UPDATE fact_gags g SET approved_before_example_sets = true
     WHERE g.approved_content IS NOT NULL
       AND NOT g.approved_before_example_sets
       AND (SELECT count(*) FROM fact_gag_examples e WHERE e.gag_id = g.id AND e.stage = 'approved') < 3
    RETURNING 1
  )
  SELECT count(*) INTO v_grandfathered FROM upd;

  RAISE NOTICE '0142: copied % approved and % pending example(s); % selection(s) of a retired scenario not copied; % gag(s) grandfathered',
    v_approved, v_pending, v_unmapped, v_grandfathered;
END $$;--> statement-breakpoint

-- A gag's example set, enforced at commit. Approved content needs all three
-- approved kinds unless the gag is grandfathered; a pending example needs
-- pending content. Removed gags are history and are not checked. Locks the
-- fact first, the order the live-fact trigger uses.
CREATE OR REPLACE FUNCTION enforce_gag_example_set() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_gag bigint;
  v_fact integer;
  g record;
  v_kinds integer;
BEGIN
  IF TG_TABLE_NAME = 'fact_gags' THEN
    v_gag := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    v_gag := CASE WHEN TG_OP = 'DELETE' THEN OLD.gag_id ELSE NEW.gag_id END;
  END IF;
  SELECT fact_id INTO v_fact FROM fact_gags WHERE id = v_gag;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM facts WHERE id = v_fact FOR UPDATE;
  SELECT * INTO g FROM fact_gags WHERE id = v_gag FOR UPDATE;
  IF g.removed_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  -- Grandfathered: approved before example sets (0142) or carried over by 0139.
  IF g.approved_content IS NOT NULL AND NOT (g.approved_before_example_sets OR g.approved_carried_over) THEN
    SELECT count(DISTINCT subject_kind) INTO v_kinds
      FROM fact_gag_examples WHERE gag_id = v_gag AND stage = 'approved';
    IF v_kinds < 3 THEN
      RAISE EXCEPTION 'gag % is approved without its male, female and pet examples', v_gag
        USING ERRCODE = '23514', CONSTRAINT = 'fact_gags_approved_has_example_set';
    END IF;
  END IF;
  IF g.pending_content IS NULL AND EXISTS (
    SELECT 1 FROM fact_gag_examples WHERE gag_id = v_gag AND stage = 'pending'
  ) THEN
    RAISE EXCEPTION 'gag % has pending examples without pending content', v_gag
      USING ERRCODE = '23514', CONSTRAINT = 'fact_gag_examples_pending_has_content';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "fact_gags_example_set" ON "fact_gags";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "fact_gags_example_set"
  AFTER INSERT OR UPDATE ON "fact_gags"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION enforce_gag_example_set();--> statement-breakpoint
DROP TRIGGER IF EXISTS "fact_gag_examples_set" ON "fact_gag_examples";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "fact_gag_examples_set"
  AFTER INSERT OR UPDATE OR DELETE ON "fact_gag_examples"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION enforce_gag_example_set();
