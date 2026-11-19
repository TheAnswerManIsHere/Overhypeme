-- Support requests (launch Phase 16, increment 5; plan
-- docs/plans/PLAN_PHASE16_ANALYTICS_OPERATIONS.md, design E and amendment 3,
-- David's Q17: 1). Resend keeps mail 30 days, so every request the contact
-- page accepts is also kept here. Expand only: one new table, which the
-- previous release never reads, and the stored reply-to moved off the retired
-- Gmail alias.
--
-- Row states:
--   support_requests: new and empty (no-op on re-run: IF NOT EXISTS).
--   admin_config email_reply_to: the retired alias becomes support@overhype.me;
--     any other value (an admin's own choice, or blank) is left alone; a
--     missing row stays missing (the code's default is the new address).
--
-- Rollback: revert the code; the table is inert to the previous release. To
-- undo the reply-to, set it back from the admin Config page.

CREATE TABLE IF NOT EXISTS support_requests (
  id serial PRIMARY KEY,
  email varchar(320) NOT NULL,
  category varchar(20) NOT NULL,
  message text NOT NULL,
  user_id varchar REFERENCES users(id) ON DELETE SET NULL,
  account_state varchar(20),
  inbox_delivery varchar(10) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Written in the form PostgreSQL prints back, so a dump and restore (production
  -- adoption, phase3.productionAdopt.test.ts) compares equal to a migrated database.
  CONSTRAINT support_requests_category_check CHECK (((category)::text = ANY (ARRAY[('account'::character varying)::text, ('billing'::character varying)::text, ('bug'::character varying)::text, ('content'::character varying)::text, ('other'::character varying)::text]))),
  CONSTRAINT support_requests_inbox_delivery_check CHECK (((inbox_delivery)::text = ANY (ARRAY[('queued'::character varying)::text, ('failed'::character varying)::text])))
);

CREATE INDEX IF NOT EXISTS idx_support_requests_created ON support_requests (created_at);
CREATE INDEX IF NOT EXISTS idx_support_requests_user ON support_requests (user_id);

DO $$
DECLARE moved integer;
BEGIN
  UPDATE admin_config SET value = 'support@overhype.me', updated_at = now()
   WHERE key = 'email_reply_to' AND value = 'overhypeme+support@gmail.com';
  GET DIAGNOSTICS moved = ROW_COUNT;
  RAISE NOTICE '0156 email_reply_to moved off the retired alias: % row(s)', moved;
END $$;
