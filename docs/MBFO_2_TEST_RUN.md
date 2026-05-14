# MBFO-2 — Automated test run

This is the engineering-side checklist for the Meme Builder Flow Overhaul,
Session 2 (Step 1 image/video card picker, the `hero_examples` table +
`GET /api/hero-examples` endpoint, the `useVideoCardState` resolver, and
the `UnifiedUpgradeModal` stub). Hand it to Replit (or run it locally) to
confirm everything MBFO-2 introduced is wired correctly.

The User Acceptance Test is in [`MBFO_2_UAT.md`](./MBFO_2_UAT.md) — that
one is for the product owner to walk through in a browser.

The MBFO-1 equivalent of this doc lives in
[`MBFO_1_TEST_RUN.md`](./MBFO_1_TEST_RUN.md). Most of the conventions are
the same.

---

## TL;DR

```bash
# 1. Apply migrations against the local/dev/test DB.
#    MBFO-2 adds 0054_hero_examples.sql (one new table + one index +
#    a CHECK constraint on artifact_type). No data backfill.
pnpm --filter @workspace/db run migrate

# 2. Validate the migration snapshot chain.
pnpm --filter @workspace/db run check-snapshots

# 3. Repo-wide typecheck.
pnpm typecheck

# 4. Run the new MBFO-2 frontend tests + the full overhype-me suite to
#    prove no regressions.
cd artifacts/overhype-me && pnpm exec vitest run

# 5. Run the api-server hero-examples integration test.
cd artifacts/api-server && \
  DATABASE_URL="postgres://overhype:overhype@localhost:5432/overhype_test" \
  TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
  node --import tsx/esm --test src/__tests__/routes.heroExamples.test.ts

# 6. Run the db package tests (snapshot integrity + journal).
pnpm --filter @workspace/db test

# 7. Regression: confirm a production build still emits cleanly.
cd artifacts/overhype-me && pnpm exec vite build

# 8. Boot smoke: confirm the dev server starts with the wizard flag on.
PORT=5180 BASE_PATH=/ VITE_MBFO_WIZARD=1 \
  pnpm --filter overhype-me exec vite --config vite.config.ts --host 127.0.0.1
```

If everything above is green, you can stop. The sections below break
each step out in detail in case anything fails.

---

## A — Setup gate

Run before each test pass. These are environment checks, not behavior
checks.

### A1. Test DB is up

The session-start hook brings up Postgres on `:5432` and applies the
schema. Confirm with the line in the boot log:

> `Test DB ready at postgres://overhype:overhype@localhost:5432/overhype_test`

If it isn't there, re-run the hook or start the cluster manually before
any DB-touching test will work.

### A2. Migration applied

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test \
  -c "\d hero_examples"
