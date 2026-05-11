# Phase 6 — Automated test run

This is the engineering-side checklist for the meme share modal, the
`/api/share-copy/:memeId/:platform` and `POST /api/share-intents`
endpoints, the new `share_intents` table, and the six DB-stored
share-copy templates. Hand it to Replit (or run it locally) to confirm
everything Phase 6 introduced is wired up correctly.

The User Acceptance Test is in [`PHASE_6_UAT.md`](./PHASE_6_UAT.md) — that
one is for the product owner to walk through in a browser.

---

## TL;DR

```bash
# 1. Apply migrations against the local/dev/test DB.
#    Phase 6 adds 0052_share_intents.sql (the table + six admin_config
#    seed rows for share-copy templates).
pnpm --filter @workspace/db run migrate

# 2. Repo-wide typecheck (api-server, overhype-me, scripts).
pnpm typecheck

# 3. Run the new Phase-6 backend tests (19 cases across 2 suites).
cd artifacts/api-server && \
  BCRYPT_SALT_ROUNDS=4 TEST_DB_ALLOW_EXIT_ON_IDLE=1 \
  RESEND_API_KEY="re_test_dummy" CRON_SECRET=test \
  node --import tsx/esm \
       --experimental-test-isolation=none --test-concurrency=1 --test \
       'src/__tests__/routes.shareCopy.test.ts' \
       'src/__tests__/routes.shareIntents.test.ts'

# 4. Run the new Phase-6 frontend tests (9 cases) +
#    the full overhype-me suite to prove no regressions.
cd ../overhype-me && pnpm exec vitest run

# 5. Regression: Phase-5 OG suite + memes routes must still pass.
cd ../api-server && \
  BCRYPT_SALT_ROUNDS=4 TEST_DB_ALLOW_EXIT_ON_IDLE=1 \
  RESEND_API_KEY="re_test_dummy" CRON_SECRET=test \
  node --import tsx/esm \
       --experimental-test-isolation=none --test-concurrency=1 --test \
       'src/__tests__/phase5.*.test.ts' \
       'src/__tests__/routes.memes.test.ts'
```

Expected:

| Suite | Cases | Pass |
|---|---|---|
| `routes.shareCopy.test.ts` | 11 | 11 |
| `routes.shareIntents.test.ts` | 8 | 8 |
| `MemeShareModal.test.tsx` (vitest) | 9 | 9 |
| Existing overhype-me suites | 372 | 372 |
| `phase5.og.routes.test.ts` (regression) | 7 | 7 |
| `routes.memes.test.ts` (regression) | 23 | 23 |

End-to-end runtime:

- Backend Phase-6 suite: ~2 seconds against a warm Postgres.
- Full vitest run: ~12 seconds.
- Phase-5 + memes regression: ~3 seconds.

---

## What it actually runs

| # | Layer | Command | What it proves |
|---|---|---|---|
| 1 | repo typecheck | `pnpm typecheck` | api-server, overhype-me, scripts type-check. The new `routes/shareCopy.ts`, `routes/shareIntents.ts`, `lib/db/src/schema/shareIntents.ts`, and `components/share/*` all compile under strict mode. |
| 2 | Phase-6 backend | `node --test 'src/__tests__/routes.share*.test.ts'` | 19 cases — see breakdown below. |
| 3 | Phase-6 frontend | `pnpm exec vitest run` | 9 new cases (`MemeShareModal.test.tsx`) plus 372 pre-existing. The Phase-6 cases live in `src/components/share/__tests__/MemeShareModal.test.tsx`. |
| 4 | regression: Phase 5 | `node --test 'src/__tests__/phase5.*.test.ts'` | The OG endpoint and the meme detail page chrome are not affected by the share-modal wiring. 7 cases. |
| 5 | regression: memes routes | `node --test 'src/__tests__/routes.memes.test.ts'` | Mounting the two new routers in `routes/index.ts` does not collide with any existing path. 23 cases. |

---

## What each Phase-6 test file covers

### `routes.shareCopy.test.ts` *(new — supertest + Postgres)*

