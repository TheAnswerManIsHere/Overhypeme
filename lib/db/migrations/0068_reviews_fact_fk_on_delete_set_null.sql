-- Fix: pending_reviews FKs to facts had no onDelete policy (defaulted to NO ACTION),
-- causing hard-deletes of facts to fail with a FK constraint violation (500).
-- Both columns are nullable pointers that should simply become NULL when the fact is deleted.

ALTER TABLE "pending_reviews"
  DROP CONSTRAINT IF EXISTS "pending_reviews_matching_fact_id_facts_id_fk";

ALTER TABLE "pending_reviews"
  DROP CONSTRAINT IF EXISTS "pending_reviews_approved_fact_id_facts_id_fk";

ALTER TABLE "pending_reviews"
  ADD CONSTRAINT "pending_reviews_matching_fact_id_facts_id_fk"
    FOREIGN KEY ("matching_fact_id") REFERENCES "public"."facts"("id") ON DELETE SET NULL;

ALTER TABLE "pending_reviews"
  ADD CONSTRAINT "pending_reviews_approved_fact_id_facts_id_fk"
    FOREIGN KEY ("approved_fact_id") REFERENCES "public"."facts"("id") ON DELETE SET NULL;
