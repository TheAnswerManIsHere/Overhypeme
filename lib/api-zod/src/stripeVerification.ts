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
 * The message an END USER sees. It names the condition and, deliberately, no
 * account ids, no key names and no environment variables — a mismatch refusal's
 * diagnostic text names both accounts and stays in the log.
 */
export const STRIPE_UNVERIFIED_CLIENT_MESSAGE =
  "Payments are temporarily unavailable while we verify our payment provider connection. No charge was made. Please try again shortly.";

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
