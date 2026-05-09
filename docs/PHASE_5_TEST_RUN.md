# Phase 5 — Automated test run

This is the engineering-side checklist for the meme detail page CTA
matrix, the `/api/og/m/:slug` Open Graph endpoint, and the Cloudflare
Worker that fronts `overhype.me/m/*`. Hand it to Replit (or run it
locally) to confirm everything Phase 5 introduced is wired up correctly.

The User Acceptance Test is in [`PHASE_5_UAT.md`](./PHASE_5_UAT.md) — that
one is for the product owner to walk through in a browser.

The deploy runbook is in [`PHASE_5_DEPLOY.md`](./PHASE_5_DEPLOY.md).

---

## TL;DR

```bash
# 1. Apply migrations against the local/dev/test DB.
pnpm --filter @workspace/db run migrate

# 2. Repo-wide typecheck (api-server, overhype-me, scripts, og-router).
pnpm typecheck

# 3. Run the new Phase-5 backend test (5 cases).
cd artifacts/api-server && \
  BCRYPT_SALT_ROUNDS=4 TEST_DB_ALLOW_EXIT_ON_IDLE=1 \
  RESEND_API_KEY="re_test_dummy" CRON_SECRET=test \
  node --import tsx/esm \
       --experimental-test-isolation=none --test-concurrency=1 --test \
       'src/__tests__/phase5.*.test.ts'

# 4. Run the new Phase-5 frontend tests (21 cases) +
#    the full overhype-me suite to prove no regressions.
cd ../overhype-me && pnpm exec vitest run

# 5. Regression: the existing memes routes + Phase-4 suites must still
#    pass under the extended /api/memes/:slug response shape and the
#    /m/ permalink rename.
cd ../api-server && \
  BCRYPT_SALT_ROUNDS=4 TEST_DB_ALLOW_EXIT_ON_IDLE=1 \
  RESEND_API_KEY="re_test_dummy" CRON_SECRET=test \
  node --import tsx/esm \
       --experimental-test-isolation=none --test-concurrency=1 --test \
       'src/__tests__/routes.memes.test.ts' \
       'src/__tests__/phase4.*.test.ts'
```

Expected:

| Suite | Cases | Pass |
|---|---|---|
| `phase5.og.routes.test.ts` | 5 | 5 |
| `useViewerCell.test.ts` (vitest) | 13 | 13 |
| `CTABar.test.tsx` (vitest) | 8 | 8 |
| Existing overhype-me suites | 206 | 206 |
| `routes.memes.test.ts` | 23 | 23 |
| `phase4.*.test.ts` | 41 | 41 |

End-to-end runtime:

- Backend Phase-5 suite: ~1 second against a warm Postgres.
- Full vitest run: ~7 seconds.
- Phase-4 + memes regression: ~4 seconds.

---

## What it actually runs

| # | Layer | Command | What it proves |
|---|---|---|---|
| 1 | repo typecheck | `pnpm typecheck` | api-server, overhype-me, mockup-sandbox, scripts type-check. The new `routes/og.ts`, `pages/MemePage.tsx`, `pages/memePage/*`, and the Cloudflare worker (`cloudflare/og-router/`) all compile under strict mode. |
| 2 | Phase-5 backend | `node --test 'src/__tests__/phase5.*.test.ts'` | 5 cases — see breakdown below. |
| 3 | Phase-5 frontend | `pnpm exec vitest run` | 21 new cases (`useViewerCell`, `CTABar`) plus 206 pre-existing. The Phase-5 cases live in `src/__tests__/useViewerCell.test.ts` and `src/__tests__/CTABar.test.tsx`. |
| 4 | regression: memes routes | `node --test 'src/__tests__/routes.memes.test.ts'` | The extended `/api/memes/:slug` response shape (now includes `createdById`, `isNsfw`, `imageTransform`, `imageSource`) and the `permalinkUrl: /m/<slug>` change do not break any existing assertions. 23 cases. |
| 5 | regression: Phase 4 | `node --test 'src/__tests__/phase4.*.test.ts'` | The save-path test suite still passes, including the asserter that POST `/api/memes` returns `permalinkUrl: /m/<slug>` (was `/meme/<slug>` pre-Phase-5). 41 cases. |

