# PR #287 — Membership is derived, not assigned — UAT

Your in-app acceptance test, David. This is the payments remediation we
spent 32 plan-review rounds designing and a further 11 code-review rounds
hardening — 101 review findings, all fixed or explicitly recorded as a
known gap below.

**What actually changed, in one sentence.** Legendary used to be a value
that fifteen different bits of code wrote by hand — each with its own idea
of when to write it — and it is now a value the server *works out* from
what you actually own. Nothing sets your tier any more. It is computed
from your entitlements every time something about them changes.

The visible consequences are mostly about things being **correct in cases
that used to be wrong**, so a lot of this test is confirming that ordinary
things still work exactly as before. That is the point: the model changed
underneath, and the product should not feel different unless it was
previously broken.

**The one thing to know before you start.** Admin → Users no longer has a
membership tier dropdown. That is deliberate, not a missing feature.
Setting a tier by hand is exactly what this PR removes: the next time
anything recalculated, your hand-set value would have been silently
overwritten, so the control would have looked like it worked and then
quietly undone itself. Comping someone a membership is now **Grant
Legendary for Life** on the user's membership screen, which records *who*
granted it, *when*, and *why*.

## Setup

- [claude] Confirm the entitlement migration has landed and the server
  came up before you start — there's no point clicking around if either
  failed.

## Steps

### 1. Buying a subscription membership still works

**Do:** In test mode, go through checkout as a normal user and buy a
subscription membership.

**Expect:** You land back on the profile page as Legendary, same as
before.

### 2. The purchase shows up as Legendary everywhere

**Do:** After the purchase in the previous step, check your profile and
Admin → Users.

**Expect:** Your profile shows Legendary, and Admin → Users shows
Legendary for that user.

### 3. The Membership screen records the purchase

**Do:** Check Admin → the user's Membership screen for that purchase.

**Expect:** It shows the purchase, with its amount and currency.

### 4. A Legendary-for-Life one-time purchase works the same way

**Do:** Repeat the checkout, profile, and Membership-screen checks from
steps 1–3, but buy the Legendary-for-Life one-time purchase instead of a
subscription.

**Expect:** Same result as steps 1–3 — the one-time purchase is a
different source type and takes a different code path, but the outcome is
the same: Legendary on your profile and Admin → Users, and the purchase
recorded with amount and currency on the Membership screen.

### 5. Granting Legendary for Life makes the user Legendary

**Do:** Go to Admin → Users, pick a registered user, open Membership, and
click "Grant" in the "Legendary for Life" section.

**Expect:** The user becomes Legendary.

### 6. A grant is recorded distinctly from a purchase — the real fix

**Do:** Look at the membership screen after granting in the previous step.

**Expect:** The grant shows as an **admin grant**, distinct from a
purchase, showing who granted it and why, with **no amount and no payment
id** — because it is not a payment. Before, a comp was written as a fake
purchase with an invented payment-intent id and an amount of £0, so anyone
reading the payment records — including you, later, trying to reconcile
revenue — could not tell a comp from a real sale.

### 7. Revoking a grant drops the user

**Do:** Click "Revoke" on that grant.

**Expect:** The user drops to Registered.

### 8. A revoked grant stays in the history

**Do:** Look at the membership screen after revoking in the previous step.

**Expect:** The grant is still listed, marked revoked, with who revoked
it. It is not deleted — that history is the point.

### 9. A revoked user can be granted again

**Do:** Grant Legendary to the same user again.

**Expect:** It works.

### 10. A second grant is refused, not silently stacked

**Do:** Grant Legendary to a user, then click grant again (or
double-click it).

**Expect:** The second attempt is refused with *"User already has an
active admin grant"* — not a second silent grant. Before, two grants could
both land, and a later revoke would clear one and leave the user Legendary
anyway.

### 11. A full refund drops the user's access

**Do:** Refund a test membership purchase in full from the Stripe
dashboard.

**Expect:** The user drops to Registered within a few seconds.

### 12. A refunded purchase stays on record, marked refunded

**Do:** Check the user's membership screen after the full refund in the
previous step.

**Expect:** It still shows the purchase, marked refunded — the record is
kept, the entitlement is not.

### 13. A full refund sends the access-revoked email once

**Do:** Check whether the user received an access-revoked email after the
full refund.

**Expect:** They get the access-revoked email once.

### 14. A partial refund does not revoke access

**Do:** Refund part of a purchase (say £5 of £99) from the Stripe
dashboard.

