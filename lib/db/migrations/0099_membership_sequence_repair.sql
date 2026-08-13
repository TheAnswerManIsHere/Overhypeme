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
-- reset one fails SILENTLY, which is strictly worse. So the sequences have to be
-- advanced past what is already persisted, not merely restored.
--
-- Idempotent, and a no-op on a healthy database: each setval takes the GREATEST
-- of the stored maximum and the sequence's own current value, so it can only
-- ever raise a sequence — never lower one, never renumber an existing row, and
-- never touch table data. Safe to replay; nothing here is destructive, so no
-- rollback step is required.
CREATE SEQUENCE IF NOT EXISTS "membership_source_state_seq" AS bigint START WITH 1 INCREMENT BY 1;
--> statement-breakpoint

CREATE SEQUENCE IF NOT EXISTS "membership_lease_fence_seq" AS bigint START WITH 1 INCREMENT BY 1;
--> statement-breakpoint

-- COALESCE(..., 0) covers an empty table; the sequence's own last_value keeps a
-- healthy database untouched. On a never-called sequence last_value is 1, so a
-- fresh install consumes token 1 here and starts allocating at 2 — harmless,
-- since these tokens carry no meaning beyond being unique and increasing.
SELECT setval(
  'membership_source_state_seq',
  GREATEST(
    (SELECT COALESCE(MAX("source_state_as_of"), 0) FROM "membership_entitlements"),
    (SELECT last_value FROM "membership_source_state_seq")
  )
);
--> statement-breakpoint

SELECT setval(
  'membership_lease_fence_seq',
  GREATEST(
    (SELECT COALESCE(MAX("fence"), 0) FROM "membership_leases"),
    (SELECT last_value FROM "membership_lease_fence_seq")
  )
);
