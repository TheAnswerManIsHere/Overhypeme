# Phase 4 — Automated test run

This is the engineering-side checklist for the meme render endpoints
(`/api/render-preview`, `/api/render-download`, the refactored
`/api/memes`), the shared composite module, the `transient_renders`
audit table, and the hourly purger job. Hand it to Replit (or run it
locally) to confirm everything Phase 4 introduced is wired up correctly.

The User Acceptance Test is in [`PHASE_4_UAT.md`](./PHASE_4_UAT.md) — that
one is for the product owner to walk through in a browser.

---

## TL;DR

```bash
# 1. Apply migrations against the local/dev/test DB.
pnpm --filter @workspace/db run migrate

# 2. Build the workspace lib type declarations.
pnpm typecheck:libs

# 3. Repo-wide typecheck (api-server, overhype-me, scripts).
pnpm typecheck

# 4. Run the Phase-4 test suite (58 cases across 5 files).
cd artifacts/api-server && \
  BCRYPT_SALT_ROUNDS=4 TEST_DB_ALLOW_EXIT_ON_IDLE=1 \
  RESEND_API_KEY="re_test_dummy" CRON_SECRET=test \
  node --import tsx/esm \
       --experimental-test-isolation=none --test-concurrency=1 --test \
       'src/__tests__/phase4.*.test.ts'
```

Expected: `# tests 58` `# pass 58` `# fail 0`. End-to-end runtime:
~5 seconds for the validators + composite tests, ~5 seconds for the
route + save + purger tests against a warm Postgres.

If the dev DB has been idle for a while, run `pnpm --filter @workspace/db run migrate`
first so migrations 0050 (`transient_renders`) and 0051 (memes user/created_at
index) are applied — the Phase-4 tests will fail with `relation
"transient_renders" does not exist` otherwise.

---

## What it actually runs

| # | Layer | Command | What it proves |
|---|---|---|---|
| 1 | lib type build | `pnpm typecheck:libs` | New `transient_renders` schema exports cleanly from `@workspace/db/schema`; cross-package imports compile. |
| 2 | repo typecheck | `pnpm typecheck` | api-server, overhype-me, mockup-sandbox, scripts all type-check. The new `lib/memeComposite.ts`, `lib/validators/memeBuilder.ts`, `routes/render.ts`, and the refactored `routes/memes.ts` and `MemeBuilder.tsx` compile under strict mode. |
| 3 | db migrate | `pnpm --filter @workspace/db run migrate` | The hash-based migration runner applies through 0051 cleanly. The runner records each migration in `drizzle.__drizzle_migrations` and verifies the journal-vs-recorded counts match. |
| 4 | Phase-4 tests | `node --test 'src/__tests__/phase4.*.test.ts'` | 58 cases — see breakdown below. |
| 5 | Existing memes tests | `node --test 'src/__tests__/routes.memes.test.ts' 'src/__tests__/memeGenerator.test.ts' 'src/__tests__/phase3.lineage.integration.test.ts'` | Confirms the refactored `/api/memes` still satisfies the Phase-3 contract: 43 cases, all green. Any regression here means Phase 4 broke a Phase-3 promise. |
| 6 | Cycle / console checks | `pnpm run check:cycles && pnpm run check:no-console` | No new import cycles, no stray `console.*` calls in `src/`. |

---

## What each Phase-4 test file covers

### `phase4.validators.test.ts` *(new — pure unit, no DB)*

| Suite | Cases | Asserts |
|---|---|---|
| `PronounsSchema` | 8 | All five allowlist values pass; case-insensitive normalisation (`"She/Her"` → `"she/her"`); unknown values rejected; empty + oversized rejected. |
| `NameSchema` | 11 | Length 1-50, regex allowlist (letters/marks/digits/spaces/`'`/`.`/`-`); whitespace runs collapsed; newlines/tabs/carriage returns rejected; HTML brackets and shell metacharacters rejected; non-ASCII letters accepted (`José Núñez`). |
| `deriveRenderMode` | 6 | template + stock → `stock`; upload + identity → `self-upload`; `imageTransform === "pulid"` → `pulid` regardless of imageSource; `pulid_fallback_text` falls through to the imageSource-derived mode (no legendary gate). |
| `RenderRequestBody` | 5 | Minimal stock-mode body accepted; missing name rejected; bad pronoun rejected; malformed `imageSource` rejected; uploadKey not starting with `/objects/` rejected. |
| `SaveMemeBody` | 3 | Name and pronouns optional (route falls back to `req.user`); pronoun validation still runs when provided; `imageTransform: "pulid"` accepted. |

