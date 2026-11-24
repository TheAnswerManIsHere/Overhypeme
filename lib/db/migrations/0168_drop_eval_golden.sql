-- Drop the "evaluation golden" marker (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md,
-- oracle item 23; Issue #1018, increment 3.2e). The eval harness that read it is
-- gone, the Facts list stopped sending it in 3.1 (PR #1217), and nothing in the
-- application reads or writes facts.eval_golden or eval_golden_reason.
--
-- Row-state matrix (counts are RAISEd as a NOTICE):
--   column present -> the facts marked golden, and those with a reason, counted,
--                     then the partial index IDX_facts_eval_golden and both
--                     columns dropped
--   column absent  -> no-op (a re-run, or a database that never had it)
--
-- Re-running is a no-op. Rollback: the marks are gone; the code and schema are
-- at tag pre-cut/fact-admin-legacy (docs/retired/README.md).
DO $$
DECLARE
  v_golden integer := 0;
  v_reasons integer := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'facts' AND column_name = 'eval_golden') THEN
    EXECUTE 'SELECT count(*) FILTER (WHERE eval_golden), count(*) FILTER (WHERE eval_golden_reason IS NOT NULL) FROM facts'
      INTO v_golden, v_reasons;
  END IF;
  DROP INDEX IF EXISTS "IDX_facts_eval_golden";
  ALTER TABLE facts DROP COLUMN IF EXISTS eval_golden;
  ALTER TABLE facts DROP COLUMN IF EXISTS eval_golden_reason;
  RAISE NOTICE '[0168] eval_golden dropped: % fact(s) were marked golden, % had a reason', v_golden, v_reasons;
END $$;
