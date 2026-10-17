# PR #577 — Refusing to boot against the wrong Stripe account — UAT

**Workstream:** #571

Until this PR, a Stripe key put in the wrong environment variable would reach and **change** the
wrong Stripe account at startup — register a webhook on it, then copy its data down — and the only
trace was a log line nobody was reading. The check that was supposed to catch it ran *after* the
change, had no teeth, and was skipped entirely when the expected account was not set.

Now nothing gets a Stripe connection until the account behind the key has been confirmed to be the
one this environment says it should be. Two things you decided shape what you'll see:

- **A Stripe outage must never take the site down** (your call, 2026-08-26). So the server only
  refuses to start when the account is *confirmed* wrong. If Stripe is merely unreachable, the site
  comes up with payments switched off, retries on its own, and turns payments back on when a retry
  succeeds — no restart.
- **The refusal has to be visible.** Before, every failed mode toggle showed you the words "Failed
  to update" no matter what actually went wrong. Now the Billing page shows the server's real
  reason, and carries a live panel saying whether payments are verified on the instance you're
  talking to.

Most of this guard's behaviour is failure behaviour, which needs a deliberately broken configuration
to see. This run checks the parts that are visible on a healthy system: the new panel, that the mode
toggle still works and now explains itself, and that paying still works exactly as it did.

## Setup

- [claude] Confirm the Repl is synced to the merge commit and the worktree is clean.
- [claude] Confirm from the boot logs that Stripe verified on startup and the webhook was configured.
- [david] Sign in to the admin area as yourself — I hold no admin session, so every step below is
  yours to click.
- [restore] `stripe_live_mode` — restore to the value captured before step 4, if step 4 changed it.

## Steps

### 1. The Billing page reports whether payments are verified

**Do:** Open the admin Billing page and look at the "Stripe Mode" panel at the top of the page.

**Expect:** Directly beneath the mode toggle there is a new bordered box, green, reading
**"Payments verified"**.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/pages/admin/stripeVerification.test.tsx:test 16 — pending becomes verified without a manual refresh`

**Deferred:** #631 — 7b — the green box reading Payments verified, directly beneath the mode toggle on the Billing page — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`; #631 — 7b — the verification box in its verified state carrying the text-green-400 class, so it shows green, not only data-state verified — `artifacts/overhype-me/src/pages/admin/stripeVerification.test.tsx`

### 2. That report says which instance it speaks for

**Do:** Read the line of small text inside that green box, below the "Payments verified" heading.

**Expect:** It says **"This instance only"** followed by a short identifier, and a sentence noting
that other instances of the deployment may differ. It does **not** claim anything about the
deployment as a whole.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/pages/admin/stripeVerification.test.tsx:test 19 — the rendered value is labelled with its instance`

**Deferred:** #631 — 7b — the rendered scope line reading This instance only (9f8e7d6c). Other instances of this autoscale deployment may differ., with no text matching the deployment is or has — `artifacts/overhype-me/src/pages/admin/stripeVerification.test.tsx`

### 3. The report agrees with the mode chip

**Do:** Compare the green box against the "Stripe Mode" chip on the same panel.

**Expect:** The chip reads **TEST**, and the green box reports verified — i.e. the page is telling
you the test-mode credentials belong to the test account, which is the state the pre-merge check
confirmed.

**Lane:** live

**Check:** `ask_question` via the Replit connector: read-only, report `stripe_live_mode` and the boot-log line confirming the Stripe account was verified for that mode

**Deferred:** #631 — 7b — the Stripe Mode chip reading TEST and stripe-verification at data-state verified with Payments verified, together on the Billing page — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

### 4. The mode toggle still works, and explains itself either way

**Do:** Click **"Switch to Live Mode"**, wait for it to settle, then read the page. Whatever the
outcome, click **"Switch to Test Mode"** afterwards to put it back. **Do not run a checkout while
the page is in live mode** — live mode charges real cards.

**Expect:** One of exactly two coherent outcomes, and no third: **either** the chip flips to LIVE
and the verification box re-reports for live mode, **or** the chip stays on TEST and a red error
message appears naming a specific reason — an account mismatch, or a named missing variable. What
you must **not** see is the bare words "Failed to update", or a chip that flips to LIVE while
something reports a failure.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/stripeModeToggle.test.ts:test 5 — a refused target leaves the stored mode unchanged and returns a non-success naming the mismatch`; `artifacts/api-server/src/__tests__/stripeModeToggle.test.ts:test 5c — a valid toggle still works end to end`; `artifacts/overhype-me/src/pages/admin/stripeVerification.test.tsx:uses the server's message rather than the hardcoded fallback`; `artifacts/api-server/src/__tests__/stripeModeToggle.test.ts:a target mode with no credentials is refused rather than switched into` asserts the missing-variable refusal