### `phase4.composite.test.ts` *(new — composite module, uses node-canvas, no DB)*

| Suite | Cases | Asserts |
|---|---|---|
| `composeMeme` | 4 | Returns a JPEG buffer (verified via FF D8 FF magic bytes); identical inputs produce **byte-identical** SHA-256 across two invocations; different names produce different bytes (`renderPersonalized` is wired); `{singular\|plural}` token conjugates differently for `he/him` vs `they/them`. |

### `phase4.render.routes.test.ts` *(new — supertest + Postgres + canvas)*

| Suite | Cases | Asserts |
|---|---|---|
| `POST /api/render-preview` | 8 | Returns `image/jpeg` with no `Content-Disposition`; rejects bad pronoun/oversized name/newline-name with 400; `fact_not_found` 404; anonymous + non-stock mode → 403 `mode_requires_auth`; `transient_renders` row created on success **and** rejection paths; IP is hashed (sha256 hex), never stored raw. |
| `POST /api/render-download` | 2 | Returns `image/jpeg` with `Content-Disposition: attachment; filename="overhype-{factSlug}.jpg"`; the slug is derived from the fact text. |
| Composite byte-identity across endpoints | 1 | Calling `/api/render-preview` and `/api/render-download` with identical inputs produces identical SHA-256 bytes — the composite is the same code path. |

### `phase4.memes.save.test.ts` *(new — supertest + Postgres + canvas)*

| Suite | Cases | Asserts |
|---|---|---|
| Auth gate | 1 | Anonymous POST `/memes` → 401. |
| Slug shape | 1 | Returns a 10-char nanoid slug (`/^[A-Za-z0-9]{10}$/`); response includes `slug`, `permalinkSlug`, and `permalinkUrl` aliases. |
| Idempotency | 2 | Same inputs within 60 s → second POST returns the first meme's id with `idempotent: true`, only one row in DB. Different `framingTransform` → distinct memes. |
| Daily save cap | 2 | Pre-seed 30 live memes for a registered user; the 31st POST returns 429 `daily_cap_reached`. The same 30 rows soft-deleted → 31st POST succeeds (soft-deletes excluded by the count query). |
| PuLID tier gate | 1 | A non-legendary user POSTing with `imageTransform: "pulid"` → 403 `tier_mismatch`. |
| Soft-deleted slug uniqueness | 1 | Soft-deleting a meme does not free its slug; subsequent inserts get a different slug; UNIQUE constraint holds. |

### `phase4.purger.test.ts` *(new — Postgres only, no HTTP)*

| Cases | Asserts |
|---|---|
| 2 | Inserts rows back-dated past + within the 30-day retention window; `runTransientRenderPurger()` deletes the past-retention rows and keeps the fresh row. The job is a no-op when nothing is past retention. |

---

## What Phase 4 did NOT add to the test suite (intentional)

These pieces are infrastructure that integration tests can't reach:

- **Cloudflare WAF rate-limit rules** — `RL-PREVIEW` (30/IP/hr) and
  `RL-DOWNLOAD` (10/IP/hr). Verify in production with the curl loop in
  `docs/cloudflare-rate-limits.md` once the rules are created in the
  dashboard. The expression and custom-response body are documented so
  the rules are recoverable if the Cloudflare config is ever lost.
- **The hourly cron schedule itself** — the purger function is unit-
  tested but the `setTimeout` registration in `src/index.ts` boots
  during process startup. Verify in dev by tailing logs after start:
  expect `transient_renders purger scheduled` within a few seconds and
  `transient_renders purger run` at the next top-of-hour.
- **Production GCS upload by `/api/memes`** — the route writes to
  `memes/{hash2}/{slug}.jpg` via the existing `uploadObjectBuffer`
  helper. The unit tests cover the recipe-write path; bytes-on-disk
  verification belongs in UAT (`PHASE_4_UAT.md` § C).

---

## Migration verification

Two new migrations land in `lib/db/migrations/`:

