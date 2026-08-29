# PR #600 — Membership card subscription controls — UAT

**Workstream:** #599

You reported that a monthly Legendary subscriber had no obvious way to switch
from monthly to annual billing. The switch button was there in the code all
along — it just never rendered, because the whole controls block was waiting on
Stripe's synced copy of your subscription rather than on our own record of it.
Stripe's copy arrives by webhook and, on the purchase you tested, showed up
eleven minutes late. The Cancel Subscription button was hidden for exactly the
same eleven minutes, which is the part worth looking at hardest here.

So this run has two jobs: confirm the switch works end to end (the step 2 of
PR #214's UAT that #599 interrupted), and confirm that the controls now appear
*straight after purchase* rather than after some later sync.

## Setup

- [claude] Confirm the Repl is synced to `main` at the merge commit and the
  worktree is clean, so you are clicking the merged fix and not a stale build.
- [claude] Report the current `stripe_live_mode` config value and confirm it
  reads `false`, so the run stays in Stripe test mode throughout.
- [david] Be signed in as yourself with a **monthly** Legendary subscription. If
  your current account is on annual or Legendary for Life, buy a fresh monthly
  subscription from `/pricing` with a Stripe test card first — step 1 depends on
  the purchase being recent.
- [restore] If the run leaves you on the annual plan and you would rather be
  back on monthly, say so at close-out and I will file the switch-back rather
  than leaving your account changed by a test.

## Steps

### 1. The controls appear straight after purchase

**Do:** Immediately after completing a monthly Legendary purchase — within a
minute or two, before any Stripe sync has had time to run — open your profile
page and look at the Membership card.

**Expect:** The card shows your renewal date, and below it **both** a
"Switch to Annual" button (it may carry a "— save N%" suffix) and a
"Cancel Subscription" button. This is the exact moment the bug used to show
neither.

### 2. The savings figure is right

**Do:** Read the "Switch to Annual — save N%" button text.

**Expect:** N is a plausible whole-number percentage — with the test catalogue's
$3.99/month and $24.99/year that is roughly 48%. Not `0`, not blank, not a
number over 100.

### 3. The switch dialog previews the real proration

**Do:** Click "Switch to Annual".

**Expect:** A dialog opens showing a proration preview — an amount due now, in
dollars, with one or more line items describing the credit for unused monthly
time and the charge for the annual plan. Not a spinner that never resolves, and
not an error banner.

### 4. The switch completes and you stay Legendary

**Do:** Confirm the switch in the dialog.

**Expect:** The dialog closes, the Membership card refreshes, and you are still
Legendary. Within a few seconds the plan reads **Annual** and the renewal date
moves roughly a year out.

### 5. The switch button is gone once you are annual

**Do:** Stay on the Membership card after step 4 completes.

**Expect:** "Switch to Annual" is no longer offered — there is nothing left to
switch to. "Cancel Subscription" and "Manage billing & receipts" both remain.

### 6. The charge is recorded

**Do:** Scroll to Payment History on the same card.

**Expect:** A new entry for the annual charge, with a dollar amount and a date
of today.

## Regression

### R1. Legendary for Life sees no recurring controls

**Do:** Sign in as (or grant yourself) a Legendary for Life account and open the
Membership card.

**Expect:** The card names the lifetime membership and offers
"Manage billing & receipts" only — no "Switch to Annual", no
"Cancel Subscription". A lifetime member has no recurring subscription to act
on.

### R2. A free account still sees the Free Plan block

**Do:** Sign in as a registered, non-paying account and open the Membership
card.

**Expect:** The "Free Plan" block with a "Go Legendary" button. No switch or
cancel controls anywhere on the card.

### R3. A cancelling subscription offers Reactivate, not the controls

**Do:** On a monthly subscription, click "Cancel Subscription" and confirm.
Stay on the Membership card.

**Expect:** The card reports the subscription is ending on the renewal date and
offers "Reactivate Subscription". "Switch to Annual" and "Cancel Subscription"
are both gone. Click Reactivate and confirm both controls come back.

### R4. Purchase still works from the pricing page

**Do:** From `/pricing`, check that Monthly, Annual and Legendary for Life all
render with prices.

**Expect:** All three plan cards appear with dollar amounts. This is the plan
catalogue the switch button reads from, so an empty pricing page would mean the
fix is masking a catalogue problem rather than resolving one.

## Not bugs

- **The `$X/month` price line may be missing on a brand-new subscription.** That
  line reads the charged amount out of Stripe's synced copy, which is the one
  thing only Stripe can tell us, so it stays blank until the sync lands rather
  than guessing. The renewal date, plan label and both buttons no longer wait on
  it. It is out of scope for this PR.
- **"Switch to Annual" may linger for a few seconds right after step 4.** The
  panel refetches on a short delay to catch the webhook; step 5 is about the
  settled state, not the first instant.
- **The eleven-minute sync lag itself is not fixed here.** This PR stops the UI
  depending on the sync; making the sync prompt is a separate question and not
  one this run is testing.
