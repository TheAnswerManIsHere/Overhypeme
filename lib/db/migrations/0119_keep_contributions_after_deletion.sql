-- Launch Phase 5, increment 5b (plan docs/plans/PLAN_PHASE5_ACCOUNT_IDENTITY.md,
-- "Account deletion"; David's answers of 2026-11-02 to "what should account
-- deletion keep"): when a member deletes their own account, the votes and
-- hearts they cast stay in every total without their name, and their comments
-- and the submissions still awaiting review stay, credited to a former member.
-- An admin's removal still deletes both (the likely-abuse case).
--
-- 1. reactions.user_id becomes nullable: a null is a vote or heart whose
--    member has left. ON DELETE CASCADE stays, so a user row deleted any other
--    way still takes its reactions; the account purge clears the column first.
-- 2. comments.author_deleted_at: set when the author left, so a comment with
--    no author reads "a former member" rather than "anonymous" (the facts
--    table has had submitter_deleted_at since 0117).
-- 3. pending_reviews.submitter_deleted_at: set when the submitter left, and
--    carried onto the fact a later approval creates, so a kept submission
--    stays credited to a former member instead of reading like an import
--    (an import's submission has no submitter either).
--
-- Row states: every existing row keeps its values (no row is rewritten); a
-- reaction's user_id is null only after a purge; author_deleted_at is null on
-- every existing comment, and submitter_deleted_at on every existing
-- submission. Idempotent: DROP NOT NULL on a nullable column is a
-- no-op, and ADD COLUMN IF NOT EXISTS.

ALTER TABLE "reactions" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "comments" ADD COLUMN IF NOT EXISTS "author_deleted_at" timestamp with time zone;
ALTER TABLE "pending_reviews" ADD COLUMN IF NOT EXISTS "submitter_deleted_at" timestamp with time zone;
