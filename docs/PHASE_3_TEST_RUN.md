# Phase 3 — Automated test run

This is the engineering-side checklist. Hand it to Replit (or run it
locally) to confirm everything Phase 3 introduced is wired up correctly.

The User Acceptance Test is in [`PHASE_3_UAT.md`](./PHASE_3_UAT.md) — that
one is for you to walk through manually in a browser.

---

## TL;DR

```bash
bash scripts/phase3-smoke.sh
```

That single command runs all five verification layers in order and exits
non-zero on the first failure. Expected runtime end-to-end: 60–90 seconds.

If you're somewhere without a Postgres handy:

```bash
bash scripts/phase3-smoke.sh --skip-server
```

This skips only the api-server integration tests; everything else still
runs.

---

## What it actually runs

| # | Layer | Command | What it proves |
|---|---|---|---|
| 1 | lib type build | `pnpm typecheck:libs` | Cross-package imports compile cleanly. |
| 2 | studio wiring static check | `grep` over `MemeStudio.tsx` | The studio imports the **new** `meme-builder/MemeBuilder` and does **not** import the legacy `@/components/MemeBuilder`. Fails fast if someone reverts the wiring. |
| 3 | drizzle journal | `pnpm --filter @workspace/db check-snapshots` | Migration `0048_meme_builder_lineage` is registered and the snapshot chain is intact. |
| 4 | repo typecheck | `pnpm typecheck` | api-server, overhype-me, mockup-sandbox, scripts all type-check. No `any` regressions in new code. |
| 5 | db migrate test | `pnpm --filter @workspace/db test` | The migration runner applies through 0048 without errors against a fresh DB. |
| 6 | api-server tests | `cd artifacts/api-server && pnpm test` | `phase3.lineage.integration.test.ts` exercises the migration columns + indexes + `/users/me/uploads` filters against the real test DB. Other suites must still pass. |
| 7 | overhype-me tests | `cd artifacts/overhype-me && pnpm test` | 206 vitest cases across 15 files, including the five Phase-3 specs: `behaviorMatrix.test.ts` (30 cells), `pendingBuilderState.test.ts` (sessionStorage TTL + schema-version rejection), `useDebouncedValue.test.ts` (debounce timing under fake timers), `useUploadModeration.test.ts` (4 upload error classes), and `studioAdapter.test.ts` (path → mode + role → tier + avatar URL → object_path). |

---

## Prerequisites

- Repo cloned and on the working branch.
- `pnpm install` has been run at least once.
- For step 5 only: a working Postgres reachable via `$DATABASE_URL`. The
  test DB doesn't need any seed data — the migration runner sets it up.
  In Replit's dev container the `setup-test-db` SessionStart hook already
  prepares this for you.

---

## What each Phase-3 test covers

### `phase3.lineage.integration.test.ts`  *(new — server)*

| It-block | Asserts |
|---|---|
| migration added `image_transform` to memes | Column exists, `varchar(24)`. |
| migration added all four lineage columns to `upload_image_metadata` | `transform`, `source_object_path`, `fact_id`, `transform_params_hash` all present. |
| dedup index exists with the expected predicate | `IDX_uim_pulid_dedup` exists and is filtered on `transform = 'pulid'`. |
| inserts a raw upload then a PuLID derivative | Round-trips both rows via Drizzle, lineage fields land correctly. |
| rejects an invalid `transform` value | CHECK constraint `uim_transform_chk` fires. |
| `GET /users/me/uploads` (no params) | Returns only raw uploads (the default — backwards-compatible). |
| `?transform=ai` | Returns both `pulid` and `pulid_fallback_text` rows. |
| `?transform=pulid&factId=N` | Scopes derivatives to fact N only. |
| `?transform=all` | Returns raw + AI rows together. |
| Response shape | New fields (`transform`, `sourceObjectPath`, `factId`, `transformParamsHash`) appear on every row. |
| `memes.image_transform` | Accepts `NULL`, `'pulid'`, `'pulid_fallback_text'`; rejects garbage via CHECK. |

