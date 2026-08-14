-- Repair migration for the two membership ordering/fencing sequences.
--
-- Same failure shape as 0098, one object type over. 0095 created
-- "membership_source_state_seq" and "membership_lease_fence_seq", but neither
-- had a matching declaration in schema/membershipEntitlements.ts, so
-- `drizzle-kit push --force` — which reconciles against the TypeScript schema,
-- not the migration history — removed them from any database pushed more than
-- once. Silently, and after the tracker had already recorded 0095 as applied,
-- so re-running 0095 was a no-op that could never restore them. The
-- declarations now exist, which stops future drops and makes the next push
-- recreate a missing sequence.
--
-- Recreating is NOT sufficient on its own, which is why this migration exists.
-- A recreated sequence restarts at 1, and both consumers guard their writes on
-- a STRICTLY GREATER token:
--
--   * membership_entitlements.source_state_as_of — applySubscriptionSource and
--     markLifetimeRefunded both write `... WHERE source_state_as_of < token`
--   * membership_leases.fence — a fresh fence per acquisition, used to tell a
--     live lease holder from a revenant one
--
-- On a database still holding rows stamped with larger values, every such write
-- matches ZERO rows until the sequence climbs back past them: no error, no log,
-- the subscription refresh or refund simply does not happen and the caller is
-- told `applied: false`. A missing sequence fails LOUDLY (nextval raises); a
-- reset one fails SILENTLY, which is strictly worse.
--
-- WHY THIS ONLY EVER WRITES A SEQUENCE THAT IS GENUINELY BEHIND
-- ------------------------------------------------------------
-- An earlier version of this migration ran an unconditional
-- `setval(seq, GREATEST(max_stored, seq.last_value))`. That is unsafe against a
-- live database, and the failure is the exact corruption this migration exists
-- to prevent. Sequence reads and writes are not transactional and take no lock
-- the application shares, so a concurrent `nextval()` can land between the
-- `last_value` subquery and the `setval()`. The stale value then overwrites the
-- concurrently advanced one and the next caller is handed a token that was
-- already issued — duplicate tokens, and a fence that no longer separates a
-- live holder from a revenant. Reproduced before rewriting: a sequence
-- concurrently advanced 800 -> 850 was pushed back to 800, and the next
-- allocation returned 801, which had already been handed out.
--
-- So each block below decides FIRST whether the sequence is actually behind
-- what is already persisted, and writes ONLY then. On a healthy database —
-- which includes production, where these sequences were never dropped, since
-- `push --force` reaches only the test database via pretest's
-- TEST_DATABASE_URL redirect — this migration performs no sequence write at
-- all, so there is no read-then-write window to race. On a database that IS
-- behind, every consumer's write is already silently matching zero rows, so
-- advancing can only improve matters.
--
-- `highest_issued` accounts for is_called: a never-called sequence reports
-- last_value = 1 while having issued nothing, so treating last_value as
-- "already handed out" would skip a repair that is genuinely needed when the
-- stored maximum is exactly 1.
--
-- Idempotent, non-destructive, and safe to replay: it can only ever raise a
-- sequence, never lower one, never renumber a row, and never write table data.
-- Each block reports what it did, so a repair and a no-op are distinguishable
-- in the migration output rather than both appearing as a bare "Applying" line.
CREATE SEQUENCE IF NOT EXISTS "membership_source_state_seq" AS bigint START WITH 1 INCREMENT BY 1;
--> statement-breakpoint

CREATE SEQUENCE IF NOT EXISTS "membership_lease_fence_seq" AS bigint START WITH 1 INCREMENT BY 1;
--> statement-breakpoint

DO $$
DECLARE
  target         bigint;
  lv             bigint;
  called         boolean;
  highest_issued bigint;
BEGIN
  SELECT COALESCE(MAX("source_state_as_of"), 0) INTO target FROM "membership_entitlements";
  SELECT last_value, is_called INTO lv, called FROM "membership_source_state_seq";
  highest_issued := CASE WHEN called THEN lv ELSE lv - 1 END;

  IF highest_issued < target THEN
    PERFORM setval('membership_source_state_seq', target);
    RAISE NOTICE '0099: membership_source_state_seq REPAIRED — highest issued was %, advanced to % (max membership_entitlements.source_state_as_of); next token %',
      highest_issued, target, target + 1;
  ELSE
    RAISE NOTICE '0099: membership_source_state_seq OK — highest issued % >= max stored %; not written',
      highest_issued, target;
  END IF;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  target         bigint;
  lv             bigint;
  called         boolean;
  highest_issued bigint;
BEGIN
  SELECT COALESCE(MAX("fence"), 0) INTO target FROM "membership_leases";
  SELECT last_value, is_called INTO lv, called FROM "membership_lease_fence_seq";
  highest_issued := CASE WHEN called THEN lv ELSE lv - 1 END;

  IF highest_issued < target THEN
    PERFORM setval('membership_lease_fence_seq', target);
    RAISE NOTICE '0099: membership_lease_fence_seq REPAIRED — highest issued was %, advanced to % (max membership_leases.fence); next fence %',
      highest_issued, target, target + 1;
  ELSE
    RAISE NOTICE '0099: membership_lease_fence_seq OK — highest issued % >= max stored %; not written',
      highest_issued, target;
  END IF;
END $$;
