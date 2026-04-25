/**
 * Tests for getStripeWebhookSecret() — the mode-aware resolver that picks the
 * right Stripe webhook signing secret based on the active stripe_live_mode.
 *
 * Precedence (mirrors the API-key resolver):
 *   live mode  → STRIPE_WEBHOOK_SECRET_LIVE  → STRIPE_WEBHOOK_SECRET
 *   test mode  → STRIPE_WEBHOOK_SECRET_TEST  → STRIPE_WEBHOOK_SECRET
 *
 * Returns null when no env var is configured (caller falls back to the
 * managed-webhook secret stored in stripe._managed_webhooks).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { getStripeWebhookSecret } from "../lib/stripeClient";

const ENV_KEYS = [
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_WEBHOOK_SECRET_TEST",
  "STRIPE_WEBHOOK_SECRET_LIVE",
] as const;

describe("getStripeWebhookSecret", () => {
  // Snapshot the env vars under test so each case starts from a known state.
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

  it("returns *_TEST in test mode when only the test var is set", async () => {
    process.env.STRIPE_WEBHOOK_SECRET_TEST = "whsec_test_only";
    const got = await getStripeWebhookSecret(false);
    assert.equal(got, "whsec_test_only");
  });

  it("returns *_LIVE in live mode when only the live var is set", async () => {
    process.env.STRIPE_WEBHOOK_SECRET_LIVE = "whsec_live_only";
    const got = await getStripeWebhookSecret(true);
    assert.equal(got, "whsec_live_only");
  });

  it("falls back to STRIPE_WEBHOOK_SECRET in test mode when *_TEST is missing", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_fallback";
    const got = await getStripeWebhookSecret(false);
    assert.equal(got, "whsec_fallback");
  });

  it("falls back to STRIPE_WEBHOOK_SECRET in live mode when *_LIVE is missing", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_fallback";
    const got = await getStripeWebhookSecret(true);
    assert.equal(got, "whsec_fallback");
  });

  it("prefers the mode-specific var over the generic fallback in test mode", async () => {
    process.env.STRIPE_WEBHOOK_SECRET_TEST = "whsec_test_specific";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_generic";
    const got = await getStripeWebhookSecret(false);
    assert.equal(got, "whsec_test_specific");
  });

  it("prefers the mode-specific var over the generic fallback in live mode", async () => {
    process.env.STRIPE_WEBHOOK_SECRET_LIVE = "whsec_live_specific";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_generic";
    const got = await getStripeWebhookSecret(true);
    assert.equal(got, "whsec_live_specific");
  });

  it("does NOT use *_LIVE when running in test mode", async () => {
    process.env.STRIPE_WEBHOOK_SECRET_LIVE = "whsec_live_only";
    const got = await getStripeWebhookSecret(false);
    assert.equal(
      got,
      null,
      "test mode must not pick up the live-only secret — that would let test webhooks be verified with the live key (and vice versa)",
    );
  });

  it("does NOT use *_TEST when running in live mode", async () => {
    process.env.STRIPE_WEBHOOK_SECRET_TEST = "whsec_test_only";
    const got = await getStripeWebhookSecret(true);
    assert.equal(
      got,
      null,
      "live mode must not pick up the test-only secret",
    );
  });

  it("returns null when nothing is configured", async () => {
    const gotTest = await getStripeWebhookSecret(false);
    const gotLive = await getStripeWebhookSecret(true);
    assert.equal(gotTest, null);
    assert.equal(gotLive, null);
  });
});