| Suite | Cases | Asserts |
|---|---|---|
| `auth` | 1 | Returns 401 when the request is unauthenticated. The `share-copy` endpoint is gated to free+ as belt-and-suspenders for the UI gate (the modal only opens from CTA cells that already require auth). |
| `validation` | 2 | Returns 400 for an unknown platform string (anything other than `twitter` / `web_share` / `copy_link` / `email`). Returns 404 when the slug doesn't resolve to a meme. |
| `twitter` | 3 | Response shape: `{ platform, url, text, hashtags, intentUrl }`. The `intentUrl` is a `twitter.com/intent/tweet` URL with `text=`, `url=`, and `hashtags=` parameters set, all URL-encoded. Names with apostrophes (`O'Hara`) and accented characters (`José`) are correctly form-encoded (`Jos%C3%A9+O%27Hara`). Very long fact text (600 chars) is truncated with an ellipsis to stay within Twitter's 280-char budget after the URL and hashtags reserve. |
| `web_share` | 1 | Response shape: `{ platform, url, title, text }`, ready to pass straight to `navigator.share()`. Title and text come from the `share_copy_web_share_*` admin_config templates with `{name}`, `{fact_text}`, and `{permalink}` substituted. |
| `copy_link` | 1 | Response shape is just `{ platform, url }` — the absolute permalink (`https://overhype.me/m/<slug>`). |
| `email` | 1 | Response shape: `{ platform, url, subject, body, intentUrl }`. The `intentUrl` is a `mailto:?subject=…&body=…` URL using `%20` for spaces (NOT `+` — Outlook renders the `+` literally). The body includes the brand sign-off ("Sent from overhype.me, where legends are made up") and the absolute permalink. |
| `410 soft-deleted` | 1 | Returns 410 for a meme whose `deleted_at` is non-null. Mirrors the OG endpoint's soft-delete handling. |
| `rate limit` | 1 | After 60 successful requests in the window, the 61st returns 429. The bucket is per-user. |

### `routes.shareIntents.test.ts` *(new — supertest + Postgres)*

| Suite | Cases | Asserts |
|---|---|---|
| `auth` | 1 | Returns 401 when the request is unauthenticated. |
| `validation` | 4 | Returns 400 for an unknown platform string. Returns 400 when `memeId` is missing from the body. Returns 404 when the slug doesn't resolve to a meme. Returns 410 when the meme is soft-deleted (a race between modal-open and click is surfaced explicitly rather than silently logging an intent against a meme nobody can share). |
| `insertion` | 2 | Successful POST inserts one row into `share_intents` with the correct `meme_id` (resolved from slug to integer FK), `user_id`, and `platform`, and returns `204`. All four valid platforms (`twitter`, `web_share`, `copy_link`, `email`) round-trip through the CHECK constraint. |
| `FK cascade` | 1 | Hard-deleting the parent meme removes all `share_intents` rows for that meme via `ON DELETE CASCADE`. |

### `MemeShareModal.test.tsx` *(new — vitest + React Testing Library)*

| Suite | Cases | Asserts |
|---|---|---|
| `button-set detection` | 2 | When `navigator.share` is a function: renders Share + Twitter/X + Copy Link, no Email button. When `navigator.share` is undefined: renders Email + Twitter/X + Copy Link, no Share button. Detection runs once at mount via `useWebShareSupport`; a neutral skeleton renders for the first paint while the probe resolves so the wrong button set never flashes. |
| `Web Share button` | 3 | Tapping Share invokes `navigator.share()` with `{ title, text, url }` from the server-built `web_share` payload, fires the share-intent log, and closes the modal. AbortError (the user dismissed the share sheet without picking an app) is silent — no toast. Other errors fall back to a generic destructive toast suggesting Copy Link. |
| `Twitter button` | 2 | Opens the server-built `twitter.com/intent/tweet` URL in a new tab (`window.open(url, "_blank", "noopener,noreferrer")`), fires the share-intent log, closes the modal. When the share-copy fetch fails, falls back to a minimal Twitter intent URL with the raw permalink so the button still works. |
| `Copy Link button` | 1 | Writes the absolute permalink to clipboard via `navigator.clipboard.writeText`, shows a "Link copied" toast, fires the share-intent log, closes the modal. |
| `fire-and-forget intent log` | 1 | When `POST /api/share-intents` returns 500, the share action still proceeds — `navigator.share()` is invoked and the modal closes. The intent log is best-effort; failures must NOT block the user's share. |

---

## Migration verification

Phase 6 adds **one migration**: `lib/db/migrations/0052_share_intents.sql`.

It creates:

- The `share_intents` table:
  - `id serial PRIMARY KEY`
  - `meme_id int NOT NULL REFERENCES memes(id) ON DELETE CASCADE`
  - `user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE`
  - `platform varchar(20) NOT NULL CHECK (platform IN ('twitter','web_share','copy_link','email'))`
  - `created_at timestamptz NOT NULL DEFAULT now()`
