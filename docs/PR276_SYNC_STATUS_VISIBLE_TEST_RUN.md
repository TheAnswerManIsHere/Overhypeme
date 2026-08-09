# PR #276 — A failed Stripe sync stays visible — TEST_RUN

Checklist for Replit (the technical safety net), run post-merge against the
live workspace. **Replit owns the DB connection** — no `DATABASE_URL` /
test-DB env is set anywhere in this doc.

Companion in-app acceptance test:
[`PR276_SYNC_STATUS_VISIBLE_UAT.md`](PR276_SYNC_STATUS_VISIBLE_UAT.md).

## What changed, in one paragraph

The admin Billing page's Stripe sync panel rendered only while a run was in
flight, so a failed sync's persisted error was fetched and then discarded on
page load. The gate now fires as soon as status has loaded, a new pure module
derives an honest summary line, and the e2e spec is re-anchored from Tailwind
class signatures onto `data-testid`. Frontend only — **no schema change, no
migration, no backend change, no API change.**

Pre-merge gates (install, typecheck, the full frontend Vitest suite,
`check-docs-accuracy`, `check:codegen-drift`) are assumed green — they all
passed locally and in CI on this exact code. **No test suites are re-run in
this checklist, full or targeted** — everything below is what CI genuinely
cannot see: a live server, the real test-mode Stripe account, and this
environment's live `stripe._sync_status` state.

## Repo-health gates (post-merge state — run always)

This PR has no migration or schema change, so no new `SNAPSHOT_EXEMPT_TAGS`
entries and no other new allow-list entries — but the gates below check the
*merged* state of `main`, not this PR specifically, so run them regardless.

- `pnpm --filter @workspace/db validate-snapshots` — expected: passes
  (matches CI's `build.yml`)
- `pnpm --filter @workspace/db check-snapshots` — expected: passes. New
  `SNAPSHOT_EXEMPT_TAGS` entries this PR added: none
- `node scripts/check-docs-accuracy.mjs` — expected: clean
- Other allow-list entries this PR added (`check-no-console.mjs`,
  `check-cycles.mjs`): none

## Live checks (run post-merge against the live app)

Two things below are genuine live writes, not read-only: the e2e spec (via
the dev-only simulate route) and the "Run a real Sync Stripe data" step. Run
them **in this order** — the e2e spec first, then the real sync — because the
real sync is also this checklist's restore path for what the e2e spec leaves
behind.

### A. The e2e spec — needs a live server and the real test-mode Stripe account

`adminBillingSync.spec.ts` cannot run in CI: it needs a live server **and**
the real test-mode Stripe account, so its assertions are unexecuted until
Replit runs them. It also has two new steps and rewritten locators.

**Live write, not read-only:** the new "still visible after reload" step
drives the dev-only `POST /api/admin/stripe/sync/_test/simulate` route, which
deletes and replaces this environment's `stripe._sync_status` rows for
`plans` and leaves that resource in a simulated error state — a real,
persistent mutation, not an observation. **Restore path:** run section B's
"Run a real Sync Stripe data" step immediately after this one; a real sync
overwrites the simulated rows with the account's actual state, which is the
correct end state regardless of what `stripe._sync_status` held before this
checklist started. Don't stop after the e2e spec without also running that
step.

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

### B. Against live config and data (read-only, except where noted)

Things the container's fixtures can't tell us. This PR reads
`stripe._sync_status` through the existing `/admin/stripe/sync/status`
endpoint, which is unchanged — there is no migration or backfill involved.

- [ ] Load Admin → Billing **cold** (no sync triggered this session). The panel
      renders with the real last-run state — not blank, not a spinner. If
      `stripe._sync_status` happens to be empty on this environment, that's
      the never-synced state and should render amber — see the UAT's item 5.
- [ ] The **"· Last synced"** stamp in the Plans header matches the newest
      per-resource timestamp in `stripe._sync_status`. It's derived from those
      rows rather than from the in-process lock, so confirm it's still correct
      **after a server restart** — that's the case the old code got wrong.
- [ ] **Live write, not read-only:** run a real **Sync Stripe data** against
      the live test-mode account and confirm the summary goes green and the
      row counts are plausible.
- [ ] Confirm the summary reports the true state when `stripe._sync_status`
      holds a **mix** — some `complete`, at least one `error`. Expected: red
      summary, not green, even though most rows are correct.

## Delete me

Transient — delete once the checklist has been run. The `_UAT.md` sibling is
the durable half.

## Report back

For each unchecked box: the command, the actual output, and whether it looks
like a real failure or an environment issue. For the e2e steps specifically,
note **which** step failed — the reload regression and the all-idle case are
new, the rest are pre-existing behavior under new locators, and that
distinction tells us where to look.
