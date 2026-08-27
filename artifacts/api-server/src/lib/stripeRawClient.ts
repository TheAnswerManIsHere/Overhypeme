/**
 * The one place a `Stripe` instance is constructed, and the one place the
 * mode→env-var-name mapping lives.
 *
 * A leaf module for the same reason `stripeVerificationErrors.ts` is one: the
 * account guard needs to build a raw client to ask Stripe which account a key
 * belongs to, and `stripeClient.ts` needs the guard — so the shared primitive
 * cannot live in either.
 *
 * Both halves earn the separate file. The pinned API version and the request
 * bounds were briefly written out twice, which would have let a version bump on
 * the client path leave the guard verifying the account over a different one.
 * And the secret-variable names were computed in three places, so renaming one
 * meant editing three files, only one of which resolves credentials.
 */

import Stripe from "stripe";
import {
  STRIPE_MAX_NETWORK_RETRIES,
  STRIPE_REQUEST_TIMEOUT_MS,
} from "./membershipTiming.js";

/** The env var holding the secret key for a mode. Exactly one per mode, no fallback. */
export function stripeSecretVarFor(liveMode: boolean): string {
  return liveMode ? "STRIPE_SECRET_KEY_LIVE" : "STRIPE_SECRET_KEY_TEST";
}

/** The env var holding the publishable key for a mode. */
export function stripePublishableVarFor(liveMode: boolean): string {
  return liveMode ? "STRIPE_PUBLISHABLE_KEY_LIVE" : "STRIPE_PUBLISHABLE_KEY_TEST";
}

/** The env var declaring which account a mode's credentials may touch. */
export function stripeAccountVarFor(liveMode: boolean): string {
  return liveMode ? "STRIPE_ACCOUNT_ID_LIVE" : "STRIPE_ACCOUNT_ID_TEST";
}

export function createRawStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    apiVersion: "2025-08-27.basil" as Stripe.LatestApiVersion,
    // The SDK defaults are DEFAULT_TIMEOUT = 80000 with maxNetworkRetries = 2,
    // and this call passed neither — so one degraded retrieval could legitimately
    // run 80 seconds, and with retries nearer four minutes, against a 60-second
    // entitlement lease. A retrieval returning after expiry has its apply
    // discarded by the fence, correctly, and if latency stays elevated every
    // subsequent pass does the same thing: "repaired on the next pass" never
    // happens and the source is stuck for as long as Stripe is slow.
    //
    // Bounding the request is the fix, not lengthening the lease — see
    // membershipTiming.ts, which derives the lease floor from these two numbers.
    timeout: STRIPE_REQUEST_TIMEOUT_MS,
    maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
  });
}
