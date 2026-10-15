# PR #276 — A failed Stripe sync stays visible — UAT

Your in-app acceptance test, David. This is the fix for the thing that
actually cost us four rounds of investigation on the "only Forever shows"
bug.

**The bug wasn't the pricing page.** The Stripe sync had failed, and the
admin Billing page threw the error away. It showed the failure only *while
a sync was running* — so the moment you reloaded the page, the error
vanished and you were left looking at *"1 product found · Last synced: 10m
ago"*, which reads exactly like everything is fine. The failure was
recorded in the database the whole time. Nothing displayed it.

Your catalog itself is already fixed — re-running the sync restored all
three plans. **This PR makes sure the next failure announces itself.**

Everything below is on **Admin → Billing**, in the **"Plans from Stripe"**
section. Nothing on this PR touches the customer-facing pricing page.

## Setup

None.

## Steps

### 1. The status panel is always there now, not just mid-sync

**Do:** Go to Admin → Billing and expand "Plans from Stripe" without
clicking anything else.

**Expect:** The per-resource panel — Products, Prices, Plans, Customers,
and so on — is visible, each with its own state, plus a coloured summary
line at the top. Previously this panel only appeared while a sync was
actively running, and vanished on reload — that disappearing act was the
bug.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminBillingSync.spec.ts:the sync status panel should render on load` — runs in CI against the fake Stripe driver (#566)

**Deferred:** #631 — 7b — on first load before any click, all eight rows, Products through Payment Methods, each carrying a data-status, and the sync-summary line carrying a data-tone — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

### 2. A green summary when the last sync worked

**Do:** Click "Sync Stripe data" and let it finish.

**Expect:** A green line reads *"Last sync completed …"* and *"Last synced
just now."* This button syncs three of the eight resource types, so the
line reads *"Last sync completed — 3 of 8 resources reported"* unless every
resource is already complete from an earlier full backfill, when it reads
*"Last sync completed successfully."* Both are a working sync (David,
2026-10-14).

**Lane:** ci

**Check:** `artifacts/overhype-me/src/pages/admin/syncStatusSummary.test.ts:all complete → ok, with the most recent stamp`

**Deferred:** #631 — 7b — after the Sync Stripe data run, the green sync-summary text equal to the one branch the CI fake state produces, 3 of 8 resources reported or completed successfully, asserted in full, then Last synced just now — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

### 3. The green summary survives a reload

**Do:** Reload the page.

**Expect:** The green line is still there, and still says it synced. It
doesn't revert to a bare product count.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/stripeSyncRunner.test.ts:surfaces stored row state (running / complete / error) and per-resource counts derived from the data tables`

**Deferred:** #631 — 7b — after a successful Sync Stripe data run and page.reload on the Billing page, sync-summary with data-tone ok and text Last sync completed, beyond the N products found count — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

### 4. A failed sync shows a red summary — the main event

**Do:** Cause a sync to fail (per the TEST_RUN doc, or ask Replit to run
the simulate step).

**Expect:** A red summary line reads *"Last sync failed — plans did not
complete: &lt;the actual Stripe error&gt;. Catalog data may be stale."*

**Lane:** ci

**Check:** `artifacts/overhype-me/src/pages/admin/syncStatusSummary.test.ts:an errored resource → error tone, naming the resource and its message`; `artifacts/overhype-me/e2e/adminBillingSync.spec.ts:a failed sync is still visible after a full page reload` asserts the rendered summary's error tone, Last sync failed and plans

**Deferred:** #631 — 7b — after the reload in the failure step, the sync-summary text containing plans did not complete: Simulated failure for testing, and Catalog data may be stale. — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

### 5. The Plans row itself shows the failure

**Do:** Look at the Plans row after the failed sync in the previous step.

