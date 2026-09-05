# PR #602 — Billing cycle read from the app DB — UAT

**Workstream:** #601

When you switched from monthly to annual during PR #600's test run, the switch
worked — Stripe took the $21.00 and our records were correct — but the card
went on saying Monthly, at the monthly price, still offering you the upgrade
you had just bought. This is the fix for that.

The cause was a guard that had its own intent backwards: it preferred Stripe's
synced copy over our own records specifically *to avoid* showing a stale
"Switch to Annual", not realising the synced copy is the thing that lags. This
run is mostly about step 1, which is the moment that used to lie to you.

**One deliberate behaviour to know before you start**, so it doesn't read as a
bug: for a short window after switching, the **`$X/month` price line
disappears** rather than showing a figure. The charged amount is the one thing
only Stripe can tell us, so while its copy still describes the old plan we show
nothing instead of a number we know is wrong. It comes back as `$24.99/year`
once the sync lands. Step 3 checks exactly this.

## Setup

- [claude] Confirm the Repl is synced to `main` at the merge commit and the
  worktree is clean.
- [claude] Report `stripe_live_mode` and confirm it reads `false`, so the run
  stays in Stripe test mode.
- [david] **Account A — an account with no qualifying membership at all**: no
  active subscription, no lifetime purchase, no admin grant. `POST
  /stripe/checkout` has no existing-subscription guard, so buying on an account
  that already has one leaves a second subscription that keeps billing and that
  no control on the card can reach.
- [david] **Account B — Legendary for Life only**, no recurring subscription,
  for R3. Do not grant lifetime to Account A: the grant does not cancel A's
  subscription, and once it lands every control and every mutation route
  refuses, stranding it.
- [restore] If the run leaves you on annual and you would rather be back on
  monthly, say so at close-out and I will file the switch-back rather than
  leaving your account changed by a test.

## Steps

### 1. The card reports Annual straight after the switch

**Do:** On Account A, buy a monthly Legendary subscription, then use
"Switch to Annual" and confirm it. Watch the card as soon as the dialog closes.

**Expect:** within a few seconds the plan reads **Annual** and the renewal date
moves about a year out — or the amber "our records haven't caught up" notice
appears and it settles within about 90 seconds. What must **not** happen is the
old failure: the card silently continuing to say Monthly with no notice.

### 2. The switch is no longer offered

**Do:** Stay on the card once step 1 has settled.

**Expect:** no "Switch to Annual" button — there is nothing left to switch to.
"Cancel Subscription" and "Manage billing & receipts" both remain.

### 3. No price line rather than the wrong price

**Do:** Look at where the `$X/month` line sat before the switch, just below the
renewal date.

**Expect:** either **no price line at all** (Stripe's copy hasn't caught up —
this is correct, not a bug), or **`$24.99/year`** if it has. What must not
appear is **`$3.99/month`**, which is the stale figure this fix exists to
suppress.

### 4. The amount returns once Stripe's copy catches up

**Do:** Tell me when you reach this step; I check whether the mirror has synced
the new price yet, and we reload the page together once it has.

**Expect:** the line reads **`$24.99/year`**, matching the plan label. If the
mirror still hasn't synced after a few minutes, this step is recorded
**Blocked** — that is webhook delivery in the Repl, not this fix.

## Regression

### R1. A genuine monthly subscriber is unaffected

**Do:** On a fresh subscription-free account, buy monthly and look at the card
without switching.

**Expect:** plan reads **Monthly**, the price line reads **`$3.99/month`**, and
"Switch to Annual — save 48%" is offered. The fix inverts a precedence; it must
not have removed the ordinary path.

### R2. PR #600's fix still holds

**Do:** In that same moment — right after the purchase in R1, before any sync —
check that both controls are present.

**Expect:** "Switch to Annual" and "Cancel Subscription" both appear
immediately, without waiting for Stripe's copy. This is #600's regression, and
it shares the code this PR touched.

### R3. Legendary for Life still shows no recurring controls

**Do:** Sign in as **Account B** and open the Membership card.

**Expect:** the lifetime membership named, "Manage billing & receipts" only. No
switch, no cancel.

## Not bugs

- **The price line vanishing after a switch.** Covered in step 3 — it is the
  intended behaviour, not a rendering fault.
- **A second click on "Switch to Annual" being refused** with "Plan switches
  are only supported from monthly to annual billing". Once this fix ships that
  button shouldn't be there to click, but if you reach the message some other
  way: it is a real guard reading live Stripe state, and it cannot double-charge
  you. The wording is inaccurate and is tracked on #601.
- **The Stripe sync lag itself.** Not fixed here. This PR stops the card
  depending on it.
