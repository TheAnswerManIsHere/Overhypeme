# PR #287 — Entitlement model — Replit test run

Engineering checklist for the live workspace, **after this PR merges to `main`**.
Companion in-app acceptance test:
[`PR287_PAYMENTS_ENTITLEMENT_MODEL_UAT.md`](PR287_PAYMENTS_ENTITLEMENT_MODEL_UAT.md).

**This is the highest-risk migration this repo has shipped.** It creates three
tables and **drops two**, and a startup-order mistake here does not degrade the
site — it stops the process from binding its port. Section 1 exists to catch
that first, before anything else is worth checking.

Pre-merge gates (install, typecheck, codegen drift) are assumed green — they ran
on the branch. Spot-check them only if something below fails.

**Scope note — reconciliation is deferred.** This PR ships the entitlement model,
its derivation, the write paths and read-path enforcement, plus the grace sweep.
The Stripe-vs-local reconciliation job is **not** in it and lands separately. The
practical consequence to hold while testing: a webhook Stripe never successfully
delivers leaves local state stale until a later event for that same source
arrives, with no background repair — and no manual one either in the direction
that costs money, since admin grant/revoke acts on admin grants, not on Stripe
sources. That gap is known and accepted for this PR.

---

## 1. The deploy came up at all

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

## 2. Live-database migration state

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

- [ ] **Re-running is a no-op.** Run `pnpm --filter @workspace/db run migrate`
      a second time. Expect it to report nothing applied and to exit 0 — not
      merely "does not throw". Every statement is guarded
      (`IF NOT EXISTS` / `DROP … IF EXISTS` / `ON CONFLICT DO NOTHING` /
      `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`), and the runner tracks
      by file hash.

## 3. Post-merge repo-health gates

These depend on the merged state of `main`, which the branch could not see.

- [ ] `pnpm --filter @workspace/db validate-snapshots` — passes.
- [ ] `pnpm --filter @workspace/db check-snapshots` — every journal entry
      snapshotted or explicitly exempt.
- [ ] `node scripts/check-docs-accuracy.mjs` — all cited repo paths exist.

**New exempt-list entries this PR added** — verify these two are present in
`lib/db/scripts/check-migration-snapshots.ts` rather than diagnosing a gate
failure:

- `0095_membership_entitlements`
- `0096_drop_legacy_membership_tables`

## 4. Behaviour against live config and data

Things unit tests mock.

- [ ] **Every new config key is listable.** `GET /admin/config` (or Admin →
      Config) shows all four:
      `grace_sweep_interval_seconds`, `grace_sweep_alert_after_seconds`,
      `lease_ttl_seconds`, `lease_waiter_timeout_seconds`.

      A key that exists only as a code fallback is invisible here and
      un-editable without a deploy, which is why they are seeded. There are no
      `reconcile_*` keys — reconciliation is deferred.

- [ ] **Each is editable.** `PATCH /admin/config/lease_ttl_seconds` with a
      valid value (say `120`) → **200**. Set it back to `90`.

- [ ] **The relational validator rejects an incoherent set.** These pass every
      individual range and still must be refused:

  | Write | Expected |
  |---|---|
  | `lease_ttl_seconds` → `5` | **400**, naming the derived floor (83s) |
  | `lease_waiter_timeout_seconds` → `90` | **400** — a waiter may not outlive the lease it waits for |
  | `grace_sweep_alert_after_seconds` → `1800` | **400** — an alert that fires before the sweep could have run again reports a healthy system as broken |

  Each must leave the stored value unchanged. Confirm with a re-read.

- [ ] **A real membership still works end to end.** In **test mode**, buy a
      membership through checkout and confirm:
      - a row appears in `membership_entitlements` with
        `source_type='stripe_lifetime_payment'` (or `stripe_subscription`),
        `is_membership_product=true`, and a non-null `provider_ref`;
      - `users.membership_tier` reads `legendary` and
        `users.membership_valid_until` is **null**;
      - `membership_history` has a `lifetime_purchase` (or
        `subscription_activated`) row.

