# PR #287 — Membership is derived, not assigned — UAT

Your in-app acceptance test, David. This is the payments remediation we spent 32
review rounds on, built.

**What actually changed, in one sentence.** Legendary used to be a value that
fifteen different bits of code wrote by hand — each with its own idea of when to
write it — and it is now a value the server *works out* from what you actually
own. Nothing sets your tier any more. It is computed from your entitlements
every time something about them changes.

The visible consequences are mostly about things being **correct in cases that
used to be wrong**, so a lot of this test is confirming that ordinary things
still work exactly as before. That is the point: the model changed underneath,
and the product should not feel different unless it was previously broken.

Companion engineering checklist:
[`PR287_PAYMENTS_ENTITLEMENT_MODEL_TEST_RUN.md`](PR287_PAYMENTS_ENTITLEMENT_MODEL_TEST_RUN.md).
**Have Replit run that first** — it checks the migration landed and the server
came up, and there is no point clicking around if either failed.

---

## The one thing to know before you start

**Admin → Users no longer has a membership tier dropdown.** That is deliberate,
not a missing feature. Setting a tier by hand is exactly what this PR removes:
the next time anything recalculated, your hand-set value would have been
silently overwritten, so the control would have looked like it worked and then
quietly undone itself.

Comping someone a membership is now **Grant Legendary for Life** on the user's
membership screen, which records *who* granted it, *when*, and *why*.

---

## 1. Buying a membership still works

The whole point of not breaking anything.

- In **test mode**, go through checkout as a normal user and buy a membership.
- ✅ You land back on the profile page as **Legendary**, same as before.
- ✅ Your profile shows Legendary. Admin → Users shows Legendary for that user.
- ✅ Admin → the user's **Membership** screen shows the purchase, with its
  amount and currency.

Do this for **both** a subscription plan and the Legendary-for-Life one-time
purchase if you can — they are different source types now and take different
paths.

## 2. Comping a membership — the visible change

- Admin → Users → pick a registered user → **Membership**.
- Click **Grant Legendary for Life**.
- ✅ The user becomes Legendary.
- ✅ The membership screen shows the grant as an **admin grant**, distinct from a
  purchase, showing **who granted it** and **why**.
- ✅ It shows **no amount and no payment id**, because it is not a payment.

  This is the real fix here. Before, a comp was written as a *fake purchase*
  with an invented payment-intent id and an amount of £0. Anyone reading the
  payment records — including you, later, trying to reconcile revenue — could
  not tell a comp from a real sale.

- Now click **Revoke**.
- ✅ The user drops to Registered.
- ✅ The grant is still **listed**, marked revoked, with who revoked it. It is
  not deleted. That history is the point.
- ✅ You can grant again afterwards, and it works.

## 3. Granting twice does nothing bad

- Grant Legendary to a user, then click grant again (or double-click it).
- ✅ The second one is refused with *"User already has an active admin grant"* —
  not a second silent grant.

  Before, two grants could both land, and a later revoke would clear one and
  leave the user Legendary anyway.

## 4. A refund removes access — and a partial one doesn't

- Refund a test membership purchase **in full** from the Stripe dashboard.
- ✅ The user drops to Registered within a few seconds.
- ✅ Their membership screen still shows the purchase, marked refunded — the
  record is kept, the entitlement is not.
- ✅ They get the access-revoked email **once**.

Now the case that used to be wrong:

- Refund a **part** of a purchase (say £5 of £99).
- ✅ The user **stays Legendary**. A partial refund is recorded in their history
  and does not revoke anything.

  Previously the handler could not tell partial from full at all — the charge
  amount it needed to compare against was not even passed to it.

## 5. Someone with two memberships keeps the other one

This is the case the old code got wrong most often, and it is worth setting up.

- Give a test user **both** a Legendary-for-Life purchase **and** an active
  subscription.
- Cancel the subscription.
- ✅ They stay **Legendary**, because the lifetime purchase still entitles them.
- Now refund the lifetime purchase too.
- ✅ *Now* they drop to Registered.

Same shape with a comp: an admin grant alongside a subscription, cancel the
subscription, and the grant still holds them up.

