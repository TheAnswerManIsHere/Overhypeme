/**
 * Shared setup for suites that cross the Stripe account guard.
 *
 * The guard now sits in front of EVERY client construction, so any suite that
 * reaches `getStripeSync()` or `getUncachableStripeClient()` needs the same two
 * things: mode-scoped Stripe env vars it fully controls, and a stubbed account
 * read. Five suites grew slightly different hand-rolled versions of that before
 * this existed, which meant the next one would be copied from whichever was
 * nearest rather than from a canonical one.
 *
 * **Scope every hook that uses these inside a `describe`.** `node --test` runs
 * this suite with `--test-isolation=none`, so a hook declared at a file's top
 * level attaches to the ROOT suite and runs before every test in the process —
 * a root-level `beforeEach` deleting `STRIPE_*` env vars breaks unrelated files
 * two shards away.
 */

import { __setAccountRetrieverForTests } from "../../lib/stripeAccountGuard.js";

export const STRIPE_ENV_KEYS = [
  "STRIPE_SECRET_KEY_TEST",
  "STRIPE_SECRET_KEY_LIVE",
  "STRIPE_PUBLISHABLE_KEY_TEST",
  "STRIPE_PUBLISHABLE_KEY_LIVE",
  "STRIPE_ACCOUNT_ID_TEST",
  "STRIPE_ACCOUNT_ID_LIVE",
] as const;

/**
 * Clear every Stripe env var, returning a restore function. Call it in a scoped
 * `beforeEach` and restore in the matching `afterEach`.
 */
export function clearStripeEnv(): () => void {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of STRIPE_ENV_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
  return () => {
    for (const key of STRIPE_ENV_KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  };
}

/**
 * Stub the guard's account read, returning a restore function.
 *
 * `answer` receives the secret key the guard presented — the same thing
 * `GET /v1/account` resolves against — so a test can give each mode's
 * credential a different account and exercise a mismatch without a network.
 */
export function stubAccountRetriever(
  answer: (secretKey: string) => string | Promise<string>,
): () => void {
  return __setAccountRetrieverForTests(async (secretKey) => answer(secretKey));
}
