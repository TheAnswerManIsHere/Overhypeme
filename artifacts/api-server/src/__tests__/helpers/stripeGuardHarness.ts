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

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { __setAccountRetrieverForTests } from "../../lib/stripeAccountGuard.js";
import { __setPartitionReaderForTests } from "../../lib/stripeDatabasePartition.js";

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
  const restoreRetriever = __setAccountRetrieverForTests(async (secretKey) => answer(secretKey));
  // These suites test what happens DOWNSTREAM of the database partition (#566,
  // plan decision 12) with the real driver and stubbed credentials. They run
  // against schemas inside the marked test database, where the real-driver
  // partition would refuse before any of their assertions are reached, so the
  // partition read answers "a real database" here. The gate itself is untouched
  // and is exercised against the actual catalog in stripeDatabasePartition.test.ts.
  const restorePartition = __setPartitionReaderForTests(async () => ({
    database: "stubbed-real-database",
    testMarked: false,
    fakeOwned: false,
  }));
  return () => {
    restorePartition();
    restoreRetriever();
  };
}

/** The current value of every STRIPE_* variable. */
export function snapshotStripeEnv(): Record<string, string | undefined> {
  return Object.fromEntries(STRIPE_ENV_KEYS.map((key) => [key, process.env[key]]));
}

/**
 * Register a suite that checks every STRIPE_* variable is back to the value
 * `before()` returns. Declare it AFTER the suite it checks — node:test runs a
 * file's suites in order — and capture the snapshot in that suite's first
 * `before`, not at file load: with `--test-isolation=none` every file is loaded
 * before any suite runs, so a load-time snapshot would be compared against
 * whatever other files did in between.
 */
export function describeStripeEnvRestored(suiteName: string, before: () => Record<string, string | undefined>): void {
  describe(`${suiteName} leaves no Stripe settings behind`, () => {
    it("every STRIPE_* variable is back to its value from before the suite", () => {
      const expected = before();
      for (const key of STRIPE_ENV_KEYS) {
        assert.equal(process.env[key], expected[key], `${key} must be restored`);
      }
    });
  });
}
