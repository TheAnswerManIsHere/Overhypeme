-- People and pets only (plan docs/plans/PLAN_GAG_EXAMPLES.md, increment 2;
-- David 2026-11-15, Q9; Issue #964). A picture's subject is a person or a pet.
-- Under "Deprecated means removed" (decisions.md, 2026-11-17) the stored
-- records that only the vehicle, object and mascot subject kinds produced are
-- deleted or converted, never kept as history.
--
-- What changes, in this order:
-- 1. Comparison panels drawn from the object/vehicle reference
--    (scenario_key i2i_nonhuman_object_vehicle, or reference_identity_type
--    nonhuman_object_vehicle) are deleted; their cells and picks cascade and a
--    reservation's panel link nulls by its foreign key. The scenario key is
--    taken out of every comparison set's scenario_keys.
-- 2. Render attempts that only that scenario or those kinds produced are
--    deleted: a moderation or evaluation render from the object/vehicle
--    reference, and any attempt whose stored photo analysis or visual plan
--    names an object, vehicle or mascot subject. Before deleting, a legacy
--    pick snapshot on fact_gags pointing at one is cleared. An attempt that is
--    a gag's male, female or pet example is never one of these; if one were,
--    the migration refuses rather than break a gag's example set.
-- 3. A cached photo analysis on upload_image_metadata naming one of those
--    kinds is dropped, so the photo is analysed afresh (people and pets only).
-- 4. The promoted prompt-recipe piece "identity.object" is removed from every
--    stored version; the code's piece is now "identity.pet", and recipeFrom
--    ignores a key it does not define, so the stored text was already inert.
--
-- Runs inside the migration runner's transaction, is idempotent (a second run
-- finds nothing to change), and prints a NOTICE with every count. Rollback:
-- the deleted rows cannot be restored; restore from a backup taken before the
-- migration if they are needed.

DO $$
DECLARE
  v_panels integer := 0;
  v_sets integer := 0;
  v_attempts integer := 0;
  v_gag_snapshots integer := 0;
  v_uploads integer := 0;
  v_recipes integer := 0;
  v_examples integer := 0;
  v_rows integer := 0;
BEGIN
  -- 1. Comparison panels and sets.
  DELETE FROM comparison_panels
   WHERE scenario_key = 'i2i_nonhuman_object_vehicle'
      OR reference_identity_type = 'nonhuman_object_vehicle';
  GET DIAGNOSTICS v_panels = ROW_COUNT;

  UPDATE comparison_sets
     SET scenario_keys = scenario_keys - 'i2i_nonhuman_object_vehicle'
   WHERE jsonb_typeof(scenario_keys) = 'array'
     AND scenario_keys ? 'i2i_nonhuman_object_vehicle';
  GET DIAGNOSTICS v_sets = ROW_COUNT;

  -- 2. Render attempts.
  CREATE TEMP TABLE _retired_subject_attempts ON COMMIT DROP AS
  SELECT a.id
    FROM image_prompt_attempts a
   WHERE a.review_render_scenario_key = 'i2i_nonhuman_object_vehicle'
      OR a.eval_scenario_key = 'i2i_nonhuman_object_vehicle'
      OR a.review_reference_identity_type = 'nonhuman_object_vehicle'
      OR a.source_image_analysis ->> 'subjectKind'
           IN ('object_subject', 'vehicle_subject', 'mascot_or_character_subject')
      OR a.visual_plan #>> '{subjectTreatment,nonhumanSubjectTreatment,subjectKind}'
           IN ('object_subject', 'vehicle_subject', 'mascot_or_character_subject');

  SELECT count(*) INTO v_examples
    FROM fact_gag_examples e
    JOIN _retired_subject_attempts r ON r.id = e.attempt_id;
  IF v_examples > 0 THEN
    RAISE EXCEPTION '0145_people_and_pets_only: % gag example(s) use a vehicle, object or mascot render; refusing to break an example set', v_examples;
  END IF;

  UPDATE fact_gags SET approved_example_attempt_id = NULL
   WHERE approved_example_attempt_id IN (SELECT id FROM _retired_subject_attempts);
  GET DIAGNOSTICS v_gag_snapshots = ROW_COUNT;
  UPDATE fact_gags SET pending_example_attempt_id = NULL
   WHERE pending_example_attempt_id IN (SELECT id FROM _retired_subject_attempts);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_gag_snapshots := v_gag_snapshots + v_rows;

  DELETE FROM image_prompt_attempts WHERE id IN (SELECT id FROM _retired_subject_attempts);
  GET DIAGNOSTICS v_attempts = ROW_COUNT;

  -- 3. Cached photo analyses.
  UPDATE upload_image_metadata
     SET source_image_analysis = NULL,
         source_image_analysis_version = NULL
   WHERE source_image_analysis ->> 'subjectKind'
           IN ('object_subject', 'vehicle_subject', 'mascot_or_character_subject');
  GET DIAGNOSTICS v_uploads = ROW_COUNT;

  -- 4. Stored prompt recipes.
  UPDATE prompt_recipe_versions
     SET pieces = pieces - 'identity.object'
   WHERE jsonb_typeof(pieces) = 'object' AND pieces ? 'identity.object';
  GET DIAGNOSTICS v_recipes = ROW_COUNT;

  RAISE NOTICE '0145_people_and_pets_only: deleted % comparison panel(s), % render attempt(s); updated % comparison set(s), % gag pick snapshot(s), % cached upload analysis(es), % recipe version(s)',
    v_panels, v_attempts, v_sets, v_gag_snapshots, v_uploads, v_recipes;
END $$;
