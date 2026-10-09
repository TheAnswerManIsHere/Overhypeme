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

**Lane:** scripted

**Check:** `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

**Deferred:** #566 — the Stripe fake: this spec needs a Stripe that is safe to talk to, so it cannot run anywhere yet

### 2. A green summary when the last sync worked

**Do:** Click "Sync Stripe data" and let it finish.

**Expect:** A green line reads *"Last sync completed successfully. Last
synced just now."*

**Lane:** ci

**Check:** `artifacts/overhype-me/src/pages/admin/syncStatusSummary.test.ts:all complete → ok, with the most recent stamp`

**Deferred:** #631 — increment 7 (burn-down): the cited check covers part of this step; the rest is not yet asserted

### 3. The green summary survives a reload

**Do:** Reload the page.

**Expect:** The green line is still there, and still says it synced. It
doesn't revert to a bare product count.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/stripeSyncRunner.test.ts:surfaces stored row state (running / complete / error) and per-resource counts derived from the data tables`

**Deferred:** #631 — increment 7 (burn-down): the cited check covers part of this step; the rest is not yet asserted

### 4. A failed sync shows a red summary — the main event

**Do:** Cause a sync to fail (per the TEST_RUN doc, or ask Replit to run
the simulate step).

**Expect:** A red summary line reads *"Last sync failed — plans did not
complete: &lt;the actual Stripe error&gt;. Catalog data may be stale."*

**Lane:** ci

**Check:** `artifacts/overhype-me/src/pages/admin/syncStatusSummary.test.ts:an errored resource → error tone, naming the resource and its message`

**Deferred:** #631 — increment 7 (burn-down): the cited check covers part of this step; the rest is not yet asserted

### 5. The Plans row itself shows the failure

**Do:** Look at the Plans row after the failed sync in the previous step.

**Expect:** It shows a red ✗ and the error text.

**Lane:** scripted

**Check:** `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

**Deferred:** #566 — the Stripe fake: this spec needs a Stripe that is safe to talk to, so it cannot run anywhere yet

### 6. The failure survives a reload

**Do:** Reload the page after the failed sync.

**Expect:** Both the red summary line and the Plans row's red ✗ are still
there. This is the entire point — before this PR both vanished on reload
and you'd see a cheerful product count instead.

**Lane:** scripted

**Check:** `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

**Deferred:** #566 — the Stripe fake: this spec needs a Stripe that is safe to talk to, so it cannot run anywhere yet

### 7. The summary names which resource failed

**Do:** Read the summary line's wording after the failed sync.

**Expect:** It names which resource failed, so you know whether it's your
catalog (products/prices/plans) or something peripheral
(charges/invoices).

**Lane:** ci

**Check:** `artifacts/overhype-me/src/pages/admin/syncStatusSummary.test.ts:an errored resource → error tone, naming the resource and its message`

### 8. A partial failure is reported as failed, not success

**Do:** Cause a sync to fail on one resource while succeeding on others.

**Expect:** The summary is red, not green, even though most rows show ✓.
The "Last synced" stamp still appears, because both facts matter —
something did sync, and something didn't; it should never round up to
"all good."

**Lane:** ci

**Check:** `artifacts/overhype-me/src/pages/admin/syncStatusSummary.test.ts:a partial run is reported as failed, never rounded up to success`

### 9. A never-synced install says so, in amber

**Do:** On a database that has never run a sync (mostly for the
engineering checklist — hard to arrange on your live install, since you've
synced plenty), look at the summary line.

**Expect:** An amber line reads *"Never synced — run a full sync to
populate the catalog."* It is amber and actionable, not a spinner and not
blank — "never ran" and "still working" must not look alike.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/pages/admin/syncStatusSummary.test.ts:all-idle with no stamps → never synced, not success`

**Deferred:** #631 — increment 7 (burn-down): the cited check covers part of this step; the rest is not yet asserted

### 10. The "Last synced" stamp survives a server restart

**Do:** After a sync, have Replit restart the server (or come back after a
deploy), then reload Admin → Billing.

**Expect:** The "· Last synced: …" stamp in the Plans header is still
correct — it's read from each resource's own timestamp rather than from an
in-memory value that resets on restart.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/stripeSyncRunner.test.ts:preserves syncedCount across a simulated server restart (regression: counts survive process loss)`

**Deferred:** #631 — increment 7 (burn-down): the cited check covers part of this step; the rest is not yet asserted

## Regression

### R1. Sync Stripe data still animates and re-enables

**Do:** Click "Sync Stripe data".

**Expect:** Rows animate pending → syncing → ✓ as before; the button
disables then re-enables.

**Lane:** scripted

**Check:** `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

**Deferred:** #566 — the Stripe fake: this spec needs a Stripe that is safe to talk to, so it cannot run anywhere yet

### R2. Full sync still works across all resources

**Do:** Click "Full sync".

**Expect:** Same animation, across all eight resources.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/stripeSyncRunner.test.ts:full run invokes every tracked resource sequentially in SYNC_RESOURCES order`

**Deferred:** #631 — increment 7 (burn-down): the cited check covers part of this step; the rest is not yet asserted

### R3. The LIVE / TEST badge still shows the right mode

**Do:** Check the LIVE / TEST badge in the Plans header.

**Expect:** Still shows the right mode.

**Lane:** scripted

**Check:** `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

**Deferred:** #566 — the Stripe fake: this spec needs a Stripe that is safe to talk to, so it cannot run anywhere yet

### R4. The product count is still accurate

**Do:** Check the "N products found" count after a sync.

**Expect:** Still accurate.

**Lane:** ci

**Deferred:** #631 — increment 7 (burn-down) — the product-count render has no check yet

### R5. The product list still renders correctly

**Do:** Look at the product list below the panel.

**Expect:** Names, descriptions, and prices render as before.

**Lane:** ci

**Deferred:** #631 — increment 7 (burn-down) — the product-list render has no check yet

### R6. The Setup Checklist rows are unchanged

**Do:** Check the Setup Checklist rows.

**Expect:** Unchanged by this PR.

**Lane:** ci

**Deferred:** #631 — increment 7 (burn-down) — the Setup Checklist render has no check yet

### R7. Toggling live/test mode is unchanged

**Do:** Toggle live/test mode.

**Expect:** Behaves as it did before — untouched here.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/stripeModeToggle.test.ts:test 5c — a valid toggle still works end to end`

### R8. The customer pricing page is completely unchanged

**Do:** Open the customer `/pricing` page.

**Expect:** Completely unchanged. If anything differs, that's a bug — this
PR is admin-only.

**Lane:** ci

**Deferred:** #631 — increment 7 (burn-down) — the pricing-page render has no check yet

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