---

## What each Phase-5 test file covers

### `phase5.og.routes.test.ts` *(new — supertest + Postgres)*

| Suite | Cases | Asserts |
|---|---|---|
| `live meme` | 2 | 200 + `Content-Type: text/html` + `Cache-Control: public, max-age=3600`; all `og:*` and `twitter:*` meta tags present including `og:type`, `og:site_name="overhype.me"`, `twitter:card="summary_large_image"`, `og:image:width/height` reflecting the meme's `aspect_ratio` (1080×1080 for square); HTML escaping of user-authored fields (creator displayName containing `<`, `>` is rendered as `&lt;`, `&gt;`). |
| `soft-deleted` | 1 | 410 with a generic OG card; the meme's image URL, fact text, and creator name MUST NOT appear in the response body. |
| `missing` | 1 | 404 with a generic OG card; standard tags still present so social previews on a dead link don't fall back to nothing. |
| `bot-relevant headers` | 1 | The endpoint is UA-agnostic — Twitterbot and a plain browser UA receive byte-identical bodies. UA-based routing happens at the Cloudflare Worker, not in this endpoint. |

### `useViewerCell.test.ts` *(new — pure unit, no React)*

| Cases | Asserts |
|---|---|
| 13 | All 7 `ViewerCell` outputs are reachable, including `legendary-own-stock` vs `legendary-own-pulid` (gated on `meme.imageTransform === "pulid"`); `pulid_fallback_text` is intentionally treated as non-pulid (the upsell stays); admin role collapses to legendary; ownership requires both viewer and meme to have IDs (a viewer with userId but a meme with `createdById === null` is `registered-other`, not `registered-own`); the anonymous-own-transient state requires `justCreated && !meme.createdById` so a logged-out visitor with the URL flag can't hijack a meme that already has a creator. |

### `CTABar.test.tsx` *(new — vitest + React Testing Library)*

| Cell | Asserts |
|---|---|
| `anon-other` | Inline name + pronoun form + "See it with your name" CTA; "Browse more facts" → `/library`; tier ladder (sign-up + Legendary teasers); no `make-this-about-me`, no `merch-wear`, no `turn-up-to-11`. Form submission calls `onOpenBuilder({ initialName, initialPronouns })`. |
| `anon-own-transient` | Primary `Save your meme — sign up free` invokes `onSignup`; secondary `Download` invokes `onDownload`; tier ladder visible; no remix CTAs. |
| `registered-own` | Two primaries (Download, Custom Share); legendary upsell card with **the actual creator name in the copy** ("see yourself in this meme like Alice…"); merch tertiary; no remix CTA. |
| `registered-other` | Primary `Make this fact about me`; "Browse more facts"; legendary upsell card mentioning the creator. |
| `legendary-own-stock` | Primary `Turn this up to 11`; secondary Download + Custom Share; merch tertiary. |
| `legendary-own-pulid` | `turn-up-to-11` is **absent** (the meme is already at 11); Download + Custom Share are primaries; merch tertiary. |
| `legendary-other` | Primary `Make this fact about me`; "Browse more facts"; **no** tier upsell (legendary users are already at the top). |

---

## Cloudflare Worker tests *(no automated test, by design)*

The worker is ~30 lines and consists of:

1. Path match against `^/m/([A-Za-z0-9_-]+)/?$`.
2. UA classification via `isbot()`.
3. `fetch()` rewrite to `/api/og/m/:slug` for bots; passthrough for humans.

There is no in-repo test for the worker because:

- The branching logic is trivial; testing it would mean stubbing
  `fetch` and asserting the request URL, which only proves the test
  setup itself works.
- The interesting integration is "does Cloudflare's edge actually route
  `/m/*` to this worker and call our origin"; that's a deploy-time
  concern, covered by `scripts/phase5-og-smoke.sh` post-deploy.

