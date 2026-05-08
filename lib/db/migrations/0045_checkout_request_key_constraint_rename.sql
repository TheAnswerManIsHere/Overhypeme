-- Rename the PostgreSQL-auto-named unique constraint on
-- stripe_checkout_request_ledger.request_key to Drizzle's naming convention.
--
-- When migration 0032 created this table with an inline UNIQUE clause,
-- PostgreSQL automatically named the constraint
-- "stripe_checkout_request_ledger_request_key_key" (its own convention).
-- Drizzle-kit expects "stripe_checkout_request_ledger_request_key_unique"
-- (Drizzle's convention: table_column_unique).
--
-- This mismatch caused drizzle-kit to report schema drift on every Replit
-- publish, triggering the "database changes detected" warning even when no
-- real schema changes had been made.
--
-- Both statements are wrapped in DO blocks so the migration is fully
-- idempotent regardless of which constraint name is currently present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name     = 'stripe_checkout_request_ledger'
      AND constraint_name = 'stripe_checkout_request_ledger_request_key_key'
      AND constraint_type = 'UNIQUE'
  ) THEN
    ALTER TABLE "stripe_checkout_request_ledger"
      DROP CONSTRAINT "stripe_checkout_request_ledger_request_key_key";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name     = 'stripe_checkout_request_ledger'
      AND constraint_name = 'stripe_checkout_request_ledger_request_key_unique'
      AND constraint_type = 'UNIQUE'
  ) THEN
    ALTER TABLE "stripe_checkout_request_ledger"
      ADD CONSTRAINT "stripe_checkout_request_ledger_request_key_unique"
      UNIQUE ("request_key");
  END IF;
END $$;