**Expect:** It shows a red ✗ and the error text.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminBillingSync.spec.ts:failure path: simulated error on plans surfaces error icon + failure banner` — presentation evidence: the error is injected through the simulation route, not produced by Stripe

**Deferred:** #631 — 7b — the red cross icon on the failed resource row, only the data-status attribute and error text are asserted — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

### 6. The failure survives a reload

**Do:** Reload the page after the failed sync.

**Expect:** Both the red summary line and the Plans row's red ✗ are still
there. This is the entire point — before this PR both vanished on reload
and you'd see a cheerful product count instead.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminBillingSync.spec.ts:a failed sync is still visible after a full page reload` — presentation evidence, as step 5

**Deferred:** #631 — 7b — after the reload, the red cross icon on the failed Plans row, beyond its data-status and error text — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

### 7. The summary names which resource failed

**Do:** Read the summary line's wording after the failed sync.

**Expect:** It names which resource failed, so you know whether it's your
catalog (products/prices/plans) or something peripheral
(charges/invoices).

**Lane:** ci

**Check:** `artifacts/overhype-me/src/pages/admin/syncStatusSummary.test.ts:an errored resource → error tone, naming the resource and its message`; `artifacts/overhype-me/e2e/adminBillingSync.spec.ts:a failed sync is still visible after a full page reload` asserts the rendered summary names plans

### 8. A partial failure is reported as failed, not success

**Do:** Cause a sync to fail on one resource while succeeding on others.

**Expect:** The summary is red, not green, even though most rows show ✓.
The "Last synced" stamp still appears, because both facts matter —
something did sync, and something didn't; it should never round up to
"all good."

**Lane:** ci

**Check:** `artifacts/overhype-me/src/pages/admin/syncStatusSummary.test.ts:a partial run is reported as failed, never rounded up to success`; `artifacts/overhype-me/e2e/adminBillingSync.spec.ts:a failed sync is still visible after a full page reload` asserts the rendered error tone after Products and Prices completed

**Deferred:** #631 — 7b — the Last synced stamp still appearing on the red summary while other rows are complete — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

### 9. A never-synced install says so, in amber

**Do:** On a database that has never run a sync (mostly for the
engineering checklist — hard to arrange on your live install, since you've
synced plenty), look at the summary line.

**Expect:** An amber line reads *"Never synced — run a full sync to
populate the catalog."* It is amber and actionable, not a spinner and not
blank — "never ran" and "still working" must not look alike.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/pages/admin/syncStatusSummary.test.ts:all-idle with no stamps → never synced, not success`; `artifacts/overhype-me/e2e/adminBillingSync.spec.ts:an all-idle status still renders, as the never-synced state` asserts the rendered never tone and Never synced, from a stubbed all-idle status

**Deferred:** #631 — 7b — the amber line's actionable wording, run a full sync to populate the catalog — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

### 10. The "Last synced" stamp survives a server restart

**Do:** After a sync, have Replit restart the server (or come back after a
deploy), then reload Admin → Billing.

**Expect:** The "· Last synced: …" stamp in the Plans header is still
correct — it's read from each resource's own timestamp rather than from an
in-memory value that resets on restart.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/stripeSyncRunner.test.ts:preserves syncedCount across a simulated server restart (regression: counts survive process loss)`

**Deferred:** #631 — 7b — the plans-last-synced stamp reading Last synced: from per-resource lastSyncedAt when GET /api/admin/stripe/sync/status is stubbed as after a restart, finishedAt null — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`; #631 — 7b — GET /api/admin/stripe/sync/status, after _resetSyncRunnerForTests, still returning the seeded products row's lastSyncedAt non-null — `artifacts/api-server/src/__tests__/routes.adminStripeSync.test.ts`

## Regression

### R1. Sync Stripe data still animates and re-enables

**Do:** Click "Sync Stripe data".