If the worker grows non-trivial logic (auth, A/B routing, rewriting
response bodies), add unit tests with `@cloudflare/vitest-pool-workers`
at that point — not preemptively.

---

## Smoke verification (post-deploy only)

After `pnpm worker:deploy` lands the worker on Cloudflare:

```bash
SLUG=<a-real-live-slug> BASE_URL=https://overhype.me \
  bash scripts/phase5-og-smoke.sh
```

The script `curl`s the OG endpoint with five crawler UAs and a plain
Chrome UA, asserting status code (200 / 404 / 410) and presence of
`og:image` in the body. The plain-Chrome call goes to the same endpoint
because the script tests the api-server directly — UA-based routing is
exercised in the **paste tests** in `PHASE_5_DEPLOY.md` (Twitter, Slack,
Discord, etc.) which actually flow through the Cloudflare edge.

---

## Migration verification

Phase 5 adds **no migrations**. The existing meme + fact + user schemas
are queried as-is. The only DB-level change is propagating three
already-stored columns (`created_by_id`, `is_nsfw`, `image_transform`)
through the API response.

If someone reports `/api/og/m/:slug` returning 500 with a query error,
make sure migrations are current:

```bash
pnpm --filter @workspace/db run migrate
```

The OG endpoint reads from `memes`, `facts`, and `users`; missing columns
on any of those will surface here first.

---

## Reading the output

Each `node --test` run prints a TAP-style stream. The summary at the
bottom is the source of truth:

```
# tests 5
# pass  5
# fail  0
```

Each vitest run prints a summary line:

```
Test Files  17 passed (17)
Tests       227 passed (227)
```

If `# fail` is > 0, scroll up for the first `not ok N — <name>` block;
each one carries a `location:` and a stack trace. For vitest, the failed
test name is printed in red with a `RUN  src/__tests__/<file>` prefix.

---

## When to re-run

- Before pushing to `claude/setup-overhype-project-g8QzX` or any branch
  that touches:
  - `artifacts/api-server/src/routes/og.ts`
  - `artifacts/api-server/src/routes/memes.ts` (response shape)
  - `artifacts/overhype-me/src/pages/MemePage.tsx`
  - `artifacts/overhype-me/src/pages/memePage/**`
  - `artifacts/overhype-me/src/components/meme-builder/MemeBuilder.tsx`
  - `artifacts/overhype-me/src/App.tsx` (the `/m/:slug` route)
  - `cloudflare/og-router/**`
- After every PR review of Phase-5-adjacent changes.
- Once after `pnpm install` if the lockfile changed (Phase 5 adds
  `isbot`, `wrangler`, and `@cloudflare/workers-types`).

---

## Pre-existing test noise (unrelated to Phase 5)

`tsc -p artifacts/api-server` reports
`error TS2304: Cannot find name 'generatedObjectPath'` at
`src/routes/memes.ts:1631`. This is on the branch before Phase 5 landed
(verified by stashing Phase 5 edits and re-running tsc). It does not
affect runtime — esbuild bundles the file regardless — but it does fail
the `pnpm typecheck` script. File this as a separate ticket; do not let
it block Phase 5 acceptance.

The Phase 4 testing notes about `--experimental-test-isolation=none`
vs `--test-isolation=none` and the `CRON_SECRET=test` requirement still
apply; this checklist already uses the working flags.

---

## Reporting failures

If a Phase-5 layer fails, capture:

1. Which command failed and its full stderr/stdout.
2. The output of `pnpm --filter @workspace/db run migrate` — confirm no
   pending migrations were missed.
3. `pnpm --version` and `node --version` (Phase 5 was developed against
   Node 22.22.2 / pnpm 10.33.0).
4. The CTA cell that's misbehaving, if it's a frontend regression.
   Provide the auth-state combo (anon / registered / legendary × own /
   other × stock-meme / pulid-meme / just_created flag) so the failing
   cell is unambiguous.

Phase 5 branch: `claude/setup-overhype-project-g8QzX`.