- [ ] **A duplicate webhook writes nothing new.** Re-send the same
      `checkout.session.completed` from the Stripe dashboard. Expect
      `stripe_webhook_audit` to record `ignored_duplicate`, and **no** second
      `membership_entitlements` row and **no** second history row.

- [ ] **The identity guard actually fires in this database.** Run against a
      real entitlement row:

  ```sql
  UPDATE membership_entitlements SET provider_ref = 'tampered' WHERE id = <some id>;
  ```

  Expect `ERROR: membership_entitlements identity is frozen`. **Roll back / do
  not commit.** This is the backstop against a repair script or a writer nobody
  enumerated, so it matters that it is live here and not only in CI.

- [ ] **The grace sweep's first run is sane.** There is no CLI entry point —
      the sweep is scheduled hourly, first firing an hour after boot. So this is
      a **log check**, not a command. It logs only when it actually changed
      something (`grace sweep converged stored tiers`, carrying `converged`), so
      on a fresh live population the expected result is **silence** — nobody's
      grace horizon has passed. What must **not** appear is `grace sweep failed`
      or the alert-threshold error line.

      The sweep only repairs the stored `membership_tier` projection; the read
      path already enforces expiry on every request, so a sweep that fails is
      cosmetic, not an access leak. That is what the `membershipReadPath` test
      in section 5 proves.

## 5. Targeted test list

Scoped to the surfaces this PR touched.

```
bash artifacts/api-server/scripts/run-test.sh \
  src/__tests__/membershipState.test.ts \
  src/__tests__/membershipStateSql.test.ts \
  src/__tests__/membershipTiming.test.ts \
  src/__tests__/membershipConfigSeeds.test.ts \
  src/__tests__/membershipLease.test.ts \
  src/__tests__/membershipReadPath.test.ts \
  src/__tests__/membershipGraceSweep.test.ts \
  src/__tests__/entitlementVerification.test.ts \
  src/__tests__/authMiddleware.test.ts \
  src/__tests__/tierMiddleware.test.ts \
  src/__tests__/routes.admin.test.ts \
  src/__tests__/routes.admin.auth.test.ts
```

Assertion: **`0 fail`.**

The load-bearing ones, worth naming:

- `membershipReadPath.test.ts` — runs with **no sweep at all**, writes the
  horizon into the past, and asserts every reader demotes. It is the proof that
  revocation at the deadline does not depend on a background job being healthy.
- `membershipLease.test.ts` — the boundary cases a time-based lease alone gets
  wrong: an expired holder whose successor has written nothing is aborted by the
  fence, and a late holder's release does not release its successor's lease.
- `membershipConfigSeeds.test.ts` — a drift tripwire. `lease_ttl_seconds`'s
  `min_value` is a literal in SQL derived from TypeScript constants; this fails
  if someone changes a constant without re-seeding.

## 6. Full sharded suite — **required**

**Yes, run it.** This PR touches shared infra: the DB schema, the migration
journal, `authMiddleware`, and the seed. That is squarely inside the contract's
trigger list.

```
pnpm --filter @workspace/api-server test
```

**Stop the `artifacts/api-server: API Server` workflow first** to release
test-DB connections, or the `pretest` chain (push-force → migrate → codegen)
stalls against the test database.

### Known failures — pre-existing, not from this PR

**`factLifecycleClosure.test.ts` — 3 failures**, all in the
`DB CHECK — facts_active_requires_concept` suite ("REJECTS an active fact with
null enrichment", "…with a whitespace-only concept", "…whose concept is a
non-string JSON scalar"). The constraint is simply **absent** from the database:

```sql
SELECT conname FROM pg_constraint WHERE conname = 'facts_active_requires_concept';
```

returns nothing, so the negative cases get no rejection. Migration 0092, which
adds it, is recorded as applied. This reproduces on `origin/main`, the test file
is unchanged by this PR, and none of its dependencies are in the diff. **Do not
investigate it as a regression from this work** — report it separately if it is
still red.

Everything else: `0 fail`.

---

## If something fails

Report, in this order: the section number, the exact command, the full output,
and — for section 1 or 2 — the server's boot log. Startup and migration state
are the two failures where the next step differs completely from every other
kind, so distinguishing them early saves a round.