```

Pass criterion: a 9-column table with these columns and types:

| Column          | Type                       | Nullable |
|-----------------|----------------------------|----------|
| id              | integer (serial)            | NO       |
| artifact_type   | varchar(8) + CHECK          | NO       |
| asset_url       | text                        | NO       |
| poster_url      | text                        | YES      |
| caption_label   | text DEFAULT ''             | NO       |
| sort_order      | integer DEFAULT 0           | NO       |
| active          | boolean DEFAULT true        | NO       |
| created_at      | timestamptz DEFAULT now()   | NO       |
| updated_at      | timestamptz DEFAULT now()   | NO       |

Plus one btree index `idx_hero_examples_type_active_sort` on
`(artifact_type, active, sort_order)` and a CHECK constraint on
`artifact_type IN ('image','video')`.

### A3. Schema chain valid

```bash
pnpm --filter @workspace/db check-snapshots
```

Pass criterion (output):

> `✓ All 55 journal entries have snapshot files (or are explicitly exempt).`
> `✓ Snapshot chain is valid (46 snapshots, all prevId links correct).`

### A4. DB unit tests

```bash
pnpm --filter @workspace/db test
```

Pass criterion: 5 tests pass, 0 fail.

### A5. Production build

```bash
cd artifacts/overhype-me && pnpm exec vite build
```

Pass criterion: exits 0. The Vite bundle warning about chunk size is
unrelated to MBFO-2 and is not a regression.

---

## B — Vitest suite (frontend)

```bash
cd artifacts/overhype-me && pnpm exec vitest run
```

Expected: **27 files / 428 tests pass, 0 fail**.

If the full suite is too noisy to scan, the targeted re-runs below
exercise just the MBFO-2 surface.

### B1. Step 1 card behavior

```bash
pnpm exec vitest run src/components/meme-builder/wizard/steps/Step1ArtifactType
```

Pass criterion: 11 tests pass. The matrix exercised:

- Image card tappable for all three tiers
- Video card crown + chrome present in every tier state
- Unregistered + Registered: video card renders the locked overlay
  with "Go Legendary to unlock" copy
- Unregistered + Registered: clicking the locked video card opens the
  upgrade modal and does NOT call `onSelect`
- Legendary: video card has no overlay, click calls `onSelect("video")`
- Empty hero set: image + video placeholders render

### B2. Video-card state resolver

```bash
pnpm exec vitest run src/components/meme-builder/wizard/state/useVideoCardState
```

Pass criterion: 6 tests pass. Covers all six tier × budget cells of
`resolveVideoCardState`, including the defensive case (a stale
`videoBudget=allowed` should never override a non-Legendary tier).

### B3. Hero examples hook

```bash
pnpm exec vitest run src/components/meme-builder/wizard/data/useHeroExamples
```

Pass criterion: 5 tests pass. Covers loading state, empty response,
random pick using injected randomizer, **stable pick across re-renders
within one mount**, and surfaced fetch errors.

### B4. Upgrade modal

```bash
pnpm exec vitest run src/components/upgrade/UnifiedUpgradeModal
```

Pass criterion: 6 tests pass. The CTA navigation test stubs the
`upgradeNavigation.go` seam (jsdom won't let us redefine
`window.location.assign`); MBFO-5 will replace that seam with Stripe
Embedded Checkout.

### B5. Wizard shell regression

```bash
pnpm exec vitest run src/components/meme-builder/wizard/__tests__/MemeBuilderWizard
```

Pass criterion: all pass. Two tests changed in MBFO-2:

- The headline regex was updated from `/what are we making/i` to
  `/what kind of meme/i` (matching the new spec).
- The video round-trip test now uses a Legendary `viewerContext` so
  the video card is tappable (free/anon would open the upgrade modal
  instead of advancing).

---

## C — API server tests

Run from `artifacts/api-server`:

```bash
DATABASE_URL="postgres://overhype:overhype@localhost:5432/overhype_test" \
TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
node --import tsx/esm --test src/__tests__/routes.heroExamples.test.ts
```

Pass criterion: **7 tests pass**. The matrix:

| #  | Endpoint contract                                                   |
|----|---------------------------------------------------------------------|
| C1 | Empty table → `{ image: [], video: [] }`                            |
| C2 | Inactive rows excluded                                              |
| C3 | Ordering: `sort_order` ASC, then `id` ASC                           |
| C4 | `?artifact_type=video` → only `video` key in the response           |
| C5 | `?artifact_type=audio` → HTTP 400                                   |
| C6 | DTO shape: `{ id, artifactType, assetUrl, posterUrl, captionLabel }`|
| C7 | Row cap: ≤10 per type, even if 12 active rows are seeded            |

Cleanup is automatic — the test prefixes asset URLs with `t2he` and
deletes them in `before`/`after`/`beforeEach`.

To rule out cross-test contamination, also run the route alongside the
share-related routes:

```bash
node --import tsx/esm --test \
  src/__tests__/routes.heroExamples.test.ts \
  src/__tests__/routes.shareIntents.test.ts \
  src/__tests__/routes.share.test.ts