### `behaviorMatrix.test.ts`  *(new — frontend)*

Asserts every cell of the 30-row (mode, tier, entryFlow) matrix:

- All 5 self-upload × unregistered rows are invalid → tier-locked panel
  with the expected upgrade target.
- stock × unregistered shows download + signup CTA only (never save / share).
- stock × registered unlocks save + share.
- stock × legendary additionally surfaces "Try AI mode".
- self-upload × legendary gates the stylize toggle.
- self-upload × registered does NOT show the stylize toggle.
- Header copy keys map correctly per entryFlow.
- `postSave` resolves to share | back-to-fact | none per the rules.
- `enumerateMatrix()` produces exactly 30 rows.

### `pendingBuilderState.test.ts`  *(new — frontend)*

- Round-trips a fixture exactly through sessionStorage.
- Returns null when nothing is captured.
- Drops entries older than 1 hour AND clears the stale row.
- Ignores rows with the wrong `schemaVersion`.
- Survives a self-upload + stylize source.

### `useDebouncedValue.test.ts`  *(new — frontend)*

- Initial value is returned immediately.
- Updates are delayed by exactly the configured ms (`vi.useFakeTimers`).
- Rapidly changing input only commits the final value once — i.e. the
  picker debounce will not spam render-preview.

### `useUploadModeration.test.ts`  *(new — frontend)*

- Invalid format → no network call.
- Oversized file → no network call.
- HTTP 422 → `error: 'rejected'` (generic copy, no classifier leak).
- HTTP 503 → `error: 'network'`.
- HTTP 200 → `status: 'ready'`, `image.objectPath` populated.

### `studioAdapter.test.ts`  *(new — frontend, covers the wiring)*

The pure helpers `MemeStudio.tsx` uses to bridge from its path-based
prop surface to the new `MemeBuilder`'s (mode, tier, viewerContext)
interface. Extracted from `MemeStudio.tsx` so the mapping logic can be
unit-tested without mounting React.

- `studioPathToMode`: `stock-image` and `gradient-image` (deprecated
  soft-redirect) → `'stock'`; `photo-image` and `ai-gallery` →
  `'self-upload'`.
- `roleToTier`: `anonymous`/`unregistered` → `unregistered`; `registered`
  passthrough; `legendary`/`admin` → `legendary`; unknown defaults
  defensively to `unregistered`.
- `extractObjectPath`: returns `undefined` for null / external URLs;
  strips `/api/storage/objects/` prefix and returns `/objects/<rest>`;
  handles fully-qualified `https://overhype.me/api/storage/...` URLs.

---

## Reading the output

Each smoke-script step prints a banner and a `✓` or `✗`. The summary line
at the end tells you how many of the six layers passed.

If any layer fails:

1. Note which one — the layers are **independent** and run in order, so
   the first failure is the root cause.
2. Re-run **just that layer** for a faster feedback loop. The "What it
   actually runs" table above maps each layer to its individual command.

---

## When to re-run

- Before pushing to `claude/setup-overhype-project-GDzfb` or any branch
  that touches `lib/db/migrations/`, `lib/db/src/schema/`,
  `artifacts/api-server/src/routes/users.ts`,
  `artifacts/api-server/src/lib/factImagePipeline.ts`, or anything under
  `artifacts/overhype-me/src/components/meme-builder/`.
- On every PR review of Phase-3-adjacent changes.
- Once after `pnpm install` if the lockfile changed.

---

## Known noise

- `pnpm install` may print "Ignored build scripts: @sentry/cli, sharp" —
  this is the Phase-1 install warning; it does not affect Phase-3 tests.
- `[time-limit] command took XXXXms` lines come from
  `scripts/with-time-limit.sh`. They're informational; only a non-zero
  exit code indicates a failure.