| Migration | Adds | Why |
|---|---|---|
| `0050_transient_renders.sql` | `transient_renders` table + 3 indexes (`ip_hash_created_at`, `user_id_created_at`, `created_at`). | Audit log for `/api/render-preview` and `/api/render-download`. |
| `0051_memes_creator_created_at_index.sql` | Partial index `idx_memes_created_by_id_created_at` ON memes(created_by_id, created_at) WHERE deleted_at IS NULL. | Covers the per-user daily-cap query and the idempotency lookup. |

Verify after running `pnpm --filter @workspace/db run migrate`:

```sql
-- 1. Confirm the table exists with the right columns.
\d transient_renders
-- Expect: id uuid PK default gen_random_uuid(), endpoint varchar(16) NOT NULL,
-- fact_id integer REFERENCES facts, user_id varchar REFERENCES users,
-- ip_hash text NOT NULL, mode varchar(24), result varchar(12) NOT NULL,
-- rejection_reason text, latency_ms integer,
-- created_at timestamptz NOT NULL DEFAULT now()

-- 2. Confirm the indexes exist.
SELECT indexname FROM pg_indexes
 WHERE tablename = 'transient_renders' ORDER BY 1;
-- Expect: idx_transient_renders_created_at,
--         idx_transient_renders_ip_hash_created_at,
--         idx_transient_renders_user_id_created_at

-- 3. Confirm the new memes index.
SELECT indexname, indexdef FROM pg_indexes
 WHERE tablename = 'memes' AND indexname = 'idx_memes_created_by_id_created_at';
-- Expect: ... WHERE (deleted_at IS NULL)

-- 4. Confirm both migrations recorded.
SELECT * FROM drizzle.__drizzle_migrations
 ORDER BY created_at DESC LIMIT 5;
-- Expect rows with created_at = 1778190300000 (0050) and 1778190360000 (0051).
```

---

## Reading the output

Each `node --test` run prints a TAP-style stream. The summary at the
bottom is the source of truth:

```
# tests 58
# pass  58
# fail  0
```

If `# fail` is > 0, scroll up for the first `not ok N — <name>` block;
each one carries a `location:` and a stack trace.

---

## When to re-run

- Before pushing to `claude/setup-overhype-project-ZszJ6` or any branch
  that touches:
  - `artifacts/api-server/src/lib/memeComposite.ts`
  - `artifacts/api-server/src/lib/transientRenderLog.ts`
  - `artifacts/api-server/src/lib/validators/memeBuilder.ts`
  - `artifacts/api-server/src/routes/render.ts`
  - `artifacts/api-server/src/routes/memes.ts`
  - `artifacts/api-server/src/jobs/transientRenderPurger.ts`
  - `lib/db/migrations/0050_*` or `lib/db/migrations/0051_*`
  - `lib/db/src/schema/transientRenders.ts`
  - `artifacts/overhype-me/src/components/meme-builder/MemeBuilder.tsx` (the `/api/render-download` wiring)
- After every PR review of Phase-4-adjacent changes.
- Once after `pnpm install` if the lockfile changed (nanoid was added).

---

## Pre-existing test noise (unrelated to Phase 4)

When running the full backend suite (`'src/__tests__/**/*.test.ts'`), three CSRF
integration tests fail with `"CRON_SECRET environment variable is required but
was not provided. Set it in Replit Secrets."`. Setting `CRON_SECRET=test` makes
them pass — they're not introduced by Phase 4. Either set the env var or scope
the run to `'src/__tests__/phase4.*.test.ts'` plus the existing memes + canvas
suites.

The sharded test runner script `scripts/run-tests-sharded.sh` uses the
unstable Node 22 flag `--test-isolation=none` instead of the renamed
`--experimental-test-isolation=none`. Use the direct `node --test` command
above until that script is updated; this is also pre-existing.

---

## Reporting failures

If a Phase-4 layer fails, capture:

1. Which command failed and its full stderr/stdout.
2. The migration list output (`SELECT tag FROM drizzle.__drizzle_migrations ORDER BY id`)
   — confirm 0050 and 0051 are present.
3. `pnpm --version` and `node --version` (Phase 4 was developed against
   Node 22.22.2 / pnpm 10.33.0).
4. Whether the test DB was freshly recreated or carrying state from a
   previous run (the test fixtures clean up by user-id prefix, but a
   manual `psql` poke might have left orphans).

Phase-4-adjacent branch: `claude/setup-overhype-project-ZszJ6`
(PR [#40](https://github.com/TheAnswerManIsHere/Overhypeme/pull/40)).
