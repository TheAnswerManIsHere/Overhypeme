-- Entitlement model, part 1 of 2: ADDITIVE ONLY.
--
-- Creates the normalised entitlement source table, the dispute table, the lease
-- table, the two ordering sequences and the read-path expiry column, and seeds
-- every admin_config key the model introduces. It drops nothing — the legacy
-- `subscriptions` / `lifetime_entitlements` tables are dropped in
-- 0095_drop_legacy_membership_tables.sql, which runs in the same startup pass
-- once every writer has been moved onto this schema. Splitting the two keeps
-- each commit in the PR bootable; the deploy still applies both back-to-back
-- before the port binds (runMigrations() in the api-server entry).
--
-- Membership is DERIVED from these rows, never assigned per-event. Three
-- invariants are enforced here rather than in application code, because this
-- plan's most persistent failure mode was a control named in one place and
-- wired up in none:
--
--   1. Identity is frozen. user_id, source_type, provider_ref and created_at
--      cannot change after creation — not via the refresh helper, not via a
--      repair script, not via direct SQL. A UNIQUE constraint cannot express
--      this: it happily accepts an UPDATE to any unused provider reference.
--   2. dispute_loss_revoked_at is set-once. A lost chargeback disqualifies the
--      source permanently and no provider refresh may clear it.
--   3. entitlement_source_disputes.is_terminal is absorbing. A CHECK cannot
--      express this either — it validates only the row being proposed, and
--      ('needs_response', false) is a perfectly consistent new row. Verified by
--      execution on PostgreSQL 16.13: updating ('won', true) to
--      ('needs_response', false) succeeds under such a constraint.
--
-- Every statement is guarded so the whole file is a clean no-op on a second run.

-- ---------------------------------------------------------------------------
-- 1. Read-path expiry horizon on users.
-- ---------------------------------------------------------------------------
-- Nullable: null means "no expiry" — either a qualifying source is indefinitely
-- valid, or the tier is already non-qualifying. Grace expiry has no Stripe
-- event, so this column is how the 14-day bound is enforced at all; the
-- convergence sweep only makes the stored tier agree with it.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "membership_valid_until" timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Ordering and fencing sequences.
-- ---------------------------------------------------------------------------
-- Deliberately sequences, not clock_timestamp(): two concurrent calls can return
-- the SAME timestamp, and under a strictly-newer guard that rejects a genuinely
-- newer snapshot and never converges. The guard needs strict uniqueness as well
-- as monotonicity.
CREATE SEQUENCE IF NOT EXISTS "membership_source_state_seq" AS bigint START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS "membership_lease_fence_seq"  AS bigint START WITH 1 INCREMENT BY 1;

