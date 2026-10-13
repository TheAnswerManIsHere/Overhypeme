/**
 * The fake Stripe driver's refusal (#566, plan decision 11), in a leaf module so
 * the shared payment-error responder can `instanceof` it without importing the
 * fake.
 *
 * Two cases throw it, and both are refusals rather than fabricated successes:
 *
 *   - a payment mutation (checkout, subscription change, customer, portal,
 *     invoice preview) — the fake does not model money moving until the
 *     event-channel increment;
 *   - any SDK member the fake does not implement, reached from inside the sync
 *     library where the compiler cannot see it. The message names the member, so
 *     a library upgrade that calls something new fails loudly and specifically.
 */
export const STRIPE_FAKE_UNSUPPORTED_CODE = "stripe_fake_unsupported";

export class StripeFakeUnsupportedError extends Error {
  readonly code = STRIPE_FAKE_UNSUPPORTED_CODE;
  readonly clientMessage = "This action is not available on the fake Stripe used for testing.";

  constructor(readonly member: string, detail: string) {
    super(`Fake Stripe does not support ${member}: ${detail}`);
    this.name = "StripeFakeUnsupportedError";
  }
}