**Deferred:** #631 — 7b — on the page, a refused Switch to Live Mode leaving the Stripe Mode chip on TEST and a red error showing the server's refusal text, such as STRIPE_SECRET_KEY_LIVE, never Failed to update — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`; #628 — Phase 20 (Full launch (US)) — the chip flipping to LIVE and the box re-reporting needs the real live account, verified on the deployed site

### 5. Paying still works, unchanged

**Do:** With the chip back on **TEST**, go through checkout as a normal user with a Stripe test card
(4242 4242 4242 4242, any future expiry, any CVC).

**Expect:** The purchase completes and your account shows as Legendary, exactly as before this
change — same screens, same wording, no new message anywhere in the flow.

**Lane:** scripted

**Deferred:** #695 — the Stripe fake's event channel — needs a Stripe test-card checkout

## Regression

### R1. The Stripe connection checklist still renders

**Do:** On the Billing page, open the "Setup Checklist" section (David,
2026-10-15: the checkmarks live there, not under "Stripe Connection").

**Expect:** The list of environment-variable checkmarks renders as it did before, with no missing
rows and no errors.

**Lane:** ci

**Deferred:** #631 — 7b — the Setup Checklist section rendering the six STRIPE_*_TEST and _LIVE CheckRows with no missing row and no error, via a page.route stub of /api/admin/stripe/summary, since the fake shows stripe-fake-env-note — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

### R2. A manual Stripe sync still runs

**Do:** On the Billing page, click "Sync Stripe data" and wait for it to report.

**Expect:** The sync starts and reports progress per resource as it always has.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminBillingSync.spec.ts:success path: a real sync drives all rows to complete` — runs in CI against the fake Stripe driver; and `artifacts/overhype-me/e2e/adminBillingSync.spec.ts:intermediate transitions: rows progress pending → syncing… → complete in order` for the per-resource presentation, on a run the simulate endpoint starts and writes its own row states for

**Deferred:** #631 — 7b — after the Sync Stripe data click starts a real run, the Products and Prices rows showing a lastSyncedAt newer than the click and Plans reaching complete, not rows the boot backfill already completed — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

### R3. The subscriber counts still load

**Do:** Read the active-subscriber and registered-member numbers on the Billing page.

**Expect:** Both show numbers, not a loading spinner that never resolves and not an error.

**Lane:** ci

**Deferred:** #631 — 7b — the Active Subscribers and Registered numbers rendering as numbers, with no spinner left and no error — `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`

## Not bugs

- **The panel says "This instance only".** That is deliberate and accurate: the app runs several
  copies of the server behind a load balancer, and this page can only ask one of them. A single
  fleet-wide answer needs shared storage this change was not allowed to add, so the limitation is
  stated rather than papered over.
- **The panel keeps re-checking for a short while after it turns green.** Also deliberate — each
  re-check is a fresh chance to reach a different copy of the server, so one healthy copy cannot
  report recovery on behalf of the rest.
- **Step 4 may legitimately refuse.** The pre-merge check confirmed the *test*-mode credentials
  against the test account, which is the mode this deployment runs in. It did not confirm the
  live-mode pairing. If those two don't match, this change is now the thing that catches it — a
  refusal there is the guard working, not a defect in it, and the message will name what to fix.
- **Nothing user-facing changed for a working system.** Every new customer-facing message in this
  change only appears while payments are unverified, which a healthy deployment never is.