-- ---------------------------------------------------------------------------
-- 3. membership_entitlements — one row per durable entitlement source.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "membership_entitlements" (
  "id"                        integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "user_id"                   varchar NOT NULL,
  "source_type"               varchar(32) NOT NULL,
  "provider_ref"              varchar,
  "is_membership_product"     boolean,
  "lifecycle_status"          varchar(32) NOT NULL,
  "plan"                      varchar,
  "current_period_end"        timestamptz,
  "cancel_at_period_end"      boolean,
  "amount"                    integer,
  "currency"                  varchar,
  "grace_started_at"          timestamptz,
  "grace_expires_at"          timestamptz,
  "dispute_loss_revoked_at"   timestamptz,
  "granted_by_admin_id"       varchar,
  "granted_by_admin_label"    text,
  "grant_reason"              text,
  "revoked_by_admin_id"       varchar,
  "revoked_by_admin_label"    text,
  "revoked_reason"            text,
  "revoked_at"                timestamptz,
  "source_state_as_of"        bigint NOT NULL,
  "created_at"                timestamptz NOT NULL DEFAULT now(),
  "updated_at"                timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  -- ON DELETE CASCADE: the admin purge deletes users, and entitlements go with them.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_entitlements_user_id_users_id_fk') THEN
    ALTER TABLE "membership_entitlements"
      ADD CONSTRAINT "membership_entitlements_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;

  -- Actor ids are ON DELETE SET NULL. Every other FK behaviour is wrong here:
  -- CASCADE would delete a RECIPIENT's entitlement because the granting admin
  -- left, and RESTRICT would block admin account deletion outright. Provenance
  -- survives in the _label snapshot, which the CHECK below requires instead.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_entitlements_granted_by_admin_id_users_id_fk') THEN
    ALTER TABLE "membership_entitlements"
      ADD CONSTRAINT "membership_entitlements_granted_by_admin_id_users_id_fk"
      FOREIGN KEY ("granted_by_admin_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_entitlements_revoked_by_admin_id_users_id_fk') THEN
    ALTER TABLE "membership_entitlements"
      ADD CONSTRAINT "membership_entitlements_revoked_by_admin_id_users_id_fk"
      FOREIGN KEY ("revoked_by_admin_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_entitlements_source_type_valid') THEN
    ALTER TABLE "membership_entitlements"
      ADD CONSTRAINT "membership_entitlements_source_type_valid"
      CHECK (source_type IN ('stripe_subscription', 'stripe_lifetime_payment', 'admin_grant'));
  END IF;

  -- Payment-backed rows carry a provider reference; admin grants never do.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_entitlements_provider_ref_shape') THEN
    ALTER TABLE "membership_entitlements"
      ADD CONSTRAINT "membership_entitlements_provider_ref_shape"
      CHECK ((source_type = 'admin_grant' AND provider_ref IS NULL)
          OR (source_type <> 'admin_grant' AND provider_ref IS NOT NULL));
  END IF;

  -- No fail-open default: the allowlist answer is always written explicitly for
  -- both Stripe source types. Admin grants qualify through W1b, not a product.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_entitlements_allowlist_shape') THEN
    ALTER TABLE "membership_entitlements"
      ADD CONSTRAINT "membership_entitlements_allowlist_shape"
      CHECK ((source_type = 'admin_grant' AND is_membership_product IS NULL)
          OR (source_type <> 'admin_grant' AND is_membership_product IS NOT NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_entitlements_lifecycle_status_valid') THEN
    ALTER TABLE "membership_entitlements"
      ADD CONSTRAINT "membership_entitlements_lifecycle_status_valid"
      CHECK ((source_type = 'stripe_subscription' AND lifecycle_status IN
                ('active','trialing','past_due','unpaid','canceled','incomplete','incomplete_expired','paused'))
          OR (source_type = 'stripe_lifetime_payment' AND lifecycle_status IN ('active','refunded'))
          OR (source_type = 'admin_grant' AND lifecycle_status IN ('active','revoked')));
  END IF;

  -- W1b grant clause. The LABEL is required, not the id — purging the granting
  -- admin nulls a convenience join and leaves the attribution intact.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_entitlements_grant_provenance') THEN
    ALTER TABLE "membership_entitlements"
      ADD CONSTRAINT "membership_entitlements_grant_provenance"
      CHECK (source_type <> 'admin_grant'
          OR (granted_by_admin_label IS NOT NULL AND grant_reason IS NOT NULL));
  END IF;

  -- W1b revocation clause. Without this a row could reach 'revoked' with null
  -- provenance — satisfying the letter of the grant clause while defeating this one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_entitlements_revoke_provenance') THEN
    ALTER TABLE "membership_entitlements"
      ADD CONSTRAINT "membership_entitlements_revoke_provenance"
      CHECK (NOT (source_type = 'admin_grant' AND lifecycle_status = 'revoked')
          OR (revoked_by_admin_label IS NOT NULL AND revoked_reason IS NOT NULL
              AND revoked_at IS NOT NULL));
  END IF;

  -- Subscription-only columns stay null elsewhere, so no reader can find a
  -- plausible-looking lifecycle value on a source that never had one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_entitlements_subscription_only_columns') THEN
    ALTER TABLE "membership_entitlements"
      ADD CONSTRAINT "membership_entitlements_subscription_only_columns"
      CHECK (source_type = 'stripe_subscription'
          OR (plan IS NULL AND current_period_end IS NULL AND cancel_at_period_end IS NULL
              AND grace_started_at IS NULL AND grace_expires_at IS NULL));
  END IF;

  -- amount/currency are payment-backed only. Deliberately inapplicable for
  -- subscriptions: a Stripe Subscription carries items[] with per-item price and
  -- quantity, not one self-evident scalar, so two writers inventing an
  -- aggregation independently would drift.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_entitlements_amount_shape') THEN
    ALTER TABLE "membership_entitlements"
      ADD CONSTRAINT "membership_entitlements_amount_shape"
      CHECK (source_type = 'stripe_lifetime_payment' OR (amount IS NULL AND currency IS NULL));
  END IF;

  -- The grace window is an episode: both ends are set together or neither is.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_entitlements_grace_window_paired') THEN
    ALTER TABLE "membership_entitlements"
      ADD CONSTRAINT "membership_entitlements_grace_window_paired"
      CHECK ((grace_started_at IS NULL AND grace_expires_at IS NULL)
          OR (grace_started_at IS NOT NULL AND grace_expires_at IS NOT NULL));
  END IF;

  -- W1b provenance belongs to admin grants and nowhere else. Same principle as
  -- the subscription-only columns: no reader may find a plausible-looking actor
  -- or reason on a source that never had one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_entitlements_grant_provenance_scope') THEN
    ALTER TABLE "membership_entitlements"
      ADD CONSTRAINT "membership_entitlements_grant_provenance_scope"
      CHECK (source_type = 'admin_grant'
          OR (granted_by_admin_id IS NULL AND granted_by_admin_label IS NULL
              AND grant_reason IS NULL));
  END IF;

  -- Revocation provenance appears only on a row that is actually revoked. A
  -- re-grant after a revoke is a NEW row (the partial unique index constrains
  -- only active rows), so an active grant never legitimately carries a stale
  -- revocation timestamp — and one that did would misreport when access ended.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_entitlements_revoke_provenance_scope') THEN
    ALTER TABLE "membership_entitlements"
      ADD CONSTRAINT "membership_entitlements_revoke_provenance_scope"
      CHECK ((source_type = 'admin_grant' AND lifecycle_status = 'revoked')
          OR (revoked_by_admin_id IS NULL AND revoked_by_admin_label IS NULL
              AND revoked_reason IS NULL AND revoked_at IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_membership_entitlements_user_id"
  ON "membership_entitlements" ("user_id");

-- Preserves the idempotency the two legacy unique constraints gave
-- (stripe_subscription_id, stripe_payment_intent_id) in one partial index.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_membership_entitlements_provider_ref"
  ON "membership_entitlements" ("source_type", "provider_ref")
  WHERE "provider_ref" IS NOT NULL;

-- At most one ACTIVE admin grant per user. The constraint above excludes admin
-- grants entirely (their provider_ref is null), so without this nothing stopped
-- two concurrent submissions — or a retry after an uncertain response — from
-- creating two active grants, after which a revoke marks one and leaves the
-- other qualifying. Re-granting after a revoke stays permitted: only active rows
-- are constrained.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_membership_entitlements_active_admin_grant"
  ON "membership_entitlements" ("user_id")
  WHERE "source_type" = 'admin_grant' AND "lifecycle_status" = 'active';

-- ---------------------------------------------------------------------------
-- 4. Frozen identity, set-once dispute revocation, and updated_at maintenance.
-- ---------------------------------------------------------------------------
-- The first two are predicates over a PAIR of rows (old, new), which is exactly
-- what a CHECK constraint cannot see. Omitting the columns from the refresh
-- helper protects nothing against a repair script, a migration backfill, or a
-- writer nobody enumerated — which, on this model's record, is the case to
-- design for.
--
-- updated_at is classified "operational, maintained — every writer advances it,
-- BY PROTOCOL". A protocol no mechanism enforces is the exact shape of failure
-- this model exists to remove, so the trigger advances it unconditionally
-- instead. It rides along here rather than in a second trigger: one BEFORE
-- UPDATE pass, one place to read.
CREATE OR REPLACE FUNCTION "membership_entitlements_guard_immutable"()
RETURNS trigger AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'membership_entitlements identity is frozen (id=%): user_id, source_type, provider_ref and created_at cannot be reassigned',
      OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF OLD.dispute_loss_revoked_at IS NOT NULL
     AND NEW.dispute_loss_revoked_at IS DISTINCT FROM OLD.dispute_loss_revoked_at THEN
    RAISE EXCEPTION
      'membership_entitlements.dispute_loss_revoked_at is set-once (id=%): a lost chargeback revocation cannot be cleared or moved',
      OLD.id
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_membership_entitlements_guard_immutable" ON "membership_entitlements";
CREATE TRIGGER "trg_membership_entitlements_guard_immutable"
  BEFORE UPDATE ON "membership_entitlements"
  FOR EACH ROW EXECUTE FUNCTION "membership_entitlements_guard_immutable"();

-- ---------------------------------------------------------------------------
-- 5. entitlement_source_disputes — one row per dispute, ever.
-- ---------------------------------------------------------------------------
-- stripe_dispute_id is the primary key, which is what makes a late
-- charge.dispute.created an upsert rather than a re-open. A source is HELD while
-- a row exists for it with a non-terminal status: the hold is this query and
-- nothing else. There is deliberately no hold column and no reason column —
-- two answers to "is this source held" is one more than a derived model may have.
CREATE TABLE IF NOT EXISTS "entitlement_source_disputes" (
  "stripe_dispute_id" varchar PRIMARY KEY,
  "source_id"         integer NOT NULL,
  "status"            varchar(32) NOT NULL,
  "is_terminal"       boolean NOT NULL,
  "first_seen_at"     timestamptz NOT NULL DEFAULT now(),
  "resolved_at"       timestamptz
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entitlement_source_disputes_source_id_fk') THEN
    ALTER TABLE "entitlement_source_disputes"
      ADD CONSTRAINT "entitlement_source_disputes_source_id_fk"
      FOREIGN KEY ("source_id") REFERENCES "membership_entitlements"("id") ON DELETE CASCADE;
  END IF;

  -- Constrains status to the eight the pinned SDK defines. Without this an
  -- unrecognised status classifies as non-terminal, agrees with
  -- is_terminal = false, passes, and then holds the source INDEFINITELY because
  -- no transition knows how to resolve it. The TypeScript union does not prevent
  -- it — handlers cast event status from runtime data.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entitlement_source_disputes_status_valid') THEN
    ALTER TABLE "entitlement_source_disputes"
      ADD CONSTRAINT "entitlement_source_disputes_status_valid"
      CHECK (status IN ('warning_needs_response','warning_under_review','warning_closed',
                        'needs_response','under_review','won','lost','prevented'));
  END IF;

  -- Consistency, not transition: is_terminal agrees with status on the proposed
  -- row. Absorption is the trigger's job, below.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entitlement_source_disputes_terminal_consistent') THEN
    ALTER TABLE "entitlement_source_disputes"
      ADD CONSTRAINT "entitlement_source_disputes_terminal_consistent"
      CHECK (is_terminal = (status IN ('won','lost','warning_closed','prevented')));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_entitlement_source_disputes_source_id"
  ON "entitlement_source_disputes" ("source_id");

-- Makes "is this source held" a cheap existence check on the qualification path.
CREATE INDEX IF NOT EXISTS "idx_entitlement_source_disputes_open"
  ON "entitlement_source_disputes" ("source_id")
  WHERE NOT "is_terminal";

-- The backstop for a writer that did not use the conditional upsert. Three of
-- the four terminal shapes are access-RESTORING and one is access-REVOKING, so
-- a terminal row reverting to non-terminal is wrong in both directions at once.
CREATE OR REPLACE FUNCTION "entitlement_source_disputes_guard_absorbing"()
RETURNS trigger AS $$
BEGIN
  IF OLD.is_terminal AND NOT NEW.is_terminal THEN
    RAISE EXCEPTION
      'entitlement_source_disputes.is_terminal is absorbing (dispute=%): % cannot revert to %',
      OLD.stripe_dispute_id, OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_entitlement_source_disputes_guard_absorbing" ON "entitlement_source_disputes";
CREATE TRIGGER "trg_entitlement_source_disputes_guard_absorbing"
  BEFORE UPDATE ON "entitlement_source_disputes"
  FOR EACH ROW EXECUTE FUNCTION "entitlement_source_disputes_guard_absorbing"();

-- ---------------------------------------------------------------------------
-- 6. membership_leases.
-- ---------------------------------------------------------------------------
-- Two users of one table: per-source leases ('source:<type>:<provider_ref>')
-- held across a Stripe retrieval so exactly one retrieval-and-apply is in flight
-- per source, and the reconciliation run lease ('reconcile:run'), which is
-- HEARTBEATED rather than given a long TTL — a staging run has no bounded
-- duration, so expiry has to mean "the holder stopped", not "the holder is slow".
--
-- The lease is a committed row, claimed in a short transaction, so the retrieval
-- itself runs with NO transaction open: it pins no connection and blocks no
-- unrelated query. That is what makes it admissible where a FOR UPDATE row lock
-- held across network I/O is not.
CREATE TABLE IF NOT EXISTS "membership_leases" (
  "scope"       varchar(200) PRIMARY KEY,
  "holder"      varchar(200) NOT NULL,
  "fence"       bigint NOT NULL,
  "acquired_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at"  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_membership_leases_expires_at"
  ON "membership_leases" ("expires_at");

-- ---------------------------------------------------------------------------
-- 7. admin_config seeds.
-- ---------------------------------------------------------------------------
-- Naming a config key does not create it: getAllConfig returns only STORED rows
-- and PATCH /admin/config/:key 404s when the row is absent, so a key that exists
-- only as a code fallback is invisible in the admin list and un-editable without
-- a deploy. Every key this model introduces is seeded here.
--
-- ON CONFLICT DO NOTHING, so re-running never overwrites a value an operator has
-- since tuned.
--
-- data_type must be 'integer' or 'float': PATCH validates min/max ONLY for those
-- two discriminators. A row seeded as 'numeric' would match neither branch and
-- take no range check at all.
--
-- Relational invariants that a single row's min/max cannot express — the lease
-- budget inequality, allowance <= max_downgrades, and the fraction's strict
-- lower bound — are enforced by the config validator on write. The min_value
-- figures below are the coarse per-key floor, not the whole rule.
INSERT INTO admin_config (key, value, data_type, label, description, min_value, max_value, is_public) VALUES
  ('grace_sweep_interval_seconds', '3600', 'integer',
   'Membership grace sweep interval (s)',
   'How often the convergence sweep recomputes users whose grace window has expired. Lateness here is cosmetic — the read path already enforces the deadline — so this is cheaper than reconciliation and runs more often.',
   1, 86400, false),

  ('grace_sweep_alert_after_seconds', '21600', 'integer',
   'Membership grace sweep alert after (s)',
   'How long the grace sweep may keep failing before an alert fires. The sweep dying does not revoke anyone late; what degrades is the accuracy of the stored tier, which this surfaces.',
   1, 604800, false),

  ('reconcile_interval_seconds', '21600', 'integer',
   'Membership reconciliation interval (s)',
   'How often reconciliation compares local entitlement sources against authoritative Stripe state. This is the repair path for a permanently dropped webhook, so lateness here is a correctness window, not a cosmetic one. More expensive than the grace sweep because it enumerates Stripe.',
   1, 604800, false),

  ('lease_ttl_seconds', '60', 'integer',
   'Entitlement source lease TTL (s)',
   'How long one retrieval-and-apply may hold a per-source lease. Must exceed the whole bounded budget: Stripe retrieval (timeout x attempts + retry sleep) plus the apply transaction (lock timeout x attempts + backoff), times a 1.5 margin for scheduling jitter. Too short and a valid holder expires mid-work and its fenced write aborts; too long and a crashed holder wedges that source until expiry.',
   48, 600, false),

  ('lease_waiter_timeout_seconds', '5', 'integer',
   'Entitlement lease waiter timeout (s)',
   'How long a writer waits for a busy source lease before giving up. A waiter that times out abandons its write rather than proceeding unordered — reconciliation repairs it — so this trades latency for nothing and may be short.',
   1, 60, false),

  ('reconcile_run_lease_ttl_seconds', '120', 'integer',
   'Reconciliation run lease TTL (s)',
   'Expiry of the whole-run lease, which the holder renews on every heartbeat. Must stay at least three heartbeat intervals: one to send the beat, one to tolerate a missed beat, one for scheduling jitter. Below that the lease expires before its first renewal and every run is taken over.',
   90, 3600, false),

  ('reconcile_heartbeat_interval_seconds', '30', 'integer',
   'Reconciliation heartbeat interval (s)',
   'How often a running reconciliation renews its run lease. This is what makes lease expiry mean "the holder stopped" rather than "the holder is slow" — a staging run has no bounded duration, so no fixed TTL alone can tell those apart.',
   5, 600, false),

  ('reconcile_max_downgrades_per_run', '50', 'integer',
   'Reconciliation: max downgrades per run',
   'Absolute cap on how many users may lose their effective tier in one reconciliation run. Combined with the fraction and the minimum allowance: allowed = min(this, max(min_allowance, floor(fraction x qualifying_population))). A run staging more than that aborts having written nothing and reports the full staged change set.',
   1, 100000, false),

  ('reconcile_max_downgrade_fraction', '0.05', 'float',
   'Reconciliation: max downgrade fraction',
   'The same cap as a proportion of the CURRENTLY QUALIFYING population — not of users examined. Measured against users examined, a run over 10,000 users of whom 40 are members could revoke all forty and still read as 0.4%. Must be greater than 0 and at most 1.',
   0, 1, false),

  ('reconcile_min_downgrade_allowance', '3', 'integer',
   'Reconciliation: minimum downgrade allowance',
   'The floor that keeps an isolated repair possible at every population size, including one. Without it a small membership makes the fraction round to zero and no legitimate single downgrade can ever proceed. Must be at least 1 and at most the absolute per-run cap.',
   1, 100000, false),

  ('reconcile_max_ambiguous_per_run', '25', 'integer',
   'Reconciliation: max ambiguous sources per run',
   'How many sources a run may fail to classify before aborting. A run that cannot make sense of this many sources is reporting a systemic problem, not a handful of edge cases.',
   0, 100000, false),

  ('reconcile_max_errors_per_run', '10', 'integer',
   'Reconciliation: max errors per run',
   'How many Stripe retrieval or pagination failures a run tolerates before aborting. Failing closed here means not revoking, which is the safe direction.',
   0, 100000, false)
ON CONFLICT (key) DO NOTHING;
