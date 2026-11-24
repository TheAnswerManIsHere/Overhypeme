-- An email-and-password sign-up returns to the page it started from (plan
-- docs/plans/PLAN_SIGNUP_RETURN.md, approved by David 2026-11-24, Issue #1203,
-- Q6). Additive. Numbered 0166 because 0165 is held by the fact house-style
-- pass on another branch; the runner applies by hash, so the gap is harmless.
--
-- users.signup_return_to: the same-site page a person registered from, written
-- once at registration and cleared when their registration email is verified.
-- text, not varchar(n): no length the return-path validators accept may make
-- registration fail (Astra, plan C1).
--
-- Row-state matrix (counts are RAISEd as a NOTICE):
--   column absent / present   -> added / no-op
--   every existing row        -> NULL (no captured page; the profile default)
-- No backfill. A second run adds nothing.
--
-- Recovery: keep the column and restore the previous application code; that
-- code ignores it (plan C2). Remove it only after its application uses are gone.
DO $$
DECLARE
  v_added integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'signup_return_to'
  ) THEN
    ALTER TABLE users ADD COLUMN signup_return_to text;
    v_added := 1;
  END IF;
  RAISE NOTICE '[0166] signup_return_to added=%', v_added;
END $$;
