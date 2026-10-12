# PR #658 — Billing says when Stripe setup has not finished — UAT

**Workstream:** #652

Admin → Billing used to have one healthy answer: **Payments verified**. But
verifying the Stripe account is only half of getting payments working. The
server then registers the webhook Stripe sends its events to (a subscription
starting, a refund), and if that kept failing the panel still read verified
while customers' purchases quietly stopped reaching us. The panel now reads
**Account verified — Stripe setup not finished**, in amber, naming the step
that failed, and turns green by itself once setup lands.

A failing setup cannot be caused safely on the live app, so the new state is
proven by the automated checks below. Your part is the regression step: the
healthy page must still read green.

## Setup

- [claude] Confirm the Repl is synced to `main` at the merge commit and the
  worktree is clean.
- [claude] Report `stripe_live_mode` and confirm it reads `false`, so the run
  stays in Stripe test mode.

## Steps

### 1. A failing setup shows on the Billing summary

**Do:** Nothing. The automated check runs the summary with webhook
registration failing.

**Expect:** the summary reports the mode as verified **with setup failing**
and a reason naming the webhook step. No raw error text and no key appears.
After setup succeeds it reports setup complete.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/stripeModeToggle.test.ts:a verified mode whose setup keeps failing reads as failing on the Billing summary, not just verified`

### 2. The panel reads "setup not finished", then turns green by itself

**Do:** Nothing. The automated check renders the panel.

**Expect:** an amber **Account verified — Stripe setup not finished** with the
reason underneath. Once setup completes, it changes to **Payments verified**
without a refresh.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/pages/admin/stripeVerification.test.tsx:a verified instance whose setup is failing reads as setup-incomplete, then verified once setup lands`

### 3. One instance still setting up outranks a healthy one

**Do:** Nothing. The automated check feeds the panel two instances.

**Expect:** with one instance fully set up and another still setting up, the
headline is the setup-not-finished one, and the panel keeps checking.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/pages/admin/stripeVerification.test.tsx:setup still owed on one verified instance outranks a fully verified one`

## Regression

### R1. The healthy Billing page still reads green

**Do:** Open **Admin → Billing** in the app and wait a few seconds for the
status box under the test/live switch.

**Expect:** the green **Payments verified** box, as before. Not the amber
"setup not finished" one. If it briefly shows amber right after the app
restarted, wait up to a minute; it should settle to green on its own.

**Lane:** human