**Expect:** Rows animate pending → syncing → ✓ as before; the button
disables then re-enables.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminBillingSync.spec.ts:intermediate transitions: rows progress pending → syncing… → complete in order` — the animation, under a controlled delay, on a run the simulate endpoint starts; `artifacts/overhype-me/e2e/adminBillingSync.spec.ts:failure path: simulated error on plans surfaces error icon + failure banner` asserts the button enabled again; `success path: a real sync drives all rows to complete` flips its label back, against the fake Stripe driver

**Deferred:** #631 — 7b — the rows passing pending, syncing… and complete for a run the Sync Stripe data click itself starts, not one the simulate endpoint started with its own status writes — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`; #631 — 7b — the Sync button being disabled while the run is in flight, only its re-enabling is asserted — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

### R2. Full sync still works across all resources

**Do:** Click "Full sync".

**Expect:** Same animation, across all eight resources.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/stripeSyncRunner.test.ts:full run invokes every tracked resource sequentially in SYNC_RESOURCES order`

**Deferred:** #631 — 7b — Full sync driving all eight resource rows to complete in the panel, beyond the runner's call order — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`; #631 — 7b — the rows passing syncing… before complete on the Billing page for a run the Full sync click starts, POST /api/admin/stripe/full-sync — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

### R3. The LIVE / TEST badge still shows the right mode

**Do:** Check the LIVE / TEST badge in the Plans header.

**Expect:** Still shows the right mode.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminBillingSync.spec.ts:Plans header should show TEST badge` — against the fake Stripe driver, which is test-mode only

**Deferred:** #631 — 7b — the plans-mode-badge reading LIVE, and no TEST, when /api/admin/config is stubbed with stripe_live_mode true, since the fake is test-mode only — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

### R4. The product count is still accurate

**Do:** Check the "N products found" count after a sync.

**Expect:** Still accurate.

**Lane:** ci

**Deferred:** #631 — 7b — the plans-count text reading 1 product found after Sync Stripe data, matching the fake fixture's one product — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

### R5. The product list still renders correctly

**Do:** Look at the product list below the panel.

**Expect:** Names, descriptions, and prices render as before.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminBillingSync.spec.ts:the fake fixture product should be listed` — the product name, against the fake Stripe driver

**Deferred:** #631 — 7b — the product list's description text, Fake Legendary membership, and the prices $4.99/month, $49.00/year and $99.00 one-time beside Legendary (fake) — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

### R6. The Setup Checklist rows are unchanged

**Do:** Check the Setup Checklist rows.

**Expect:** Unchanged by this PR.

**Lane:** ci

**Deferred:** #631 — 7b — the four Setup Checklist labels rendering, with Stripe products configured in dashboard and Membership prices available ticked for the fake catalog — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

### R7. Toggling live/test mode is unchanged

**Do:** Toggle live/test mode.

**Expect:** Behaves as it did before — untouched here.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/stripeModeToggle.test.ts:test 5c — a valid toggle still works end to end`

**Deferred:** #631 — 7b — on the Billing page, Switch to Live Mode with the PATCH to /api/admin/config/stripe_live_mode stubbed to 200 flipping the Stripe Mode chip to LIVE and the button to Switch to Test Mode — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

### R8. The customer pricing page is completely unchanged

**Do:** Open the customer `/pricing` page.

**Expect:** Completely unchanged. If anything differs, that's a bug — this
PR is admin-only.

**Lane:** ci

**Deferred:** #628 — Phase 10 (Membership and money) — the pricing page is rebuilt monthly-only there (F2), and no existing spec opens /pricing

## Not bugs

- **The Setup Checklist can still read green on a one-plan catalog.** Its
  "Membership prices available" row is an OR across three slots and
  doesn't apply the membership filter. Real, known, and deliberately
  **not** in this PR — it's §1.5 of the plan we set aside.
- **The pricing page still can't show a quarterly or a duplicate one-time
  price.** Also real, also deliberately out of scope (Phase 2). If you add
  a quarterly price in Stripe it will sync fine and show in admin, but the
  customer page will still mishandle it.
- **Admin doesn't yet tell you which Stripe account the catalog belongs
  to.** That was §1.2, set aside.
- **The summary shows the first error's message when several resources
  fail**, with a count of the rest ("and 2 other resources"). Reading
  every message means looking at the individual rows. Intentional — the
  summary is a headline.
