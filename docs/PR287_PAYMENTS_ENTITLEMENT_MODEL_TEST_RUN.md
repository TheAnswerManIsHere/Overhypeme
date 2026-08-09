# PR #287 — Entitlement model — Replit test run

Checklist for Replit (the technical safety net), run post-merge against the
live workspace. **Replit owns the DB connection** — no `DATABASE_URL` /
test-DB env is set anywhere in this doc. Companion in-app acceptance test:
[`PR287_PAYMENTS_ENTITLEMENT_MODEL_UAT.md`](PR287_PAYMENTS_ENTITLEMENT_MODEL_UAT.md).

**This is the highest-risk migration this repo has shipped.** It creates three
tables and **drops two**, and a startup-order mistake here does not degrade the
site — it stops the process from binding its port. The first live check below
exists to catch that before anything else is worth checking.

Pre-merge gates (install, typecheck, codegen drift) are assumed green — they ran
on the branch. Spot-check them only if something below fails.

No test suites in this checklist — this PR's suites (listed at the end, for
awareness) already ran and passed in CI against a real Postgres, on this exact
code. Re-running them here would verify nothing new. Everything below is what
CI genuinely cannot see: the state of the live database and the live app.

**Scope note — reconciliation is deferred.** This PR ships the entitlement model,
its derivation, the write paths and read-path enforcement, plus the grace sweep.
The Stripe-vs-local reconciliation job is **not** in it and lands separately. The
practical consequence to hold while testing: a webhook Stripe never successfully
delivers leaves local state stale until a later event for that same source
arrives, with no background repair — and no manual one either in the direction
that costs money, since admin grant/revoke acts on admin grants, not on Stripe
sources. That gap is known and accepted for this PR; see *What's deliberately
NOT shipped* below.

## Repo-health gates (post-merge state — run always)

