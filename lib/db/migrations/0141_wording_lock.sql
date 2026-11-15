-- A fact's wording locks at triage (plan docs/plans/PLAN_THREE_GAGS.md,
-- increment 3, section G; David 2026-11-14, Q5 and Q6; Issue #959).
--
-- 1. facts.text cannot change once the row exists: a BEFORE UPDATE trigger
--    refuses any update that changes it. A wording problem after triage means
--    withdrawing or replacing the fact, never editing it. A token or
--    normalisation repair that would rewrite stored text needs its own
--    migration that lifts this rule, on David's say.
-- 2. Triage edits: pending_reviews records the wording as submitted and who
--    edited it, when an admin edits a submission's wording before accepting it.
-- 3. Withdraw: a submission past triage whose wording needs replacing ends its
--    review for good (pending_reviews.withdrawn_at/by), and its staging fact
--    can never go live (facts.wording_withdrawn_at, with a CHECK).
--
-- Additive; no existing row changes. Reversal: drop the trigger and function,
-- the CHECK and the five columns (none holds data another table depends on).

CREATE OR REPLACE FUNCTION refuse_fact_text_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.text IS DISTINCT FROM OLD.text THEN
    RAISE EXCEPTION 'A fact''s wording cannot change once it exists (fact %).', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'facts_text_is_locked';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS facts_text_is_locked ON facts;--> statement-breakpoint
CREATE TRIGGER facts_text_is_locked
  BEFORE UPDATE OF text ON facts
  FOR EACH ROW EXECUTE FUNCTION refuse_fact_text_change();--> statement-breakpoint

ALTER TABLE facts ADD COLUMN IF NOT EXISTS wording_withdrawn_at timestamptz;--> statement-breakpoint
ALTER TABLE facts DROP CONSTRAINT IF EXISTS facts_withdrawn_stays_inactive;--> statement-breakpoint
ALTER TABLE facts ADD CONSTRAINT facts_withdrawn_stays_inactive
  CHECK (NOT (is_active AND wording_withdrawn_at IS NOT NULL));--> statement-breakpoint

ALTER TABLE pending_reviews ADD COLUMN IF NOT EXISTS submitted_text_original text;--> statement-breakpoint
ALTER TABLE pending_reviews ADD COLUMN IF NOT EXISTS wording_edited_by varchar REFERENCES users(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE pending_reviews ADD COLUMN IF NOT EXISTS wording_edited_at timestamptz;--> statement-breakpoint
ALTER TABLE pending_reviews ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz;--> statement-breakpoint
ALTER TABLE pending_reviews ADD COLUMN IF NOT EXISTS withdrawn_by varchar REFERENCES users(id) ON DELETE SET NULL;
