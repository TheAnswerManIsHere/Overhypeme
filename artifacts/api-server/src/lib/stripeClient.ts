import Stripe from "stripe";

async function isLiveMode(): Promise<boolean> {
  try {
    // Use getConfigStringRaw to read `value` directly, bypassing debug-mode resolution.
    // Stripe mode must be independent from the debug overlay (task requirement).
    const { getConfigStringRaw } = await import("./adminConfig");
    const val = await getConfigStringRaw("stripe_live_mode", "false");
    return val === "true";
  } catch {
    return false;
  }
}

/**
 * Resolve the Stripe webhook signing secret for the active mode.
 *
 * Each mode reads from exactly one env var — no legacy fallback:
 *   live mode  → STRIPE_WEBHOOK_SECRET_LIVE
 *   test mode  → STRIPE_WEBHOOK_SECRET_TEST
 *
 * Returns `null` when the env var for the active mode is not configured. In
 * that case the stripe-replit-sync library falls back to the per-account
 * managed-webhook signing secret stored in stripe._managed_webhooks (see
 * processWebhook in the library), so signature verification still works
 * end-to-end.
 */
export async function getStripeWebhookSecret(liveMode?: boolean): Promise<string | null> {
  const useLive = liveMode !== undefined ? liveMode : await isLiveMode();
  const envSecret = useLive
    ? process.env.STRIPE_WEBHOOK_SECRET_LIVE
    : process.env.STRIPE_WEBHOOK_SECRET_TEST;
  return envSecret ?? null;
}

async function getCredentials(liveMode?: boolean) {
  const useLive = liveMode !== undefined ? liveMode : await isLiveMode();

  // Each mode reads from exactly one env var — no legacy fallback, no
  // OAuth-connector fallback. If the required var for the active mode is
  // missing, fail loudly so misconfiguration is obvious.
  const envSecret = useLive
    ? process.env.STRIPE_SECRET_KEY_LIVE
    : process.env.STRIPE_SECRET_KEY_TEST;
  const envPublishable = useLive
    ? process.env.STRIPE_PUBLISHABLE_KEY_LIVE
    : process.env.STRIPE_PUBLISHABLE_KEY_TEST;

  const secretVar = useLive ? "STRIPE_SECRET_KEY_LIVE" : "STRIPE_SECRET_KEY_TEST";
  const publishableVar = useLive ? "STRIPE_PUBLISHABLE_KEY_LIVE" : "STRIPE_PUBLISHABLE_KEY_TEST";

  if (!envSecret) {
    throw new Error(
      `Stripe credentials not configured — set ${secretVar} in Replit Secrets (active mode: ${useLive ? "live" : "test"}).`,
    );
  }
  if (!envPublishable) {
    throw new Error(
      `Stripe credentials not configured — set ${publishableVar} in Replit Secrets (active mode: ${useLive ? "live" : "test"}).`,
    );
  }

  return {
    publishableKey: envPublishable,
    secretKey: envSecret,
    environment: useLive ? "production" : "development",
  };
}

export async function getUncachableStripeClient() {
  const { secretKey } = await getCredentials();
  return new Stripe(secretKey, { apiVersion: "2025-08-27.basil" as Stripe.LatestApiVersion });
}

export async function getStripePublishableKey() {
  const { publishableKey } = await getCredentials();
  return publishableKey;
}

export async function getStripeSecretKey() {
  const { secretKey } = await getCredentials();
  return secretKey;
}

let stripeSync: Awaited<ReturnType<typeof buildStripeSync>> | null = null;
let stripeSyncLiveMode: boolean | null = null;

async function buildStripeSync() {
  const { StripeSync } = await import("stripe-replit-sync");
  const secretKey = await getStripeSecretKey();
  // If a webhook signing secret is configured for the active mode, pass it through
  // so signature verification uses it directly. When null, the library falls back
  // to the per-account managed-webhook secret stored in stripe._managed_webhooks.
  const webhookSecret = await getStripeWebhookSecret();
  return new StripeSync({
    poolConfig: { connectionString: process.env.DATABASE_URL!, max: 2 },
    stripeSecretKey: secretKey,
    ...(webhookSecret ? { stripeWebhookSecret: webhookSecret } : {}),
  });
}

export async function getStripeSync() {
  const live = await isLiveMode();
  if (!stripeSync || stripeSyncLiveMode !== live) {
    stripeSync = await buildStripeSync();
    stripeSyncLiveMode = live;
  }
  return stripeSync;
}

export function invalidateStripeSync() {
  stripeSync = null;
  stripeSyncLiveMode = null;
}
