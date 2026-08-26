/**
 * The guard's typed errors, in their own module so both the guard and the
 * shared payment-error responder can `instanceof` them without an import
 * cycle. Nothing here imports anything — that is the point.
 *
 * Three classes, one per outcome the plan separates, because conflating any
 * two of them is the failure this workstream exists to prevent:
 *
 *   - `StripeAccountMismatchError` — Stripe answered and the account behind the
 *     credential is NOT the declared one. A *fact*. Fatal at boot.
 *   - `StripeExpectedAccountMissingError` — credentials are present but the
 *     environment never declared which account it expects. Deterministic
 *     misconfiguration; a retry cannot fix it. Fatal at boot.
 *   - `StripeUnverifiedError` — everything indefinite: Stripe unreachable, a
 *     timeout, a 5xx, a rejected key, the mode unreadable. NEVER fatal. The
 *     server boots, payment paths refuse, verification retries.
 *
 * Both fatal classes are also thrown post-boot, where they are NOT fatal — the
 * process stays up and the payment path refuses (settled decision 6, and the
 * post-boot behavior recorded as gap 4 at plan approval). Fatality is a
 * decision the *boot phase* makes about these errors, never a property the
 * errors carry.
 */

/** Discriminator carried to the client so a caller can branch without parsing prose. */
export const STRIPE_UNVERIFIED_CODE = "stripe_account_unverified";

/**
 * The client-safe message. It names the condition and, deliberately, no
 * account ids, no key names and no environment variables — this string reaches
 * end users on the checkout path.
 */
export const STRIPE_UNVERIFIED_CLIENT_MESSAGE =
  "Payments are temporarily unavailable while we verify our payment provider connection. No charge was made. Please try again shortly.";

/**
 * Base class so one `instanceof` covers every refusal the guard can produce.
 *
 * `message` is the operator-facing diagnostic and can name account ids, key
 * names and env vars — it is logged and never sent to a client. `clientMessage`
 * and `code` are what cross the wire. Both live on the BASE class rather than
 * only on the indefinite subclass: a mismatch refusal reaching a checkout still
 * has to answer the customer, and answering them with two account ids would
 * leak configuration to anyone who can reach the endpoint.
 */
export class StripeVerificationError extends Error {
  readonly code = STRIPE_UNVERIFIED_CODE;
  readonly clientMessage = STRIPE_UNVERIFIED_CLIENT_MESSAGE;

  /** The mode the refusal is about, when one could be read. */
  readonly liveMode: boolean | null;

  constructor(message: string, liveMode: boolean | null) {
    super(message);
    this.name = new.target.name;
    this.liveMode = liveMode;
  }
}

/**
 * Stripe answered, and the account behind the credential is not the expected
 * one. The message names both ids and the variable to correct — it is an
 * operator-facing string and must never be handed to an end user.
 */
export class StripeAccountMismatchError extends StripeVerificationError {}

/** Credentials present, `STRIPE_ACCOUNT_ID_{LIVE,TEST}` absent. */
export class StripeExpectedAccountMissingError extends StripeVerificationError {}

/** An indefinite answer — Stripe unreachable, a timeout, a 5xx, a rejected key. */
export class StripeUnverifiedError extends StripeVerificationError {}