## 6. A chargeback revokes immediately, and winning gives it back

- Open a dispute on a test charge from the Stripe dashboard.
- ✅ The user drops to Registered straight away — unchanged behaviour, and
  deliberate: we don't give paid features to someone actively charging back.
- ✅ You get the admin alert.
- Now mark the dispute **won** in Stripe.
- ✅ The user goes back to **Legendary**, because the underlying purchase was
  always fine.

And the one that must never come back:

- Open another dispute and mark it **lost**.
- ✅ The user drops to Registered and **stays there** — even if Stripe later
  reports the subscription as active again. A lost chargeback is permanent.

## 7. Everything else still shows the right tier

Spot-check the places that read membership. They should be unremarkable.

| Where | Expected |
|---|---|
| Your own profile | Correct tier |
| Admin → Users list | Correct tier per user |
| Admin → the Stripe summary counts | Legendary + Registered counts look right and **add up** |
| Making a private meme | Legendary-only, as before |
| PuLID / identity memes | Legendary-only, as before |
| Daily upload limits | Legendary gets the higher limit |
| Fact-of-the-day email list | Goes to Legendary members |

## Regression smoke

| Check | Expected |
|---|---|
| Customer **/pricing** page | **Completely unchanged** — this PR does not touch the catalog display path |
| Checkout for a **non-membership** product (if you have one) | Completes, and does **not** grant Legendary |
| Cancel subscription → shows "cancels at period end" | As before |
| Reactivate a cancelling subscription | As before |
| Switch monthly → annual | As before, and the user stays Legendary |
| Payment history on the profile | Still lists purchases, refunds, disputes |
| Admin → Users → deactivate, then reinstate a user | Comes back at the **right** tier — see the note below |
| Creating a user from Admin → Users | Works; picking "Legendary" gives them a recorded admin grant |

**On reinstatement** — this one changed for the better. Reinstating a user now
re-checks Stripe first. Before, if the user's subscription had been cancelled
while a webhook went missing, reinstating them would have handed Legendary back
based on a stale local row.

## Known limitations — not bugs

- **The customer portal still uses Stripe's default configuration.** Setting an
  explicit one is a separate PR, deliberately — it is independent of everything
  here and safe in either order.
- **Hard account deletion is still broken** (`data-delete` with the hard phase).
  That is a pre-existing bug in `main`, not caused or fixed here; this PR only
  makes sure entitlements clean themselves up when a user *is* deleted. It needs
  its own fix.
- **Grace expiry takes a moment to show in the admin list.** If someone's
  14-day payment-failure window lapses, they lose access *immediately* — that is
  enforced on every request — but the stored value the admin list reads catches
  up on the hourly sweep. Access is correct either way; only the label can lag,
  and never in the permissive direction.
- **A payment failure whose first attempt Stripe cannot tell us about gets no
  deadline.** The user keeps access and the case is reported rather than guessed
  at. Deliberate: a guessed start date can only ever be too early, and too early
  means cutting off someone who is paying.
- **There is no background repair for an event that never arrives.** Every
  Stripe event we *do* receive is authoritative here, and duplicates and
  out-of-order deliveries are handled. But if Stripe never successfully delivers
  an event at all — the webhook endpoint is down for its whole retry window, say
  — nothing sweeps up afterwards and finds the discrepancy on its own. That
  user's tier stays whatever it was until the next event for the same
  subscription or payment arrives, or until you correct it by hand through the
  admin grant/revoke surface.

  This is a **deliberate, accepted gap in this PR**, not an oversight: the
  Stripe-vs-local reconciliation job that closes it is a separate piece of work,
  deferred so this one could ship. Worth knowing while you test, because it is
  the one scenario where the app can be confidently wrong.

## If something's wrong

```
What I did:
Which user (email or id):
What I expected:
What actually happened:
Their tier before / after:
Was there a Stripe event involved, and which one:
Screenshot:
```

The tier **before and after** matters more than usual here — almost every
behaviour in this PR is about a transition, and knowing which direction it went
(or didn't) narrows it immediately.
