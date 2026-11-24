-- Drop the approved-text edit history (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md,
-- oracle item 23; Issue #1018, increment 3.2e). A fact's wording is fixed once
-- approved (Must Not Change), the edit route that wrote this table went in 3.2c
-- (PR #1240), and its panel went from the screen in 3.1 (PR #1217). Nothing reads
-- or writes it.
--
-- Row-state matrix (counts are RAISEd as a NOTICE):
--   table present -> its rows counted, then the table, its index, its foreign
--                    keys and its id sequence dropped (CASCADE is not used: the
--                    table is a leaf, nothing references it)
--   table absent  -> no-op (a re-run, or a database that never had it)
--
-- Re-running is a no-op. Rollback: the rows are gone; the code and schema are
-- at tag pre-cut/fact-admin-legacy (docs/retired/README.md). The rows were an
-- audit trail of past wording edits, kept nowhere else.
DO $$
DECLARE
  v_rows integer := 0;
BEGIN
  IF to_regclass('fact_text_edit_history') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM fact_text_edit_history' INTO v_rows;
    DROP TABLE fact_text_edit_history;
    RAISE NOTICE '[0167] fact_text_edit_history dropped: % row(s)', v_rows;
  ELSE
    RAISE NOTICE '[0167] fact_text_edit_history absent: no-op';
  END IF;
END $$;
