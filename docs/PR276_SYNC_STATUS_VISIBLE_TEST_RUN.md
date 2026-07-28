# PR #276 — A failed Stripe sync stays visible — TEST_RUN

Engineering checklist for Replit. Scoped to what **only this environment can
verify** — the pre-merge gates below already passed in CI and locally, so they
compress to one line rather than being re-run item by item.

Companion in-app acceptance test:
[`PR276_SYNC_STATUS_VISIBLE_UAT.md`](PR276_SYNC_STATUS_VISIBLE_UAT.md).

## What changed, in one paragraph

The admin Billing page's Stripe sync panel rendered only while a run was in
flight, so a failed sync's persisted error was fetched and then discarded on
page load. The gate now fires as soon as status has loaded, a new pure module
derives an honest summary line, and the e2e spec is re-anchored from Tailwind
class signatures onto `data-testid`. Frontend only — **no schema change, no
migration, no backend change, no API change.**

## Already green — do not re-run

`tsc -b`, the full frontend Vitest suite (85 files / 875 tests),
`check-docs-accuracy`, and `check:codegen-drift` all pass locally and in CI.
Nothing below re-verifies them.

## 1. Repo health after merge

- [ ] `pnpm install` completes on the merged tree.
- [ ] The app builds and the admin Billing page loads without a console error.

## 2. The e2e spec — the part that could not run in the container

This is the main reason this doc exists. `adminBillingSync.spec.ts` needs a
live server **and** the real test-mode Stripe account, so its assertions are
unexecuted so far. It also has two new steps and rewritten locators.

- [ ] `pnpm --filter @workspace/overhype-me run e2e adminBillingSync`

Confirm specifically:

- [ ] **The pre-existing steps still pass after the locator rewrite.** They now
      anchor on `data-testid` instead of class signatures. Worth knowing: the
      old selector filtered on `span.font-medium.w-20` while the page renders
      `w-32`, so `progressRow` had been matching **nothing** and
      `statusTextFor` was silently returning `""`. If a previously-"passing"
      assertion now fails, that is this latent bug surfacing — report it rather
      than loosening the locator.
- [ ] **New step: "a failed sync is still visible after a full page reload."**
      Drives the dev-only `POST /api/admin/stripe/sync/_test/simulate` with
      `{ failResource: "plans" }`, then calls `page.reload()` and asserts the
      panel, the errored row, and the red summary all survive. **This is the
      regression the whole PR exists for** — if only one thing gets run, run
      this.
- [ ] **New step: "an all-idle status still renders, as the never-synced
      state."** Stubs the status endpoint with eight `idle` resources and
      asserts an amber `never` summary rather than a hidden panel.

## 3. Against live config and data

Things the container's fixtures can't tell us.

- [ ] Load Admin → Billing **cold** (no sync triggered this session). The panel
      renders with the real last-run state — not blank, not a spinner.
- [ ] The **"· Last synced"** stamp in the Plans header matches the newest
      per-resource timestamp in `stripe._sync_status`. It's derived from those
      rows rather than from the in-process lock, so confirm it's still correct
      **after a server restart** — that's the case the old code got wrong.
- [ ] Run a real **Sync Stripe data** against the live test-mode account and
      confirm the summary goes green and the row counts are plausible.
- [ ] Confirm the summary reports the true state when `stripe._sync_status`
      holds a **mix** — some `complete`, at least one `error`. Expected: red
      summary, not green, even though most rows are ✓.

## 4. Targeted test files

Scoped to the touched surfaces; the full sharded suite is **not** needed here
— this PR touches no shared infrastructure.

- [ ] `pnpm --filter @workspace/overhype-me run test src/pages/admin/syncStatusSummary.test.ts`
- [ ] `pnpm --filter @workspace/overhype-me run test src/pages/admin/`

## 5. Database

**Nothing to do.** No migration, no schema change, no backfill. This PR reads
`stripe._sync_status` through the existing `/admin/stripe/sync/status`
endpoint, which is unchanged.

If `stripe._sync_status` happens to be empty on this environment, that's the
never-synced state and should render amber — see the UAT's item 5.

## Report back

For each unchecked box: the command, the actual output, and whether it looks
like a real failure or an environment issue. For the e2e steps specifically,
note **which** step failed — the reload regression and the all-idle case are
new, the rest are pre-existing behavior under new locators, and that
distinction tells us where to look.
