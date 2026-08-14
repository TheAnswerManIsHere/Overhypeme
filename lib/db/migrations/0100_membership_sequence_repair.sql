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
-- WHY THIS ADVANCES THROUGH nextval() AND NEVER setval()
-- -----------------------------------------------------
-- Two earlier versions of this migration used setval(), and both were unsafe
-- against a live database in the same way: sequence reads and writes are not
-- transactional and take no lock the application shares, so a concurrent
-- nextval() can land between reading the current value and writing the new one.
-- The stale value then overwrites the concurrently advanced one and the next
-- caller is handed a token that was already issued — duplicate tokens, and a
-- fence that no longer separates a live holder from a revenant. Exactly the
-- corruption this migration exists to prevent. Reproduced: a sequence
-- concurrently advanced 800 -> 850 was pushed back to 800, and the next
-- allocation returned 801, already handed out.
--
-- Gating the setval on "only if behind" narrowed that window but did not close
-- it: on a DAMAGED database still serving traffic, concurrent allocators can
-- cross `target` between the read and the write, and tokens above `target`
-- succeed against the guards — so those writes are real, and re-issuing their
-- tokens is real corruption.
--
-- nextval() has no such window. It only ever advances, atomically, so this loop
-- cannot lower a sequence no matter how it interleaves; concurrent allocation
-- simply reaches the target sooner and shortens the loop. The cost objection to
-- looping turned out to be unfounded — 100,000 iterations measured at 0.22s, and
-- the gap is bounded by the number of membership writes ever made.
--
-- pg_sequence_last_value() returns NULL for a never-called sequence, which is
-- precisely "nothing issued yet". Reading last_value directly would report 1 in
-- that state and skip a repair that is genuinely needed when the stored maximum
-- is exactly 1.
--
-- On a HEALTHY database the loop condition is false immediately, so no sequence
-- is written at all — this migration is a pure no-op there, which includes
-- production, where these sequences were never dropped (push --force reaches
-- only the test database via pretest's TEST_DATABASE_URL redirect).
--
-- Idempotent, non-destructive, safe to replay, and it never renumbers a row or
-- writes table data. Each block reports whether it repaired or left the sequence
-- alone, so the two outcomes are distinguishable in the migration output rather
-- than both appearing as a bare "Applying" line.
CREATE SEQUENCE IF NOT EXISTS "membership_source_state_seq" AS bigint START WITH 1 INCREMENT BY 1;
--> statement-breakpoint

CREATE SEQUENCE IF NOT EXISTS "membership_lease_fence_seq" AS bigint START WITH 1 INCREMENT BY 1;
--> statement-breakpoint

DO $$
DECLARE
  target     bigint;
  before_val bigint;
  after_val  bigint;
  steps      bigint := 0;
BEGIN
  SELECT COALESCE(MAX("source_state_as_of"), 0) INTO target FROM "membership_entitlements";
  before_val := COALESCE(pg_sequence_last_value('membership_source_state_seq'::regclass), 0);

  WHILE COALESCE(pg_sequence_last_value('membership_source_state_seq'::regclass), 0) < target LOOP
    PERFORM nextval('membership_source_state_seq');
    steps := steps + 1;
  END LOOP;

  after_val := COALESCE(pg_sequence_last_value('membership_source_state_seq'::regclass), 0);

  IF steps > 0 THEN
    RAISE NOTICE '0100: membership_source_state_seq REPAIRED — was %, consumed % allocation(s) to reach % (max membership_entitlements.source_state_as_of = %); next token %',
      before_val, steps, after_val, target, after_val + 1;
  ELSE
    RAISE NOTICE '0100: membership_source_state_seq OK — highest issued % >= max stored %; not written',
      before_val, target;
  END IF;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  target     bigint;
  before_val bigint;
  after_val  bigint;
  steps      bigint := 0;
BEGIN
  SELECT COALESCE(MAX("fence"), 0) INTO target FROM "membership_leases";
  before_val := COALESCE(pg_sequence_last_value('membership_lease_fence_seq'::regclass), 0);

  WHILE COALESCE(pg_sequence_last_value('membership_lease_fence_seq'::regclass), 0) < target LOOP
    PERFORM nextval('membership_lease_fence_seq');
    steps := steps + 1;
  END LOOP;

  after_val := COALESCE(pg_sequence_last_value('membership_lease_fence_seq'::regclass), 0);

  IF steps > 0 THEN
    RAISE NOTICE '0100: membership_lease_fence_seq REPAIRED — was %, consumed % allocation(s) to reach % (max membership_leases.fence = %); next fence %',
      before_val, steps, after_val, target, after_val + 1;
  ELSE
    RAISE NOTICE '0100: membership_lease_fence_seq OK — highest issued % >= max stored %; not written',
      before_val, target;
  END IF;
END $$;