**Expect:** The user stays Legendary. A partial refund is recorded in
their history and does not revoke anything. Previously the handler could
not tell partial from full at all — the charge amount it needed to compare
against was not even passed to it.

### 15. Cancelling one of two memberships keeps the other

**Do:** Give a test user both a Legendary-for-Life purchase and an active
subscription, then cancel the subscription.

**Expect:** They stay Legendary, because the lifetime purchase still
entitles them.

### 16. Removing the last membership finally drops the user

**Do:** Now refund the lifetime purchase too, from the setup in the
previous step.

**Expect:** They drop to Registered.

### 17. An admin grant holds a user up through a cancelled subscription

**Do:** Give a test user an admin grant alongside an active subscription,
then cancel the subscription.

**Expect:** The user stays Legendary, because the admin grant still holds
them up.

### 18. A dispute revokes access immediately

**Do:** Open a dispute on a test charge from the Stripe dashboard.

**Expect:** The user drops to Registered straight away — unchanged
behaviour, and deliberate: we don't give paid features to someone actively
charging back.

### 19. A dispute sends the admin alert

**Do:** Check for the admin alert after opening the dispute in the
previous step.

**Expect:** You get the admin alert.

### 20. Winning a dispute restores access

**Do:** Mark the dispute won in Stripe.

**Expect:** The user goes back to Legendary, because the underlying
purchase was always fine.

### 21. Losing a dispute is permanent

**Do:** Open another dispute and mark it lost.

**Expect:** The user drops to Registered and **stays there** — even if
Stripe later reports the subscription as active again. A lost chargeback
is permanent.

### 22. Your own profile shows the correct tier

**Do:** Check your own profile's tier.

**Expect:** Correct tier.

### 23. The Users list shows the correct tier per user

**Do:** Check the Admin → Users list.

**Expect:** Correct tier per user.

### 24. The Stripe summary counts add up

**Do:** Check Admin → the Stripe summary counts.

**Expect:** Legendary + Registered counts look right and add up.

### 25. Private memes are still Legendary-only

**Do:** Try making a private meme.

**Expect:** Legendary-only, as before.

### 26. PuLID / identity memes are still Legendary-only

**Do:** Try PuLID / identity memes.

**Expect:** Legendary-only, as before.

### 27. Daily upload limits still favor Legendary

**Do:** Check daily upload limits.

**Expect:** Legendary gets the higher limit.

### 28. Fact-of-the-day email still goes to Legendary members

**Do:** Check the fact-of-the-day email list.

**Expect:** Goes to Legendary members.

### 29. A member with failing payment can now cancel

**Do:** As a member whose payment is failing (in the 14-day grace
window), try to cancel your subscription.

**Expect:** You can now cancel it — previously the person actively being
chased for payment was the one person unable to stop it.

### 30. The convergence strip reads healthy under normal conditions

**Do:** Go to Admin → Refunds & Disputes and look at the status strip at
the top.

**Expect:** Grey text reading "Healthy · last converged N ago" — not
alarming.

### 31. The convergence strip is honest right after a deploy

**Do:** Look at the status strip right after a deploy.

**Expect:** "Not yet run · waiting Nm since start" — honest, not a fake
"healthy".

### 32. The convergence strip refreshes itself

**Do:** Watch the status strip for 30+ seconds without reloading.

**Expect:** It refreshes itself every 30 seconds; you never need to
reload.

### 33. The pending-convergence count is shown

**Do:** Check the pending-convergence count on the status strip.

**Expect:** "No users pending convergence" normally, or a number if some
users are lagging.

### 34. An amber convergence strip is a label problem, not an access one

**Do:** If the status strip ever turns amber, note what it's telling you.

**Expect:** It means stored tiers are drifting — access is still correct,
this is a label problem, not an access problem.

### 35. A partial refund is labelled and does not remove access

**Do:** If you have a partial refund, find it in the Admin → Refunds &
Disputes list.

**Expect:** It appears with its own "partial refund" label and does not
remove the member's access — only a full refund does.

## Regression

### R1. The customer pricing page is completely unchanged

**Do:** Open the customer `/pricing` page.

**Expect:** Completely unchanged — this PR does not touch the catalog
display path.

### R2. A non-membership checkout does not grant Legendary

**Do:** Checkout for a non-membership product, if you have one.

**Expect:** Completes, and does not grant Legendary.

### R3. Cancelling a subscription still shows the period-end message

**Do:** Cancel a subscription.

**Expect:** Shows "cancels at period end", as before.

