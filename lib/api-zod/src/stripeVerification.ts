/**
 * The Stripe account guard's client-facing contract.
 *
 * Lives in @workspace/api-zod so the API server (the guard, the shared payment
 * error responder, the admin summary route) and both UIs (the Billing page's
 * status panel, the customer-facing checkout confirmation) consume ONE
 * declaration rather than matching copies.
 *
 * The alternative that was tried first — a copy on each side, kept honest by a
 * test that read the other file as text and regexed it for the literal — held
 * the `code` and nothing else: the user-facing message and the response shape
 * could still drift with nothing failing, and the check itself was a mechanism
 * to maintain in place of an import the type-checker enforces for free.
 */

/**
 * The discriminator on a refused payment request, so a client can branch on the
 * condition rather than parse prose. It travels as `code` on the error body.
 */
export const STRIPE_UNVERIFIED_CODE = "stripe_account_unverified";

/**
 * The message an END USER sees on a payment path that runs BEFORE any charge:
 * starting a checkout, opening the billing portal, changing a subscription. It
 * names the condition and, deliberately, no account ids, no key names and no
 * environment variables — a mismatch refusal's diagnostic text names both
 * accounts and stays in the log.
 *
 * "No charge was made" is true on these paths and is the reassurance that stops
 * a worried customer retrying. It is NOT true everywhere — see below.
 */
export const STRIPE_UNVERIFIED_CLIENT_MESSAGE =
  "Payments are temporarily unavailable while we verify our payment provider connection. No charge was made. Please try again shortly.";

/**
 * The message for CHECKOUT CONFIRMATION, and the reason it exists is money.
 *
 * `POST /stripe/checkout/confirm` runs *after* Stripe has redirected the
 * customer back from a completed Checkout session — so by the time a refusal
 * can happen there, the card may well already have been charged. Sending the
 * message above on that path asserts something we do not know, and asserts it
 * to someone standing in front of a "pay" button: "No charge was made. Please
 * try again shortly" is an instruction to buy the same thing twice.
 *
 * So this one says only what is actually known — that the status cannot be
 * confirmed right now — and tells them explicitly not to pay again. It is
 * reachable in normal operation, not just in a misconfiguration: a checkout
 * created against a verified instance can have its confirmation routed to an
 * unverified one during a rolling deploy or a partial Stripe outage.
 */
export const STRIPE_UNVERIFIED_CONFIRM_MESSAGE =
  "We can't confirm your payment status right now — please don't pay again. If your payment went through, your account will update on its own; check back shortly, and contact support if it hasn't.";

/**
 * The message for RECEIPT LOOKUP, and it exists because the default was false
 * on exactly one path.
 *
 * `GET /stripe/invoice/:invoiceId/receipt` retrieves evidence of a charge the
 * customer ALREADY made. Sending the default there tells someone asking for the
 * receipt of an invoice they paid that no charge was made — a false statement
 * about their money, made by a working system in a degraded window.
 *
 * The lesson recorded rather than the fix alone: round 2 fixed the confirmation
 * path and argued it was the whole class, on the reasoning that a refusal always
 * precedes that request's own Stripe mutation. That reasoning was sound about
 * MUTATIONS and silent about LOOKUPS — this route mutates nothing and reads a
 * charge that happened earlier. The class was "paths where the claim can be
 * false", and it had two members, not one.
 *
 * So this one asserts nothing about whether money moved. It says what is
 * actually true — the receipt cannot be fetched right now, and their payment and
 * account are untouched by that.
 */
export const STRIPE_UNVERIFIED_RECEIPT_MESSAGE =
  "We can't retrieve your receipt right now while we verify our payment provider connection. Your payment and your account are unaffected — please try again shortly.";

/**
 * Four states, not three. `unconfigured` is the credentials-absent path: an
 * integration nobody enabled, which is terminal and must not be polled —
 * reporting it as `pending` would make the page poll forever and render an
 * intentional absence as temporary recovery.
 */
export const STRIPE_VERIFICATION_STATES = [
  "unconfigured",
  "pending",
  "verified",
  "refused",
] as const;

export type StripeVerificationState = (typeof STRIPE_VERIFICATION_STATES)[number];

/** One sample of the guard's state, as `/admin/stripe/summary` reports it. */
export interface StripeVerificationSnapshot {
  state: StripeVerificationState;
  /** "live" | "test", or null when the stored mode itself could not be read. */
  mode: "live" | "test" | null;
  /** Operator-facing reason for a non-verified state. Never carries a credential. */
  reason: string | null;
  lastAttemptAt: string | null;
  /**
   * The responding process. The deployment is `autoscale` with the server in
   * every instance, so this value is process-local and the endpoint answers
   * from whichever instance the router picked. Labelling it is not decoration:
   * an unlabelled value would let one healthy instance report recovery for a
   * fleet that has not recovered.
   */
  instanceId: string;
  /** Always "instance". A fleet-wide aggregate needs shared state. */
  scope: "instance";
}
