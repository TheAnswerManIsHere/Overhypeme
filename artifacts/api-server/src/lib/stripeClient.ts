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

async function getCredentials(liveMode?: boolean) {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!xReplitToken) {
    throw new Error("X-Replit-Token not found for repl/depl");
  }

  const connectorName = "stripe";
  const useLive = liveMode !== undefined ? liveMode : await isLiveMode();
  const targetEnvironment = useLive ? "production" : "development";

  const url = new URL(`https://${hostname}/api/v2/connection`);
  url.searchParams.set("include_secrets", "true");
  url.searchParams.set("connector_names", connectorName);
  url.searchParams.set("environment", targetEnvironment);

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Replit-Token": xReplitToken,
    },
  });

  const data = (await response.json()) as {
    items?: Array<{ settings: { publishable: string; secret: string } }>;
  };
  const connectionSettings = data.items?.[0];

  if (!connectionSettings?.settings?.publishable || !connectionSettings?.settings?.secret) {
    throw new Error(`Stripe ${targetEnvironment} connection not found`);
  }

  return {
    publishableKey: connectionSettings.settings.publishable,
    secretKey: connectionSettings.settings.secret,
    environment: targetEnvironment,
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
  return new StripeSync({
    poolConfig: { connectionString: process.env.DATABASE_URL!, max: 2 },
    stripeSecretKey: secretKey,
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