### R4. Reactivating a cancelling subscription is unchanged

**Do:** Reactivate a cancelling subscription.

**Expect:** As before.

### R5. Switching monthly to annual keeps the user Legendary

**Do:** Switch monthly → annual.

**Expect:** As before, and the user stays Legendary.

### R6. Payment history still lists everything

**Do:** Check payment history on the profile.

**Expect:** Still lists purchases, refunds, disputes.

### R7. Deactivating and reinstating a user restores the right tier

**Do:** In Admin → Users, deactivate, then reinstate a user.

**Expect:** They come back at the right tier. This changed for the
better: reinstating now re-checks Stripe first. Before, if the user's
subscription had been cancelled while a webhook went missing, reinstating
them would have handed Legendary back based on a stale local row.

### R8. Creating a user with Legendary records an admin grant

**Do:** Create a user from Admin → Users.

**Expect:** Works; picking "Legendary" gives them a recorded admin grant.

## Not bugs
- **Two race conditions are watch-for-if-you-see-it, not required steps**
  (moved out of the numbered steps — they cannot be honestly required when
  the doc's own text itself says not to try to force them):
  - *The amber "not sure yet" notice.* If Cancel, Reactivate, or Switch to
    Annual is accepted by Stripe while our own records fail to refresh in
    the same moment (rare — it needs both to happen at once), an amber
    notice should appear above the membership card saying the change was
    accepted but our records haven't caught up, alongside the normal
    success message. It should clear itself within a minute or two.
    Never a red error for it (the change did go through), the panel
    silently showing stale details, or the notice outliving the card's
    own update.
  - *A refused click on a since-changed subscription.* If you have more
    than one subscription and the one shown has since been cancelled at
    Stripe's end (hard to stage on purpose — don't try), a button should
    refuse with *"Your subscription details have changed since this page
    loaded. Refresh and try again — nothing was modified."* rather than
    acting on the wrong subscription. If you ever see that message and
    something changed anyway, that's a real bug worth reporting even
    outside a UAT run.

- **The customer portal still uses Stripe's default configuration.**
  Setting an explicit one is a separate PR, deliberately — it is
  independent of everything here and safe in either order.
- **Hard account deletion is still broken** (`data-delete` with the hard
  phase). That is a pre-existing bug in `main`, not caused or fixed here;
  this PR only makes sure entitlements clean themselves up when a user *is*
  deleted. It needs its own fix.
- **Grace expiry takes a moment to show in the admin list.** If someone's
  14-day payment-failure window lapses, they lose access *immediately* —
  that is enforced on every request — but the stored value the admin list
  reads catches up on the hourly sweep. Access is correct either way; only
  the label can lag, and never in the permissive direction.
- **A payment failure whose first attempt Stripe cannot tell us about gets
  no deadline.** The user keeps access and the case is reported rather
  than guessed at. Deliberate: a guessed start date can only ever be too
  early, and too early means cutting off someone who is paying.
- **There is no background repair for an event that never arrives.**
  Every Stripe event we *do* receive is authoritative here, and duplicates
  and out-of-order deliveries are handled. But if Stripe never
  successfully delivers an event at all — the webhook endpoint is down for
  its whole retry window, say — nothing sweeps up afterwards and finds the
  discrepancy on its own. That user's tier stays whatever it was until the
  next event for the same subscription or payment arrives.
- **There is no manual repair for the direction that costs money.** Admin
  grant and revoke only create and revoke *admin grants*; neither can mark
  a stale Stripe subscription cancelled, or a stale purchase refunded or
  dispute-lost. So if the missing event was one that should have
  *removed* access, the only fix is another Stripe event for that source —
  you cannot correct it from the admin screen. (The reverse direction is
  fine: if someone is wrongly *without* access, an admin grant restores
  it.) This is a **deliberate, accepted gap in this PR**, not an
  oversight: the Stripe-vs-local reconciliation job that closes it is a
  separate piece of work, deferred so this one could ship.
- **Memberships don't record which Stripe mode they came from.** If you
  make a test-mode membership and then switch the app to live mode, that
  test purchase keeps granting Legendary — nothing notices it belongs to
  the other account, and a live-mode refresh can't repair it because the
  test object isn't there to look up. Only reachable by you toggling live
  mode with test entitlements around; no customer can trigger it, and no
  live purchase is affected. Fixing it properly means a new column and a
  migration, so it is **escalated rather than patched in at the end of
  this PR** — the second known gap, alongside reconciliation above.
