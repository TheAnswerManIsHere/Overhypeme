# MBFO-1 — Automated test run

This is the engineering-side checklist for the Meme Builder Flow Overhaul,
Session 1 (the wizard shell + the `facts.split_token_index` migration). Hand
it to Replit (or run it locally) to confirm everything MBFO-1 introduced is
wired up correctly.

The User Acceptance Test is in [`MBFO_1_UAT.md`](./MBFO_1_UAT.md) — that one
is for the product owner to walk through in a browser.

---

## TL;DR

```bash
# 1. Apply migrations against the local/dev/test DB.
#    MBFO-1 adds 0053_facts_split_token_index.sql (single ALTER TABLE
#    adding a nullable integer column; no data backfill).
pnpm --filter @workspace/db run migrate

# 2. Validate the migration snapshot chain.
pnpm --filter @workspace/db run check-snapshots

# 3. Repo-wide typecheck (api-server, overhype-me, db, scripts).
pnpm typecheck

# 4. Run the new MBFO-1 frontend tests (18 cases across 2 suites) + the
#    full overhype-me suite to prove no regressions.
cd artifacts/overhype-me && pnpm exec vitest run

# 5. Run the db package tests (snapshot integrity + journal).
pnpm --filter @workspace/db test

# 6. Regression: prove a production build still emits cleanly with
#    the new lazy-loaded wizard module in the FactDetail chunk.
cd artifacts/overhype-me && pnpm exec vite build --config vite.config.ts

# 7. Boot smoke: confirm the dev server starts with the wizard flag on.
PORT=5180 BASE_PATH=/ VITE_MBFO_WIZARD=1 \
  pnpm --filter overhype-me exec vite --config vite.config.ts --host 127.0.0.1
# Look for `VITE vX.Y.Z ready in NNN ms`, then Ctrl-C.
```

Expected:

| Suite | Cases | Pass |
|---|---|---|
| `wizardStorage.test.ts` (vitest) | 9 | 9 |
| `MemeBuilderWizard.test.tsx` (vitest) | 9 | 9 |
| Existing overhype-me suites | 381 | 381 |
| `@workspace/db` snapshot tests (node --test) | 5 | 5 |
| `check-snapshots` script | — | 45 snapshots, 54 journal entries, chain valid |
| `vite build` | — | exits 0, builds in ~14s |

End-to-end runtime:

- Full vitest run: ~13 seconds.
- db package tests: ~600ms.
- Vite production build: ~14 seconds.
- Dev server boot (with flag): ~520ms to "ready".

---

## What it actually runs

| # | Layer | Command | What it proves |
|---|---|---|---|
| 1 | migration apply | `pnpm --filter @workspace/db run migrate` | `0053_facts_split_token_index.sql` applies cleanly; the `facts.split_token_index` column exists as `integer NULL`; nothing else changed. |
| 2 | snapshot chain | `pnpm --filter @workspace/db run check-snapshots` | The 0053 snapshot links to the prior 0052 head; no orphaned snapshot files, no journal divergence. |
| 3 | typecheck | `pnpm typecheck` | All wizard files (`components/meme-builder/wizard/**`) compile under strict mode. The schema edit to `lib/db/src/schema/facts.ts` compiles. The new lazy import + roleToTier wiring in `pages/FactDetail.tsx` compiles. |
| 4 | MBFO-1 frontend tests | `pnpm exec vitest run` | 18 new cases — see breakdown below. Plus 381 pre-existing tests across 21 files. |
| 5 | db tests | `pnpm --filter @workspace/db test` | 5 cases; journal/snapshot validators still pass with the new migration in place. |
| 6 | production build | `pnpm exec vite build` | Treeshake + bundle succeeds with the new lazy import; wizard chunk emitted (bundled into `FactDetail-*.js` since the flag gate is build-time-static when `VITE_MBFO_WIZARD` is unset). |
| 7 | dev boot smoke | `vite` with `PORT`, `BASE_PATH`, `VITE_MBFO_WIZARD` | Vite's config loader resolves; HMR pipeline initializes; `src/pages/FactDetail.tsx` transforms without errors. |

---

## What each MBFO-1 test file covers

### `wizardStorage.test.ts` *(new — vitest, jsdom)*

Location: `artifacts/overhype-me/src/components/meme-builder/wizard/__tests__/wizardStorage.test.ts`