```

Expected: 27 tests pass.

---

## D — Dev server smoke (Replit-specific)

```bash
cd artifacts/overhype-me && VITE_MBFO_WIZARD=1 pnpm dev
```

### D1. Dev server boots cleanly

Watch the boot log for `ready in <1s` or similar (typically ~520ms on
Replit's hardware). No `[vite] error` lines.

### D2. Wizard route renders

In a separate shell, hit a fact route:

```bash
curl -s http://localhost:5180/f/<any-active-fact-slug> | grep -c "data-testid"
```

The HTML response is the unhydrated SPA shell, so `data-testid` markers
won't appear in the raw response — open the URL in a browser to verify
hydration end-to-end. (Browser-side checks live in
[`MBFO_2_UAT.md`](./MBFO_2_UAT.md).)

### D3. Hero examples endpoint reachable

```bash
curl -s http://localhost:<api-port>/api/hero-examples
```

Pass criterion (clean DB): `{"image":[],"video":[]}`.

### D4. Type filter on endpoint

```bash
curl -s http://localhost:<api-port>/api/hero-examples?artifact_type=image
```

Pass criterion: `{"image":[]}` — note the absence of the `video` key
when the filter is set.

### D5. Invalid type rejected

```bash
curl -i http://localhost:<api-port>/api/hero-examples?artifact_type=foo
```

Pass criterion: HTTP 400 with a JSON body listing the valid options
(`image, video`).

---

## E — Seed-and-fetch round-trip

This proves the whole data path (insert → query → response shape)
works against a non-empty table.

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test <<SQL
INSERT INTO hero_examples (artifact_type, asset_url, caption_label, sort_order)
VALUES
  ('image', 'https://example.com/img-demo.jpg', 'Image meme', 1),
  ('video', 'https://example.com/vid-demo.mp4', 'Video meme', 1);
SQL

curl -s http://localhost:<api-port>/api/hero-examples | jq
```

Pass criterion: response shows both rows with the expected DTO fields
(`id`, `artifactType`, `assetUrl`, `posterUrl`, `captionLabel`).

Clean up afterward:

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test \
  -c "DELETE FROM hero_examples WHERE asset_url LIKE 'https://example.com/%';"
```

---

## F — Feature flag off-state (regression)

```bash
cd artifacts/overhype-me && pnpm dev   # NO VITE_MBFO_WIZARD
```

| #  | Check                          | Pass criterion                                                      |
|----|--------------------------------|---------------------------------------------------------------------|
| F1 | Production path unchanged      | `FactDetail` mounts the Phase-3 `MemeStudio`, not the wizard        |
| F2 | `/api/hero-examples` reachable | The endpoint is independent of the flag and still responds          |

The detailed in-browser regression walk-through is the flag-OFF half
of [`MBFO_2_UAT.md`](./MBFO_2_UAT.md), section A.

---

## G — Adjacent feature regression smoke

| #  | Area                              | Check                                                       |
|----|-----------------------------------|-------------------------------------------------------------|
| G1 | Share modal (Phase 6)             | `pnpm exec vitest run src/components/share` — all pass      |
| G2 | Existing meme builder (Phase 3)   | `pnpm exec vitest run src/components/meme-builder/__tests__` — all pass |
| G3 | Wizard shell from MBFO-1          | `pnpm exec vitest run src/components/meme-builder/wizard/__tests__` — all pass |

---

## What MBFO-2 explicitly does NOT ship

These are deliberately out of scope and will appear in subsequent
sessions. If you hit them while testing, that's expected — not a
failure:

- **`/api/me/video-budget` endpoint.** Deferred to MBFO-4. The
  `useVideoCardState` resolver therefore treats every Legendary user
  as `tappable`. The "Budget reached — resets {date}" overlay
  (`CardBudgetReached.tsx`) exists but is unreachable until the budget
  snapshot is plumbed.
- **Stripe Embedded Checkout in the upgrade modal.** Deferred to
  MBFO-5. Today the CTA calls `upgradeNavigation.go("/pricing")`,
  which is a full-page redirect.
- **Curated hero example assets.** The `hero_examples` table ships
  empty. Cards render a brand-orange placeholder with "Example coming
  soon" microcopy. Admin tooling to populate the table is a follow-up.
- **Step 2 internals.** Still the placeholder from MBFO-1. Real Step 2
  lands in MBFO-3.
- **Generation paths.** PuLID, Grok Imagine, and auto-subtitle aren't
  invoked from the wizard yet (MBFO-3 / MBFO-4).

---

## Known divergences from the shared MBFO context

Re-stating what was flagged at PR-merge time so future sessions don't
re-litigate:

- Tier strings in code use `unregistered / registered / legendary` (the
  app's existing `useAuth().role` vocabulary), not `anonymous / free /
  legendary` from the brief.
- `CardBudgetReached` is scaffolded but unreachable — see above.
- `UnifiedUpgradeModal` is a stub — see above.
- The branch this work shipped on was
  `claude/setup-mbfo-wizard-jPpo0` (per harness mandate), not `mbfo`.
