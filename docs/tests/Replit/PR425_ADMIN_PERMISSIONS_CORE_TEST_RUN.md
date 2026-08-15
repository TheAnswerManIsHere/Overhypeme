# PR #425 — Admin permissions core: Replit test run

> **Executor:** Replit, in the live workspace, **after** PR #425 has merged to
> `main` and the Repl has synced.
>
> **Scope:** this checklist verifies only what this environment can verify that
> CI cannot — that *this* database received migration `0099`, that the
> post-merge repo-health gates are green on merged `main`, and that the grid
> resolves correctly against live seeded data. Everything else already passed
> pre-merge.
>
> **Read-only.** Nothing here mutates live data. The one write-shaped step is a
> 403 refusal probe, whose *rejection* is the thing being tested — a refused
> request writes nothing.
>
> **UAT sibling:** [`PR425_ADMIN_PERMISSIONS_CORE_UAT.md`](./PR425_ADMIN_PERMISSIONS_CORE_UAT.md)
> — David's in-app click-through. Run this checklist first.

Pre-merge gates (install, typecheck, codegen drift, permission chokepoint,
docs accuracy) are assumed green — CI ran them on this exact code. Spot-check
them only if something below fails unexpectedly.

---

## 1. Live-database migration state

Migration `0099_admin_permissions_core` is the only new one. Confirm this
database actually received it.

### 1a. The three new tables exist

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'tier_feature_permission_audit',
    'entitlement_grid_revision',
    'feature_permissions_migration_log'
  )
ORDER BY table_name;
```

**Expect:** exactly three rows, all three names present.

### 1b. `video_jobs.authorization_snapshot` exists, is `jsonb`, and is `NOT NULL`

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'video_jobs' AND column_name = 'authorization_snapshot';
```

**Expect:** one row — `authorization_snapshot | jsonb | NO`.

`NOT NULL` is the load-bearing part: it is what makes the compiler enumerate
every statically-typed insert site. If `is_nullable` comes back `YES`, the
column was added but the constraint step did not land — stop and report.

### 1c. The revision singleton exists and is unique

```sql
SELECT id, revision FROM entitlement_grid_revision;
```

**Expect:** exactly ONE row, `id = 1`. `revision` may be any value ≥ 0 (it
advances on every grid write, so a non-zero value here just means someone has
already toggled a cell).

### 1d. Backfill outcome — the three counts

The backfill writes its counts to a durable table rather than to stdout,
because the migration runner discards statement result rows.

```sql
SELECT migration_name,
       inserted_count,
       already_complete_count,
       engine_experiments_skipped_count,
       (deleted_rows IS NOT NULL) AS captured_deleted_rows,
       ran_at
FROM feature_permissions_migration_log
ORDER BY id;
```

**Expect:** at least one row with `migration_name = '0099_admin_permissions_core'`.

Reading the numbers:

- `inserted_count` — how much drift was repaired. **Any value is fine**,
  including 0 (a clean database) and a large number (this database had gaps).
- `already_complete_count` — how many features already had all four tier rows
  going in.
- `engine_experiments_skipped_count` — how many rows the deliberate
  `engine_experiments` exception cost. **Expect 4** if `engine_experiments`
  exists as a feature with no tier rows (its normal state), or 0 if the feature
  row is absent entirely.
- `captured_deleted_rows` — **expect `true`** if this database still had
  `meme_upload_photo`, `false` if it had already been cleaned. Either is
  correct; `true` means the retired rows were captured before deletion.

### 1e. The retirement landed, and the reinstated row did not

```sql
SELECT key FROM feature_flags ORDER BY key;
```

**Expect:**
- `meme_upload_photo` — **absent**. Retired: no code read it, and its values
  encoded only the registered-vs-unregistered distinction authentication
  already enforces.
- `meme_ai_background` — **present**. It looks dead (its only reader was an
  unreachable gate) but the capability is live: it now gates the AI Background
  Picker's four routes.
- `video_generation` — **present**. Its rows used to be recreated by `seed.ts`
  on every boot; that seed is deleted and the migration guarantees them
  instead.
- `engine_experiments` — **present**, and deliberately still has no tier rows
  (Plan 3 owns it).

### 1f. Every consulted feature has a complete four-row set

```sql
SELECT f.key, count(p.tier) AS tier_rows
FROM feature_flags f
LEFT JOIN tier_feature_permissions p
  ON p.feature_key = f.key
 AND p.tier IN ('unregistered', 'registered', 'legendary', 'admin')
GROUP BY f.key
ORDER BY f.key;
```

**Expect:** `tier_rows = 4` for every feature **except** `engine_experiments`,
which should be 0.