| Suite | Cases | Asserts |
|---|---|---|
| round-trip | 1 | A full `PendingWizardState` fixture (`schemaVersion: 2`, factId, entryFlow, currentStep, artifactType, mode, stock source, aspectRatio, name, pronouns, textOptions, capturedAt) writes to sessionStorage and reads back byte-equal. |
| missing key | 1 | `restoreWizardState("nonexistent")` returns `null` without throwing. |
| 1-hour TTL | 1 | A row with `capturedAt = Date.now() - 61 minutes` returns null **and is cleared from storage as a side-effect** (so we don't accumulate dead drafts). |
| schemaVersion guard | 1 | A row with `schemaVersion: 1` (the v1 PendingBuilderState shape) is rejected as malformed for v2 readers. |
| malformed JSON | 1 | Invalid JSON in the storage slot returns null (does not throw). |
| factId isolation | 1 | Drafts for `fact-1` and `fact-2` do not bleed into each other; restoring each yields the correct artifactType. |
| key-prefix isolation from v1 | 1 | Writing a v1 `pending_meme_builder_v1::<factId>` value does not surface through the v2 reader (`pending_meme_wizard_v2::<factId>`). This is the contract that lets the Phase-3 builder and the wizard coexist. |
| explicit clear | 1 | `clearWizardState(factId)` removes the row; subsequent restore returns null. |
| complex shape | 1 | A video-artifact + self-upload + framingOffset + advancedOptions (`videoEngineId`, `videoLengthSeconds`, `videoResolution`) fixture round-trips intact. |

### `MemeBuilderWizard.test.tsx` *(new — vitest, jsdom, React Testing Library)*

Location: `artifacts/overhype-me/src/components/meme-builder/wizard/__tests__/MemeBuilderWizard.test.tsx`

| Suite | Cases | Asserts |
|---|---|---|
| Step 1 default render | 1 | Wizard mounts on Step 1; "What are we making?" heading and both `Image` / `Video` cards (queried by `aria-label`) are present. |
| back arrow on Step 1 | 1 | The back arrow is rendered for layout symmetry but its className contains `invisible` (so it occupies space without being interactive). |
| advance to Step 2 | 1 | Clicking the Image card transitions to Step 2: the "Build your meme" heading appears, the sticky-bottom `wizard-primary-action` is rendered, and the step container exposes `data-direction="forward"`. |
| back navigation preserves state | 1 | After advancing from Step 1 → Step 2 (Video) → back, the wizard is on Step 1, the previously selected Video card has `aria-pressed="true"`, and the container exposes `data-direction="back"`. |
| close button → onCancel | 1 | The Close (X) button in the top bar invokes the parent `onCancel` callback exactly once. |
| progress bar value | 1 | The ARIA `progressbar`'s `aria-valuenow` is `1` on Step 1 and `2` on Step 2 (with `aria-valuemin=1`, `aria-valuemax=2`). |
| sessionStorage persistence | 1 | Selecting an artifact on Step 1, unmounting, and remounting the wizard against the same factId hydrates directly into Step 2 (skipping Step 1). Verifies the auto-persist effect fired and the hydrate effect ran. |
| factId isolation in hydration | 1 | A draft saved against `fact-A` does NOT hydrate when the wizard remounts against `fact-B`. The new mount opens on Step 1. |
| expired draft is ignored | 1 | A draft with `capturedAt = Date.now() - 61 minutes` written directly to storage is ignored on hydrate; the wizard opens on Step 1 (and the stale row is cleaned up by the storage layer). |

---

## Migration verification

MBFO-1 adds **one migration**: `lib/db/migrations/0053_facts_split_token_index.sql`.

It performs a single, narrow DDL statement:

```sql
ALTER TABLE "facts" ADD COLUMN "split_token_index" integer;
```

That's it. No index, no NOT NULL, no default, no backfill. The column is
populated by a gpt-4o-mini call at fact-creation time in a **separate**
MBFO session; until that ships, the value is NULL for every row and
`render-fact.ts` keeps its midpoint-heuristic behavior.

Confirm migration applied:

```bash
pnpm --filter @workspace/db run migrate
psql "$DATABASE_URL" -c "\d facts" | grep split_token_index
```

Expected:

```
 split_token_index | integer                  |           |          |
```

(Type `integer`, no NOT NULL, no default — three blank columns after the
type.)

Confirm the snapshot chain is intact:

```bash
pnpm --filter @workspace/db run check-snapshots
```

Expected:

```
✓ All 54 journal entries have snapshot files (or are explicitly exempt).
✓ Snapshot chain is valid (45 snapshots, all prevId links correct).
```

If anyone reports a runtime regression after pulling MBFO-1, the first
thing to check is whether 0053 is in the applied-migrations list. The
migration is purely additive, so reverting only requires
`ALTER TABLE facts DROP COLUMN split_token_index;` — but please don't,
the value is referenced by typed schema and dropping it will break
typecheck. Treat 0053 as one-way.

---

## Feature-flag behavior

MBFO-1 ships the wizard behind a build-time flag:

```ts
const MBFO_WIZARD_ENABLED = import.meta.env.VITE_MBFO_WIZARD === "1";
```

defined in `artifacts/overhype-me/src/pages/FactDetail.tsx`. When unset
(the default), every entry through the fact detail page falls back to the
Phase-3 `MemeStudio` exactly as before — the wizard module is still
bundled (because `lazyWithRetry` defers the import), but no production
code path references it.

| `VITE_MBFO_WIZARD` | FactDetail meme-build button opens | Why |
|---|---|---|
| unset / `"0"` / anything else | `<MemeStudio>` (Phase-3 hub) | Production path unchanged |
| `"1"` | `<MemeBuilderWizard>` (MBFO wizard) | Development / preview |

To confirm both paths in CI without recompiling twice, just smoke the
default build (Replit doesn't need the wizard preview build) — the UAT
covers the flag-on path manually.

---

## Test infrastructure notes

- The frontend test suite runs under **vitest + jsdom + React Testing
  Library**. No `@testing-library/jest-dom` is configured for this
  workspace; the wizard tests intentionally use plain Chai matchers
  (`.toBeTruthy()`, `.toBe(...)`, `.toMatch(...)`) and DOM API
  (`.getAttribute(...)`, `.className.match(...)`) so they don't depend
  on jest-dom matchers that aren't loaded.
- Animation uses **framer-motion** (already in the bundle via
  `components/ui/Button.tsx`). Tests assert the deterministic
  `data-direction` attribute on the step container rather than poking
  at the animated transform, so they don't depend on animation timing.
- jsdom auto-provides `window.sessionStorage` — no mock is configured.
  Each test clears storage in `beforeEach`.

---

## Reading the output

Each vitest run prints a summary line:

```
Test Files  23 passed (23)
Tests       399 passed (399)
```

The two new files appear in the run as:

```
✓ src/components/meme-builder/wizard/__tests__/wizardStorage.test.ts (9)
✓ src/components/meme-builder/wizard/__tests__/MemeBuilderWizard.test.tsx (9)
```

Each `node --test` run prints a TAP-style stream. The summary at the
bottom is the source of truth:

```
# tests 5
# pass  5
# fail  0
```

If `# fail` is > 0, scroll up for the first `not ok N — <name>` block.
For vitest, the failed test name is printed in red with a
`RUN  src/components/meme-builder/wizard/__tests__/<file>` prefix.

---

## When to re-run

- Before pushing to `claude/setup-mbfo-context-FbqqB` or any branch
  that touches:
  - `artifacts/overhype-me/src/components/meme-builder/wizard/**`
  - `artifacts/overhype-me/src/pages/FactDetail.tsx` (the flag-gated
    mount)
  - `lib/db/src/schema/facts.ts`
  - `lib/db/migrations/0053_facts_split_token_index.sql`
  - `lib/db/migrations/meta/_journal.json`
  - `lib/db/migrations/meta/0053_snapshot.json`
- After every PR review of MBFO-adjacent changes.
- Before merging MBFO-1 (or its successors MBFO-2/3/4) into `main`.

---

## Pre-existing test / typecheck noise (unrelated to MBFO-1)

`pnpm typecheck` against the overhype-me workspace reports a handful of
pre-existing implicit-any warnings and `TS6305` "output file has not
been built" errors for `lib/api-client-react` / `lib/api-zod`. These
were present on the branch baseline before MBFO-1 landed (verified by
inspecting `src/pages/FactDetail.tsx` lines 5, 705, 719 — the
implicit-any sites are inside unrelated lambdas, and the line numbers
shift exactly by the size of the MBFO-1 import / conditional block).

None of them implicate any MBFO-1 file. If `pnpm typecheck` returns a
non-zero exit code in CI, confirm the file paths and line numbers are
in the pre-existing set above before flagging. Resolution path: run
`pnpm prepare` (or `pnpm --filter './lib/**' run build`) to populate
the missing `dist/` outputs.

---

## Reporting failures

If an MBFO-1 layer fails, capture:

1. Which command failed and its full stderr/stdout.
2. The output of `pnpm --filter @workspace/db run migrate` — confirm
   `0053_facts_split_token_index.sql` is in the applied list.
3. The output of `psql "$DATABASE_URL" -c "\d facts" | grep split_token_index` —
   if the column is missing, the migration didn't apply; re-run.
4. The output of `pnpm --filter @workspace/db run check-snapshots`.
5. For the wizard tests, the failing test name plus the rendered DOM
   from the first failure (vitest prints the failing component tree).
   The most useful diagnostic for navigation tests is whether
   `data-direction` is missing or has the wrong value on
   `[data-testid="meme-builder-wizard"]`.
6. `pnpm --version` and `node --version` (MBFO-1 was developed against
   Node 22 / pnpm 10).

MBFO-1 branch: `claude/setup-mbfo-context-FbqqB`.