- Three indexes: `(meme_id, created_at)`, `(user_id, platform, created_at)`, `(platform, created_at)`. The first two power per-meme and per-user analytics; the third powers the platform-distribution rollup.
- Six `admin_config` rows seeded via `INSERT … ON CONFLICT DO NOTHING` (idempotent — re-running the migration won't overwrite admin edits):

| Key | Default value |
|---|---|
| `share_copy_twitter_template` | `{fact_text}` |
| `share_copy_twitter_hashtags` | `overhype,legendsaremadeup` |
| `share_copy_email_subject_template` | `A meme of {name} on overhype.me` |
| `share_copy_email_body_template` | Multi-line; reads "{name} thought you'd appreciate this:" / quoted fact / "See it: {permalink}" / "— Sent from overhype.me, where legends are made up." |
| `share_copy_web_share_title_template` | `{name} on overhype.me` |
| `share_copy_web_share_text_template` | `{fact_text}` |

Supported template variables (documented inline in `routes/shareCopy.ts`):
`{name}`, `{fact_text}`, `{permalink}`. `{name}` is the meme creator's
display name (the SUBJECT of the meme — the recipient sees "look at
this meme of {name}", not "{sender} sent this to you").

Confirm migration applied:

```bash
pnpm --filter @workspace/db run migrate
psql $DATABASE_URL -c "\d share_intents" | head -20
psql $DATABASE_URL -c "SELECT key FROM admin_config WHERE key LIKE 'share_copy_%' ORDER BY key;"
```

Expected: the table exists with three indexes and a CHECK constraint;
six rows are returned by the SELECT.

If someone reports the share modal failing at runtime with a 500 from
`/api/share-copy/...` or `/api/share-intents`, the first thing to check
is whether the migration is current.

---

## Reading the output

Each `node --test` run prints a TAP-style stream. The summary at the
bottom is the source of truth:

```
# tests 11
# pass  11
# fail  0
```

Each vitest run prints a summary line:

```
Test Files  21 passed (21)
Tests       381 passed (381)
```

If `# fail` is > 0, scroll up for the first `not ok N — <name>` block;
each one carries a `location:` and a stack trace. For vitest, the failed
test name is printed in red with a `RUN  src/components/share/__tests__/<file>` prefix.

---

## When to re-run

- Before pushing to `claude/setup-overhype-project-O4p1p` or any branch
  that touches:
  - `artifacts/api-server/src/routes/shareCopy.ts`
  - `artifacts/api-server/src/routes/shareIntents.ts`
  - `artifacts/api-server/src/routes/index.ts` (router registration)
  - `artifacts/overhype-me/src/components/share/**`
  - `artifacts/overhype-me/src/pages/MemePage.tsx` (modal wiring)
  - `lib/db/src/schema/shareIntents.ts`
  - `lib/db/migrations/0052_share_intents.sql`
- After every PR review of Phase-6-adjacent changes.
- After any edit to the six `share_copy_*` admin_config rows in
  production: re-run the backend suite locally with the new template
  values copy-pasted into the test seed block to be sure substitution
  still produces the shape downstream callers expect.

---

## Pre-existing test noise (unrelated to Phase 6)

`tsc -p artifacts/api-server` reports two pre-existing errors that were
present on the branch baseline before Phase 6 landed (verified by
stashing Phase 6 edits and re-running tsc):

- `src/routes/memes.ts(8,32): error TS2307: Cannot find module 'nanoid'`
- `src/routes/memes.ts(906,30 / 906,63): error TS2339: Property 'updatedAt' does not exist on type ...`

Neither affects runtime — esbuild bundles `nanoid` regardless and
`updatedAt` is fetched but never used by the route handler. They do fail
the `pnpm typecheck` script. File these as a separate ticket; do not let
them block Phase 6 acceptance.

The frontend typecheck reports `Cannot find module '@testing-library/react'`
on test files in environments where `pnpm install` has not been run for
the `overhype-me` workspace. Run `pnpm install --filter @workspace/overhype-me`
to resolve.

---

## Reporting failures

If a Phase-6 layer fails, capture:

1. Which command failed and its full stderr/stdout.
2. The output of `pnpm --filter @workspace/db run migrate` — confirm
   `0052_share_intents.sql` is in the applied list.
3. The output of `psql $DATABASE_URL -c "SELECT key, substring(value, 1, 60) FROM admin_config WHERE key LIKE 'share_copy_%';"` —
   if any row is missing, the seed didn't apply; re-run the migration.
4. `pnpm --version` and `node --version` (Phase 6 was developed against
   Node 22 / pnpm 10).
5. For the frontend modal tests, the failing test name plus which spy
   (`shareSpy`, `openSpy`, `writeSpy`, `toastSpy`, `trackEventSpy`) was
   called incorrectly.

Phase 6 branch: `claude/setup-overhype-project-O4p1p`.
