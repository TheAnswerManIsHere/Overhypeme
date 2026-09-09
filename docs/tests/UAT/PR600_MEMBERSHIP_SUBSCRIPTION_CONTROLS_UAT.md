# PR #600 — Membership card subscription controls — UAT

**Workstream:** #599

You reported that a monthly Legendary subscriber had no obvious way to switch
from monthly to annual billing. The switch button was there in the code all
along — it just never rendered, because the whole controls block was waiting on
Stripe's synced copy of your subscription rather than on our own record of it.
Stripe's copy arrives by webhook and, on the purchase you tested, showed up
eleven minutes late. The Cancel Subscription button was hidden for exactly the
same eleven minutes, which is the part worth looking at hardest here.

**Step 1 is the whole regression.** It is the only step that exercises the fix,
and it only means anything while the Stripe mirror is genuinely still empty —
which is why it carries a live check rather than a stopwatch. Everything after
it is the surrounding flow.

## Setup

- [claude] Confirm the Repl is synced to `main` at the merge commit and the
  worktree is clean, so you are clicking the merged fix and not a stale build.
- [claude] Report the current `stripe_live_mode` config value and confirm it
  reads `false`, so the run stays in Stripe test mode throughout.
- [david] **This run needs three separate accounts.** They cannot be the same
  account, and the reason is mechanical rather than tidiness — each one ends
  the run in a state that disqualifies it from the others:

  - **Account A — no qualifying membership at all.** No active subscription,
    no lifetime purchase, no admin grant. Used for steps 1–6. `POST
    /stripe/checkout` has **no existing-subscription guard**, so buying on an
    account that already has one creates a *second* qualifying subscription
    while the panel and every mutation route act on only one of them — the
    other keeps billing and cannot be reached from the UI. Every purchase and
    every step 1 retry needs an account in this state.
  - **Account B — Legendary for Life only**, with no recurring subscription,
    for R1. Do **not** grant lifetime to Account A: an admin grant does not
    cancel A's Stripe subscription, and once the grant lands the UI hides A's
    recurring controls while all four mutation routes refuse it, stranding a
    live subscription with no way to cancel it.
  - **Account C — registered and never paid**, for R2.

  A qualifying Legendary for Life source also keeps `isLifetime` true no matter
  what else is bought, which is why B can never stand in for A: buying a
  monthly subscription there hides the controls by design and spends real money
  testing nothing.
- [david] Step 1 needs a **fresh** monthly purchase, made during this run, on
  Account A. An existing monthly subscription whose mirror has already synced
  cannot distinguish the fixed build from the broken one.
- [restore] If the run leaves you on the annual plan and you would rather be
  back on monthly, say so at close-out and I will file the switch-back rather
  than leaving your account changed by a test.

## Steps

### 1. The controls appear before Stripe's copy arrives

**Do:** Buy a monthly Legendary subscription from `/pricing` with a Stripe test
card. As soon as you land back on your profile page, tell me you are looking at
the Membership card — don't wait. I run a read-only check at that moment to
establish whether the Stripe mirror has your subscription yet.

**Expect:** with my check confirming the mirror is still empty, the card shows
your renewal date and **both** a "Switch to Annual" button (it may carry a
"— save N%" suffix) and a "Cancel Subscription" button.

If my check shows the mirror has **already** caught up, this step is recorded
**inconclusive, not passed** — the old broken build would have shown both
buttons too, so it proves nothing. We re-run it on a fresh purchase, **on
another account with no qualifying membership** — retrying on this one would
leave it carrying two subscriptions, only one of which the UI can reach.

### 2. The savings figure is right

**Do:** Read the "Switch to Annual — save N%" button text.

**Expect:** N is a plausible whole-number percentage — with the test catalogue's
$3.99/month and $24.99/year that is 48%. Not `0`, not blank, not a number over
100.

### 3. The switch dialog previews the real proration

**Do:** Click "Switch to Annual".

**Expect:** A dialog opens showing a proration preview — an amount due now, in
dollars, with one or more line items describing the credit for unused monthly
time and the charge for the annual plan, and the two reconciling to the total.
Not a spinner that never resolves, and not an error banner.

### 4. The switch completes and you stay Legendary

**Do:** Confirm the switch in the dialog.

**Expect:** the dialog closes and you stay Legendary, with **either** of these
outcomes — both are correct:

- within a few seconds the plan reads **Annual** and the renewal date moves
  roughly a year out; **or**
- an amber notice appears saying your change was accepted but our records
  haven't caught up, and the card corrects itself within about **90 seconds**.
  This is a documented path: when the server's post-switch refresh exceeds its
  10-second budget it returns a stale-state flag, and the panel deliberately
  keeps re-checking out to 90 seconds.

The card silently continuing to show **Monthly**, at the monthly price, with
"Switch to Annual" still offered and no amber notice, is the #601 failure.

### 5. The switch button is gone once you are annual

**Do:** Stay on the Membership card after step 4 has settled.

**Expect:** "Switch to Annual" is no longer offered — there is nothing left to
switch to. "Cancel Subscription" and "Manage billing & receipts" both remain.

### 6. The charge is recorded

**Do:** **Reload the page**, then scroll to Payment History. The reload is
required: the switch refreshes the subscription but not this list, which loads
on page mount, so without it you are reading pre-switch state.

**Expect:** the list holds one more entry than it did before the switch,
showing the annual charge with a dollar amount and today's date.

If it has **not** changed, tell me before we call it a failure — I check
whether the charge was recorded server-side at all. A charge that never reached
our records is webhook delivery in the Repl, not a defect in this panel, and it
is recorded as Blocked rather than Fail.

## Regression

### R1. Legendary for Life sees no recurring controls

**Do:** Sign in as **Account B** — the lifetime-only account from Setup — and
open the Membership card. Do not grant lifetime to the account used in steps
1–6; see Setup for why that strands a live subscription.

**Expect:** The card names the lifetime membership and offers
"Manage billing & receipts" only — no "Switch to Annual", no
"Cancel Subscription". A lifetime member has no recurring subscription to act
on.

### R2. A free account still sees the Free Plan block

**Do:** Sign in as **Account C** — registered, never paid — and open the
Membership card.

**Expect:** The "Free Plan" block with a "Go Legendary" button. No switch or
cancel controls anywhere on the card.

### R3. A cancelling subscription offers Reactivate, not the controls

**Do:** On an account with an **active monthly** subscription and no lifetime
source, click "Cancel Subscription" and confirm. Stay on the Membership card.
Account A no longer qualifies once step 4 has moved it to annual, so this needs
a fresh monthly purchase on a subscription-free account — not a second purchase
on A, which would leave it billing two subscriptions.

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
  it. Out of scope for this PR. (Note this is the *absent* case; the *stale*
  case, where that line shows a confidently wrong price, is #601.)
- **"Switch to Annual" may linger for a few seconds right after step 4.** The
  panel refetches on a short delay to catch the webhook; step 5 is about the
  settled state, not the first instant.
- **A second click on "Switch to Annual" when you are already annual is
  refused, safely.** It returns "Plan switches are only supported from monthly
  to annual billing" — a confusing message for that situation, tracked on #601.
  What matters is that it is a real guard reading live Stripe state, so it
  cannot double-charge you.
- **The eleven-minute sync lag itself is not fixed here.** This PR stops the UI
  depending on the sync; making the sync prompt is a separate question and not
  one this run is testing.