A feature with 1–3 rows means the backfill did not complete — the resolver
fails closed on a missing row, so this is a silent denial rather than a leak,
but it is still wrong. Report it.

### 1g. Re-running `migrate` is skipped, not re-executed

Apply migrations a second time.

**Expect:** the runner reports `0 applied` and skips `0099` — its content hash
is already recorded. This confirms **hash tracking**, not SQL-level
idempotency; the SQL does not run twice. (SQL-level idempotency is proved
separately in CI, by an integration test that calls the backfill function
directly twice in one test.)

---

## 2. Post-merge repo-health gates

These depend on the merged state of `main`, which the PR author could not see —
a gate green on the branch can be red here if another PR landed first.

```
pnpm --filter @workspace/db validate-snapshots
pnpm --filter @workspace/db check-snapshots
node scripts/check-docs-accuracy.mjs
pnpm run check:permissions
pnpm run check:codegen-drift
```

**New allow-list entries this PR added** — verify these are present rather
than diagnosing an unexplained failure:

- `scripts/check-permission-chokepoint.mjs` carries **three** declared
  exceptions in its `ALLOWLIST`, each naming what removes it:
  1. `routes/videos.ts` — `GET /engines`' catalogue filter, deferred to Plan 3.
  2. `lib/moderation/uploadRateLimit.ts` — a numeric daily upload cap, deferred
     to Plan 2.
  3. `routes/admin.ts` — `POST /admin/users`' refusal to write `legendary`
     directly. Permanent; this is the derived-tier invariant, not a gate.

  **Expect:** `OK: <n> files checked, 3 declared exception(s).`

- `0099_admin_permissions_core` has **no** snapshot file and needs a
  `SNAPSHOT_EXEMPT_TAGS` entry only if `check-snapshots` demands one. If that
  gate fails naming `0099`, report it — do not add the exemption yourself.

---

## 3. Behavior against live config and data

### 3a. The Admin column is actually live

Read what an admin resolves for a feature their stored tier does **not** grant.
`custom_avatar` is the clearest case: it is off for `registered` and on for
`admin`, and most admins' stored tier is `registered`.

```sql
SELECT tier, enabled
FROM tier_feature_permissions
WHERE feature_key = 'custom_avatar'
ORDER BY tier;
```

**Expect:** `admin = true`, `legendary = true`, `registered = false`,
`unregistered = false`.

This is configuration, not behavior — the behavioral half is the UAT's
custom-avatar walkthrough.

### 3b. The entitlement payload is served, and is a sibling of `user`

Hit the auth endpoint **unauthenticated** (no cookie, no bearer):

```
GET /api/auth/user
```

**Expect** a JSON body with all three of:
- `user`: `null`
- `entitlements`: an object with one key per feature, each
  `{ "allowed": false, "limit": null }`
- `entitlementVersion`: `{ "gridRevision": <number>, "principalFingerprint": "<hex>" }`

The load-bearing part is that `entitlements` is populated **even though `user`
is null**. If it is absent or empty for the anonymous case, the sibling-field
contract did not ship and every logged-out surface will fall back to locked.

### 3c. The version endpoint is never shared-cached

```
GET /api/entitlements/version
```

**Expect** response headers:
- `Cache-Control: private, no-store`
- `Vary: Cookie, Authorization`

This matters more than it looks: the response varies by tier, admin grant, and
session-scoped view-as-user state, so a proxy caching it by URL could serve one
principal's fingerprint to another — and that second client may then never
converge on its own entitlements.

### 3d. Refusal probe — the standalone custom-avatar selection (writes nothing)

As a **registered, non-Legendary, non-admin** account:

```
PATCH /api/users/me   body: {"avatarSource": "photo"}
```

**Expect:** `403` with `{"error": "custom_avatar_required", ...}`, and the
account's `avatar_source` **unchanged** in the database.

A refused request writes nothing, which is why this probe is safe to run
against live data. If it returns `200`, the selection gate did not ship.

---

## 4. Targeted test runs

**None.** Every test in this PR passed in CI on the merged code, and none of
them measures anything the live environment changes. Re-running them here would
add no signal and would require stopping the API Server workflow.

For reference, the suites this PR added — all CI-run, not run here:
`featureAccess.integration.test.ts`, `adminLockout.integration.test.ts`,
`effectiveAvatar.integration.test.ts`.

---

## 5. Report back

For each section, report pass/fail with the actual output. If anything in
section 1 fails, **stop** — a migration that did not fully land makes the rest
of the checklist meaningless, and the UAT should not begin.

Known-good deviations that are **not** failures:
- `inserted_count = 0` in 1d (this database had no drift).
- `captured_deleted_rows = false` in 1d (`meme_upload_photo` was already gone).
- A non-zero `revision` in 1c (someone has toggled a grid cell).
