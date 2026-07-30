-- 0096 — Reconciliation run records, and an honest lease budget.
--
-- Two changes, both closing gaps found reviewing the entitlement model (PR #287).
--
-- 1. `membership_reconciliation_runs` — reconciliation mutates entitlements
--    unattended, and until now its only trace was a log line whose per-source
--    detail had already been collapsed to a count. An operator could see that a
--    run aborted but not WHICH users it would have touched, which is exactly the
--    question an aborted downgrade guard raises. This records both altitudes:
--    the aggregate row-state matrix, and the per-item staged change set.
--
-- 2. `lease_ttl_seconds` re-seeded. Its floor was derived from ONE bounded
--    Stripe request (22s -> 48s), but a prepare holds its lease across a whole
--    sequence of them — the subscription, its paginated items, a product lookup
--    per item, and for a past_due refresh three more lists. The budget is now
--    the retrieval PHASE (45s, enforced by a deadline rather than assumed),
--    which moves the derived floor to 83s.

BEGIN;

-- ─── 1. Reconciliation run records ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS membership_reconciliation_runs (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,

  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  mode varchar(16) NOT NULL,

  -- The row-state matrix, per the repo's migration practice. Silent bulk
  -- mutation is a bug; so is a bound that truncates without saying so.
  examined integer NOT NULL DEFAULT 0,
  unchanged integer NOT NULL DEFAULT 0,
  upgraded integer NOT NULL DEFAULT 0,
  downgraded integer NOT NULL DEFAULT 0,
  ambiguous integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,

  -- The denominator the fractional downgrade bound was measured against, and
  -- the allowance it produced. Stored because both are computed from live state
  -- at run time and cannot be reconstructed afterwards.
  cohort integer NOT NULL DEFAULT 0,
  allowed_downgrades integer NOT NULL DEFAULT 0,

  aborted boolean NOT NULL DEFAULT false,
  abort_reason text,

  -- The per-item altitude: one entry per staged source, carrying the user, the
  -- provider ref, and the user's before/after tier. This is what makes an
  -- aborted guard diagnosable rather than merely visible.
  staged jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- How many there actually were, and whether `staged` is only a prefix of
  -- them. A cap that did not say it had truncated would read as "this is the
  -- whole change set" — the same silent-bound failure the report itself exists
  -- to avoid.
  staged_total integer NOT NULL DEFAULT 0,
  staged_truncated boolean NOT NULL DEFAULT false,

  CONSTRAINT membership_reconciliation_runs_mode_valid
    CHECK (mode IN ('dry-run', 'apply')),
  -- A truncated set that is not smaller than the total is a contradiction, and
  -- an untruncated one must account for every staged item.
  CONSTRAINT membership_reconciliation_runs_staged_total_consistent
    CHECK (staged_total >= jsonb_array_length(staged))
);

-- The read this table exists for is "the last N runs, newest first".
CREATE INDEX IF NOT EXISTS idx_membership_reconciliation_runs_started_at
  ON membership_reconciliation_runs (started_at DESC);

-- ─── 2. Re-seed the lease TTL against the phase budget ──────────────────────

-- The floor rises unconditionally: it is derived from constants, and leaving it
-- at 48 would keep the supported admin UI accepting a lease shorter than the
-- retrieval it must outlive.
UPDATE admin_config
SET min_value = 83,
    description =
      'How long one retrieval-and-apply may hold a per-source lease. Must exceed the whole bounded budget: the Stripe retrieval PHASE (every request a prepare makes under one lease — the subscription, its paginated items, a product per item, and for a past_due refresh the invoice/payment/charge lists behind the grace anchor) plus the apply transaction (lock timeout x attempts + backoff), times a 1.5 margin for scheduling jitter. Too short and a valid holder expires mid-work and its fenced write aborts; too long and a crashed holder wedges that source until expiry.',
    updated_at = now()
WHERE key = 'lease_ttl_seconds';

-- The VALUE only moves where it is now unsafe. An operator who deliberately set
-- something above the new floor keeps it; one sitting on the old 60s default —
-- or any other sub-floor value — is raised to a value that actually covers the
-- work, because leaving it would mean every past_due refresh under a slow
-- Stripe silently loses its fenced write.
UPDATE admin_config
SET value = '90',
    updated_at = now()
WHERE key = 'lease_ttl_seconds'
  AND (value ~ '^[0-9]+$')
  AND value::integer < 83;

-- The waiter must stay strictly under the lease. Raising the lease cannot break
-- that (5 < 90), so this is a no-op today and a guard against a future re-seed
-- that reorders these two.
UPDATE admin_config
SET value = '5', updated_at = now()
WHERE key = 'lease_waiter_timeout_seconds'
  AND (value ~ '^[0-9]+$')
  AND value::integer >= 90;

COMMIT;
