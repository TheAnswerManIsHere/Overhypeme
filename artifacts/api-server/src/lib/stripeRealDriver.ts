/**
 * The real Stripe driver: the environment's credentials and the live SDK.
 *
 * This is the code that used to be spread across `stripeClient.ts`,
 * `stripeAccountGuard.ts`, `index.ts` and `routes/admin.ts`, moved behind the
 * seam in `stripeDriver.ts` without changing what it reads or builds. Every read
 * is at call time, as before, so a test that sets an env var sees it.
 *
 * The env-var names live here and in `stripeRawClient.ts` (the one SDK
 * construction) and nowhere else in application code. The fake driver imports
 * neither.
 */
import type { StripeDriver } from "./stripeDriverTypes.js";
import {
  createRawStripeClient,
  stripeAccountVarFor,
  stripePublishableVarFor,
  stripeSecretVarFor,
} from "./stripeRawClient.js";

const webhookSecretVarFor = (liveMode: boolean) =>
  liveMode ? "STRIPE_WEBHOOK_SECRET_LIVE" : "STRIPE_WEBHOOK_SECRET_TEST";

export const realStripeDriver: StripeDriver = {
  kind: "real",

  settingNames(liveMode) {
    return {
      secret: stripeSecretVarFor(liveMode),
      publishable: stripePublishableVarFor(liveMode),
      account: stripeAccountVarFor(liveMode),
    };
  },

  configuredSecretKey(liveMode) {
    return process.env[stripeSecretVarFor(liveMode)] || undefined;
  },

  credentials(liveMode) {
    // Each mode reads from exactly one env var — no legacy fallback, no
    // OAuth-connector fallback. If the required var for the active mode is
    // missing, fail loudly so misconfiguration is obvious.
    const secretVar = stripeSecretVarFor(liveMode);
    const publishableVar = stripePublishableVarFor(liveMode);
    const secretKey = process.env[secretVar];
    const publishableKey = process.env[publishableVar];
    const mode = liveMode ? "live" : "test";
    if (!secretKey) {
      throw new Error(
        `Stripe credentials not configured — set ${secretVar} in Replit Secrets (active mode: ${mode}).`,
      );
    }
    if (!publishableKey) {
      throw new Error(
        `Stripe credentials not configured — set ${publishableVar} in Replit Secrets (active mode: ${mode}).`,
      );
    }
    return { secretKey, publishableKey };
  },

  webhookSecret(liveMode) {
    return process.env[webhookSecretVarFor(liveMode)] ?? null;
  },

  expectedAccountId(liveMode) {
    return process.env[stripeAccountVarFor(liveMode)];
  },

  createClient(secretKey) {
    return createRawStripeClient(secretKey);
  },

  async buildSync({ secretKey, webhookSecret }) {
    const { StripeSync } = await import("stripe-replit-sync");
    // If a webhook signing secret is configured for the active mode, pass it
    // through so signature verification uses it directly. When null, the library
    // falls back to the per-account managed-webhook secret stored in
    // stripe._managed_webhooks.
    return new StripeSync({
      poolConfig: { connectionString: process.env.DATABASE_URL!, max: 2 },
      stripeSecretKey: secretKey,
      ...(webhookSecret ? { stripeWebhookSecret: webhookSecret } : {}),
    });
  },

  credentialPresence() {
    return {
      secretKeyTest: !!process.env[stripeSecretVarFor(false)],
      secretKeyLive: !!process.env[stripeSecretVarFor(true)],
      publishableKeyTest: !!process.env[stripePublishableVarFor(false)],
      publishableKeyLive: !!process.env[stripePublishableVarFor(true)],
      webhookSecretTest: !!process.env[webhookSecretVarFor(false)],
      webhookSecretLive: !!process.env[webhookSecretVarFor(true)],
    };
  },
};