- `pnpm --filter @workspace/db validate-snapshots` — expected: passes (matches
  CI's `build.yml`).
- `pnpm --filter @workspace/db check-snapshots` — expected: passes, every
  journal entry exempt or snapshotted. New `SNAPSHOT_EXEMPT_TAGS` entries this
  PR added — verify these two are present in
  `lib/db/scripts/check-migration-snapshots.ts` rather than diagnosing a gate
  failure:
  - `0095_membership_entitlements`
  - `0096_drop_legacy_membership_tables`
- `node scripts/check-docs-accuracy.mjs` — expected: clean, all cited repo
  paths exist.
- Other allow-list entries this PR added (`check-no-console.mjs` /
  `check-cycles.mjs`): none.

## Live checks (read-only unless noted; run always)

### 1. The deploy came up at all

The single most important check. `runMigrations()` runs, then `ensureSchema()`,
**then** the port binds. This PR removes a `seed.ts` entry that ran
`ALTER TABLE lifetime_entitlements …` — against a table migration 0095 now
drops. Left in place it would have raised `42P01` outside the migration runner's
`SAVEPOINT` recovery and aborted startup.

- [ ] The API server workflow is **running** and serving requests.
- [ ] Its boot log contains no `42P01` / `relation … does not exist`.
- [ ] The boot log contains `membership grace sweep scheduled` with a
      `graceSweepIntervalSeconds`. There is **no** reconciliation job in this
      PR — see *Scope note* above — so a missing `reconcileIntervalSeconds` is
      correct, not a defect.

**If the server is not up, stop here and report the log.** Recovery is
roll-forward only: redeploying the previous build does **not** restore the
dropped tables, because the migration runner skips any journal entry whose hash
is already recorded. Fixing forward is the path.

### 2. Live-database migration state

Nothing upstream checks that *this* database received the migration.

- [ ] The three new tables exist:

  ```sql
  SELECT table_name FROM information_schema.tables
  WHERE table_name IN ('membership_entitlements','entitlement_source_disputes','membership_leases')
  ORDER BY 1;
  ```

  Expect all three.

- [ ] The two legacy tables are **gone**:

  ```sql
  SELECT count(*) FROM information_schema.tables
  WHERE table_name IN ('subscriptions','lifetime_entitlements');
  ```

  Expect `0`.

- [ ] `users.membership_valid_until` exists, is `timestamp with time zone`, and
      is **nullable**:

  ```sql
  SELECT data_type, is_nullable FROM information_schema.columns
  WHERE table_name='users' AND column_name='membership_valid_until';
  ```

  Expect `timestamp with time zone` / `YES`. Nullable is load-bearing: null
  means *no expiry*, and every existing row getting null is exactly right —
  `effectiveTierExpr` demotes only when the column is non-null **and** in the
  past, so existing users are unaffected.

- [ ] Both sequences exist:

  ```sql
  SELECT sequencename FROM pg_sequences
  WHERE sequencename IN ('membership_source_state_seq','membership_lease_fence_seq');
  ```

- [ ] Both triggers exist:

  ```sql
  SELECT tgname, tgrelid::regclass FROM pg_trigger
  WHERE NOT tgisinternal
    AND tgrelid::regclass::text IN ('membership_entitlements','entitlement_source_disputes');
  ```

  Expect `trg_membership_entitlements_guard_immutable` and
  `trg_entitlement_source_disputes_guard_absorbing`.

- [ ] **No duplicate constraints.** `drizzle-kit push` and the migration can
      each create the same constraint; they were made to agree on names, and
      this confirms it held here:

  ```sql
  SELECT conname, count(*) FROM pg_constraint
  WHERE conrelid IN ('membership_entitlements'::regclass,'entitlement_source_disputes'::regclass)
  GROUP BY conname HAVING count(*) > 1;
  ```

  Expect **zero rows**.

- [ ] **Re-running migration is skipped, not re-applied.** Run
      `pnpm --filter @workspace/db run migrate` a second time. Expect it to
      report nothing applied and to exit 0. This confirms the runner's
      content-hash tracker skips the file it already recorded — it does not
      confirm the SQL itself is idempotent, since the SQL doesn't run a second
      time to prove that.

### 3. Behaviour against live config and data

Things unit tests mock. Nothing below leaves a config value or a database row
changed from what it was before this check ran.

- [ ] **Every new config key is listable.** `GET /admin/config` (or Admin →
      Config) shows all four:
      `grace_sweep_interval_seconds`, `grace_sweep_alert_after_seconds`,
      `lease_ttl_seconds`, `lease_waiter_timeout_seconds`.

      A key that exists only as a code fallback is invisible here and
      un-editable without a deploy, which is why they are seeded. There are no
      `reconcile_*` keys — reconciliation is deferred.

- [ ] **Each is editable, with a captured restore.** Read the current value of
      `lease_ttl_seconds` first (the seed default is `90`). `PATCH
      /admin/config/lease_ttl_seconds` with a valid value (say `120`) →
      **200**. Then restore it to the value you read (`90`, if it was
      unchanged) through the same endpoint, and confirm the restore with a
      re-read.

- [ ] **The relational validator rejects an incoherent set.** These pass every
      individual range and still must be refused. All three are rejections —
      nothing is written:

  | Write | Expected |
  |---|---|
  | `lease_ttl_seconds` → `5` | **400**, naming the derived floor (83s) |
  | `lease_waiter_timeout_seconds` → `90` | **400** — a waiter may not outlive the lease it waits for |
  | `grace_sweep_alert_after_seconds` → `1800` | **400** — an alert that fires before the sweep could have run again reports a healthy system as broken |

  Each must leave the stored value unchanged. Confirm with a re-read.

- [ ] **The identity guard actually fires in this database.** Inside a
      transaction you intend to roll back, against a real entitlement row:

  ```sql
  BEGIN;
  UPDATE membership_entitlements SET provider_ref = 'tampered' WHERE id = <some id>;
  ```

  Expect `ERROR: membership_entitlements identity is frozen` (this aborts the
  transaction). Run `ROLLBACK;` to close it out regardless. This is the
  backstop against a repair script or a writer nobody enumerated, so it
  matters that it fires here and not only in CI.

- [ ] **The grace sweep's first run is sane.** There is no CLI entry point —
      the sweep is scheduled hourly, first firing an hour after boot. So this is
      a **log check**, not a command. It logs only when it actually changed
      something (`grace sweep converged stored tiers`, carrying `converged`), so
      on a fresh live population the expected result is **silence** — nobody's
      grace horizon has passed. What must **not** appear is `grace sweep failed`
      or the alert-threshold error line.

      The sweep only repairs the stored `membership_tier` projection; the read
      path already enforces expiry on every request, so a sweep that fails is
      cosmetic, not an access leak — that invariant is what
      `membershipReadPath.test.ts` proves in CI (named below).

**A real purchase, and duplicate-webhook delivery, are not exercised here.**
Both would leave a real `membership_entitlements` row and history row with no
restore path through this checklist — admin grant/revoke acts on admin grants,
not Stripe sources, so a TEST_RUN-created purchase can't be cleanly undone the
way the config-key edit above can. That end-to-end path (checkout → tier →
admin view, for both a subscription and the lifetime purchase) is covered in
the UAT instead, where the same Stripe test-mode purchase doubles as the
refund/dispute scenarios David is already walking through.

Proof tests guarding this PR's invariants (run in CI, listed for awareness,
not re-run here):

- `membershipReadPath.test.ts` — runs with **no sweep at all**, writes the
  horizon into the past, and asserts every reader demotes. It is the proof that
  revocation at the deadline does not depend on a background job being healthy.
- `membershipLease.test.ts` — the boundary cases a time-based lease alone gets
  wrong: an expired holder whose successor has written nothing is aborted by the
  fence, and a late holder's release does not release its successor's lease.
- `membershipConfigSeeds.test.ts` — a drift tripwire. `lease_ttl_seconds`'s
  `min_value` is a literal in SQL derived from TypeScript constants; this fails
  if someone changes a constant without re-seeding.

## What's deliberately NOT shipped

- No Stripe-vs-local reconciliation job. A webhook Stripe never successfully
  delivers leaves local state stale until a later event for that same source
  arrives — no background repair.
- No manual repair path in the direction that costs money. Admin grant/revoke
  acts on admin grants, not on Stripe sources, so a stale local row that should
  have lost access can only be corrected by another Stripe event for that
  source, not from the admin screen.

## If something fails

Report, in this order: the section, the exact command, the full output, and —
for the deploy or migration-state checks — the server's boot log. Startup and
migration state are the two failures where the next step differs completely
from every other kind, so distinguishing them early saves a round.

## Delete me

Transient — delete once the checklist has been run. The `_UAT.md` sibling is
the durable half.
