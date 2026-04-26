/**
 * Tests for the Stripe credentials resolver — proves that each mode reads from
 * exactly one env var (no legacy `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY`
 * fallback, no Replit Connectors OAuth fallback) and throws a clear error
 * naming the missing variable when invoked without the required mode-specific
 * env vars set.
 *
 * We test through `getUncachableStripeClient()` and `getStripePublishableKey()`
 * because the underlying `getCredentials()` is module-local. Both wrappers
 * call `getCredentials()` internally.
 *
 * `isLiveMode()` reads from the admin-config DB, which we don't want to touch
 * in a unit test. Instead we stub it via a custom env var path: we populate
 * the relevant env vars and rely on the fact that with no DB connection the
 * adminConfig getConfigStringRaw call returns the default ("false" → test
 * mode). That gives us a deterministic "test mode" branch to exercise.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { getUncachableStripeClient, getStripePublishableKey } from "../lib/stripeClient";

const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_SECRET_KEY_TEST",
  "STRIPE_SECRET_KEY_LIVE",
  "STRIPE_PUBLISHABLE_KEY_TEST",
  "STRIPE_PUBLISHABLE_KEY_LIVE",
  "REPLIT_CONNECTORS_HOSTNAME",
  "REPL_IDENTITY",
  "WEB_REPL_RENEWAL",
] as const;

describe("Stripe credentials resolver — fallback chains removed", () => {
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (snapshot[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = snapshot[k];
      }
    }
  });

  it("throws when STRIPE_SECRET_KEY_TEST is missing in test mode (no legacy fallback)", async () => {
    // Set the publishable key but NOT the secret key for test mode. The
    // legacy STRIPE_SECRET_KEY var is also set to prove it's not used as a
    // fallback anymore.
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_xxx";
    process.env.STRIPE_SECRET_KEY = "sk_legacy_should_be_ignored";

    await assert.rejects(
      () => getUncachableStripeClient(),
      (err: Error) => {
        assert.match(err.message, /STRIPE_SECRET_KEY_TEST/);
        assert.doesNotMatch(err.message, /Replit Stripe integration/);
        return true;
      },
    );
  });

  it("throws when STRIPE_PUBLISHABLE_KEY_TEST is missing in test mode (no legacy fallback)", async () => {
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_xxx";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_legacy_should_be_ignored";

    await assert.rejects(
      () => getStripePublishableKey(),
      (err: Error) => {
        assert.match(err.message, /STRIPE_PUBLISHABLE_KEY_TEST/);
        return true;
      },
    );
  });

  it("does NOT consult the Replit Stripe Connectors OAuth fallback when env vars are missing", async () => {
    // Simulate the connectors environment being available but with no env
    // vars set. Previously this would have triggered an HTTP fetch to the
    // connectors host; now it must throw without making any network call.
    process.env.REPLIT_CONNECTORS_HOSTNAME = "connectors.example.invalid";
    process.env.REPL_IDENTITY = "fake-identity-token";

    await assert.rejects(
      () => getUncachableStripeClient(),
      (err: Error) => {
        // The error must name the missing mode-specific env var, NOT mention
        // the Replit Stripe integration as an alternative.
        assert.match(err.message, /STRIPE_SECRET_KEY_TEST/);
        assert.doesNotMatch(err.message, /connection/i);
        return true;
      },
    );
  });

  it("succeeds in test mode when both STRIPE_SECRET_KEY_TEST and STRIPE_PUBLISHABLE_KEY_TEST are set", async () => {
    process.env.STRIPE_SECRET_KEY_TEST = "sk_test_xxx";
    process.env.STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_xxx";

    const pk = await getStripePublishableKey();
    assert.equal(pk, "pk_test_xxx");
  });
});
