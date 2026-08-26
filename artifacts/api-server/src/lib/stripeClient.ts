import Stripe from "stripe";
import {
  STRIPE_MAX_NETWORK_RETRIES,
  STRIPE_REQUEST_TIMEOUT_MS,
} from "./membershipTiming.js";
import { logger } from "./logger";
import {
  readStripeLiveModeStrict,
  verifyStripeAccount,
} from "./stripeAccountGuard.js";
import { StripeUnverifiedError } from "./stripeVerificationErrors.js";

export async function isLiveMode(): Promise<boolean> {
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

/**
 * Build a raw Stripe client from an already-resolved secret. Split out so the
 * guarded constructor and any future caller share one set of request bounds.
 */
function createRawStripeClient(secretKey: string): Stripe {
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

/**
 * One of the two exported construction boundaries, and the one checkout and the
 * admin mutation routes use directly.
 *
 * Guarding only `getStripeSync()` would satisfy almost every test this guard
 * has and still hand checkout a wrong-account client, so this constructor
 * carries the same verification — and, like the other, captures the mode ONCE
 * and threads it to both the expected account id and the credential.
 */
export async function getUncachableStripeClient() {
  const liveMode = await captureModeForConstruction();
  const { secretKey } = await getCredentials(liveMode);
  await verifyStripeAccount({ liveMode, secretKey });
  return createRawStripeClient(secretKey);
}

export async function getStripePublishableKey() {
  const { publishableKey } = await getCredentials();
  return publishableKey;
}

export async function getStripeSecretKey(liveMode?: boolean) {
  const { secretKey } = await getCredentials(liveMode);
  return secretKey;
}

/**
 * Capture the mode for ONE construction, through the strict read.
 *
 * Every credential and the expected account id for a single construction are
 * resolved from this one value. Before this existed, `getStripeSync()` read the
 * mode, then `getStripeSecretKey()` read it again, then
 * `getStripeWebhookSecret()` read it a third time — three independent reads
 * (`deferred-work.md:529-565`, found on PR #299's review). Adding verification
 * on top of that would have made a FOURTH read: verify the account for mode A,
 * hand back a client built for mode B, and stamp it verified. That is worse
 * than no guard, which is why mode-coherence had to land in the same increment.
 *
 * A mode read that FAILS resolves to unverified, never to a default — see
 * `stripeAccountGuard.ts` point 2.
 */
async function captureModeForConstruction(): Promise<boolean> {
  try {
    return await readStripeLiveModeStrict();
  } catch (err) {
    throw new StripeUnverifiedError(
      `The stored Stripe mode could not be read, so no credential can be trusted to belong to it: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      null,
    );
  }
}

let stripeSync: Awaited<ReturnType<typeof buildStripeSync>> | null = null;
let stripeSyncLiveMode: boolean | null = null;

/**
 * Bumped by every `invalidateStripeSync()`. A build that completes after its
 * generation has been superseded is discarded rather than published — the
 * second half of `deferred-work.md:529-565`, where an old-mode build could
 * publish *after* the invalidation meant to remove it.
 */
let syncGeneration = 0;

async function buildStripeSync(liveMode: boolean) {
  const { StripeSync } = await import("stripe-replit-sync");
  const secretKey = await getStripeSecretKey(liveMode);
  // If a webhook signing secret is configured for the active mode, pass it through
  // so signature verification uses it directly. When null, the library falls back
  // to the per-account managed-webhook secret stored in stripe._managed_webhooks.
  const webhookSecret = await getStripeWebhookSecret(liveMode);
  return new StripeSync({
    poolConfig: { connectionString: process.env.DATABASE_URL!, max: 2 },
    stripeSecretKey: secretKey,
    ...(webhookSecret ? { stripeWebhookSecret: webhookSecret } : {}),
  });
}

/**
 * Close a build the generation check rejected.
 *
 * "Dispose" would be an instruction with no referent: `grep -n "pool.end\|close()\|dispose"`
 * over `stripe-replit-sync/dist/index.js` returns nothing — the library exposes
 * no teardown. And the pool exists by the time any check can run, because
 * `PostgresClient`'s constructor calls `new pg.Pool(...)` synchronously
 * (`dist/index.js:34-38`, reached from `:565`). So dropping the reference is a
 * leak of one pool per delayed toggle; ending it is the only disposal available.
 */
async function discardRejectedBuild(build: Awaited<ReturnType<typeof buildStripeSync>>): Promise<void> {
  const pool = (build as unknown as { postgresClient?: { pool?: { end?: () => Promise<void>; ended?: boolean } } })
    .postgresClient?.pool;
  try {
    await pool?.end?.();
  } catch (err) {
    logger.warn({ err }, "Failed to close the pool of a superseded Stripe sync build");
  }
  discardedBuildPoolEnded = pool?.ended ?? null;
  discardedBuildCount++;
}

/**
 * Observability for the disposal above, test-only.
 *
 * `pool.ended` is read AFTER the end() resolves, so the assertion is that the
 * pool actually closed — not merely that a function was called. "Discarded"
 * without this assertion means "leaked once per delayed toggle".
 */
let discardedBuildPoolEnded: boolean | null = null;
let discardedBuildCount = 0;

export function __discardedBuildsForTests(): { count: number; lastPoolEnded: boolean | null } {
  return { count: discardedBuildCount, lastPoolEnded: discardedBuildPoolEnded };
}

/**
 * Test-only: close the pool of the currently cached sync, so a suite that
 * builds real StripeSync instances does not leave connections open.
 *
 * Deliberately NOT what `invalidateStripeSync()` does — disposal of previously
 * cached instances is documented deferred work with its own bugfix pass, and
 * this increment took only the disposal of a build its OWN generation check
 * creates and then rejects.
 */
export async function __endCachedSyncForTests(): Promise<void> {
  const current = stripeSync;
  stripeSync = null;
  stripeSyncLiveMode = null;
  discardedBuildPoolEnded = null;
  discardedBuildCount = 0;
  if (current) await discardRejectedBuild(current);
  discardedBuildPoolEnded = null;
  discardedBuildCount = 0;
}

/** Bounded so a toggle storm cannot spin here forever. */
const MAX_SYNC_BUILD_ATTEMPTS = 3;

export async function getStripeSync() {
  // Fast path, and the reason it reads the mode LENIENTLY.
  //
  // This function runs on every webhook — *before* signature validation, on the
  // one route exempted from the rate limiter because it has a signature gate.
  // Putting the strict (uncached, direct-row) read here would give an
  // unauthenticated flood one database round-trip each, which is the same
  // amplification the verification throttle exists to prevent, moved one layer
  // down.
  //
  // So the already-published instance is reused on exactly the terms it always
  // was: today's cached mode read, with today's staleness (`invalidateStripeSync()`
  // covers a local toggle; a toggle on another instance is noticed when the
  // config cache turns over, as before). Nothing here can certify an account —
  // this instance was verified strictly when it was built, and the moment a
  // build is actually needed the code below reads the mode strictly.
  const cachedMode = await isLiveMode();
  if (stripeSync && stripeSyncLiveMode === cachedMode) return stripeSync;

  for (let attempt = 0; attempt < MAX_SYNC_BUILD_ATTEMPTS; attempt++) {
    const generationAtStart = syncGeneration;
    const live = await captureModeForConstruction();

    // The lenient read disagreed with the row — either it was stale, or a
    // toggle raced back. The strict answer decides.
    if (stripeSync && stripeSyncLiveMode === live) return stripeSync;

    // Verification precedes construction, so a refusal means no sync object was
    // ever built for an unverified account — the invariant is "no client
    // exists", not "a client exists and callers are asked not to use it".
    const secretKey = await getStripeSecretKey(live);
    await verifyStripeAccount({ liveMode: live, secretKey });

    const built = await buildStripeSync(live);

    if (syncGeneration !== generationAtStart) {
      // A toggle landed while this build was in flight. Publishing it now would
      // reinstate the mode the invalidation just removed.
      await discardRejectedBuild(built);
      continue;
    }

    stripeSync = built;
    stripeSyncLiveMode = live;
    return stripeSync;
  }
  throw new StripeUnverifiedError(
    `The Stripe mode changed on every one of ${MAX_SYNC_BUILD_ATTEMPTS} construction attempts; ` +
      `no client is published for a mode that is no longer current.`,
    null,
  );
}

export function invalidateStripeSync() {
  stripeSync = null;
  stripeSyncLiveMode = null;
  syncGeneration++;
}

/** Test seam: return the current generation counter. */
export function __syncGenerationForTests(): number {
  return syncGeneration;
}
