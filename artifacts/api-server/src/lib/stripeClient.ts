import type Stripe from "stripe";
import { logger } from "./logger";
import {
  createRawStripeClient,
  stripePublishableVarFor,
  stripeSecretVarFor,
} from "./stripeRawClient.js";
import {
  readStripeLiveModeStrict,
  throttledRefusalFor,
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

  const secretVar = stripeSecretVarFor(useLive);
  const publishableVar = stripePublishableVarFor(useLive);

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
 * The client factory, indirected for ONE reason: `stripe@20` keeps the secret
 * in a private field, so a test cannot read back which credential the returned
 * client carries. Asserting only the *retrieval sequence* would pass against a
 * constructor that correctly re-verifies for the new mode and then hands back
 * the stale client anyway — a claim wider than what establishes it, which is
 * precisely the species this workstream keeps finding.
 */
let rawClientFactory: (secretKey: string) => Stripe = createRawStripeClient;

/** Test seam. Returns a restore function. */
export function __setRawClientFactoryForTests(fn: (secretKey: string) => Stripe): () => void {
  const previous = rawClientFactory;
  rawClientFactory = fn;
  return () => { rawClientFactory = previous; };
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
export async function getVerifiedStripeClient(): Promise<{ client: Stripe; liveMode: boolean }> {
  refuseIfThrottled(await isLiveMode());

  for (let attempt = 0; attempt < MAX_CONSTRUCTION_ATTEMPTS; attempt++) {
    const generationAtStart = constructionGeneration;
    const liveMode = await captureModeForConstruction();
    const { secretKey } = await getCredentials(liveMode);
    await verifyStripeAccount({ liveMode, secretKey });

    if (constructionGeneration !== generationAtStart) {
      // A toggle landed while this construction was verifying. Handing the
      // caller this client would hand them the mode that was just switched
      // away from — verified, correctly, for an account nobody is using now.
      // Nothing to dispose: unlike a StripeSync build, no client exists yet.
      continue;
    }
    return { client: rawClientFactory(secretKey), liveMode };
  }

  throw new StripeUnverifiedError(
    `The Stripe mode changed on every one of ${MAX_CONSTRUCTION_ATTEMPTS} construction attempts; ` +
      `no client is handed out for a mode that is no longer current.`,
    null,
  );
}

/**
 * The client alone, for the callers that do not gate on which mode they got.
 *
 * A caller whose SAFETY depends on the mode must use `getVerifiedStripeClient()`
 * and gate on the `liveMode` it returns — never on a separate read. Round 3
 * caught the difference: `/admin/stripe/test-event` refuses to run in live mode,
 * and it checked that through the lenient config-cached read while its client
 * was built from the strict one. On an instance that had not handled a toggle
 * those two disagree for the cache's TTL, so the route could pass its
 * "test mode only" gate and then create a real customer on the LIVE account.
 *
 * The two reads disagreeing is a consequence of THIS increment — before it, the
 * gate and the client resolved the mode through the same cached path, so they
 * always agreed. Returning the verified mode alongside the client is what makes
 * a gate and a mutation impossible to split.
 */
export async function getUncachableStripeClient() {
  return (await getVerifiedStripeClient()).client;
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
/**
 * Refuse now, on the cached mode, if an attempt for it just failed.
 *
 * This runs BEFORE the strict read, and that ordering is the point: the strict
 * read is an uncached row select, so without this an unauthenticated flood on
 * the webhook route would be throttled at the Stripe call and not at the
 * database. Reading `process.env` and a Map costs nothing.
 *
 * It can only ever WITHHOLD a client, never hand one out, so acting on a
 * possibly-stale mode here is safe — the strict read still decides everything
 * that grants access.
 */
function refuseIfThrottled(cachedMode: boolean): void {
  const secretKey = process.env[stripeSecretVarFor(cachedMode)];
  if (!secretKey) return;
  const refusal = throttledRefusalFor(cachedMode, secretKey);
  if (refusal) throw refusal;
}

async function captureModeForConstruction(): Promise<boolean> {
  try {
    const live = await readStripeLiveModeStrict();
    // Stamped only on success: a failed read establishes nothing about the
    // stored mode, so it must not postpone the next attempt to learn it.
    lastStrictModeReadAt = Date.now();
    return live;
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
 * Bumped by every `invalidateStripeSync()`, and read by BOTH exported
 * constructors. A construction that completes after its generation has been
 * superseded is discarded rather than handed out — the second half of
 * `deferred-work.md:529-565`, where an old-mode build could publish *after* the
 * invalidation meant to remove it.
 *
 * It has to cover both, and covering only the sync path was round 1's P1: the
 * verification in the middle of a construction is a network round-trip, so an
 * admin toggle has a whole Stripe timeout in which to commit a new mode while a
 * checkout sits waiting — and the caller would then mutate the account that is
 * no longer active. Guarding one of two constructors is the same asymmetry the
 * plan review already caught once, for verification itself.
 */
let constructionGeneration = 0;

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
/**
 * Test seam: make the next `getStripeSync()` re-read the stored mode, without
 * a test having to sleep out `SYNC_MODE_RECHECK_MS` in real time.
 *
 * A five-second sleep in a suite that runs in under thirty is both waste and a
 * timing dependency — the kind that passes on one machine and not another.
 */
export function __expireModeRecheckForTests(): void {
  lastStrictModeReadAt = 0;
}

export async function __endCachedSyncForTests(): Promise<void> {
  lastStrictModeReadAt = 0;
  const current = stripeSync;
  stripeSync = null;
  stripeSyncLiveMode = null;
  if (current) await discardRejectedBuild(current);
  discardedBuildPoolEnded = null;
  discardedBuildCount = 0;
}

/** Bounded so a toggle storm cannot spin either constructor forever. */
const MAX_CONSTRUCTION_ATTEMPTS = 3;

/**
 * How long a published sync may be reused before the stored mode is re-read
 * from the row rather than from the config cache.
 *
 * This is the middle of two bad extremes, and both were tried on this PR.
 *
 * A **strict read on every call** bounds staleness to zero and hands an
 * unauthenticated flood one uncached query each: `getStripeSync()` runs before
 * signature validation on the one route the rate limiter exempts *because* it
 * has a signature gate.
 *
 * **Never re-reading** — reusing a published sync purely on the lenient cached
 * mode — is what round 2 caught. A toggle only busts the config cache and
 * invalidates the sync on the instance that handled it; every other instance of
 * this autoscale deployment keeps both for the cache's full 60-second TTL, and
 * an admin sync or a webhook routed there operates against the previous account
 * and mixes its data into the shared database while the Billing surface already
 * reports the new mode.
 *
 * So: one row read per process per interval, whatever the request rate. The
 * flood costs at most one query per interval; the cross-instance window drops
 * from the cache's TTL to this. It does not make the fleet coherent — an
 * instance can still be this far behind, and full coherence needs shared state
 * that *Must Not Change* item 5 forbids here — it bounds how far.
 */
export const SYNC_MODE_RECHECK_MS = 5_000;

let lastStrictModeReadAt = 0;

export async function getStripeSync() {
  const cachedMode = await isLiveMode();
  const recheckDue = Date.now() - lastStrictModeReadAt >= SYNC_MODE_RECHECK_MS;
  if (stripeSync && stripeSyncLiveMode === cachedMode && !recheckDue) return stripeSync;
  refuseIfThrottled(cachedMode);

  for (let attempt = 0; attempt < MAX_CONSTRUCTION_ATTEMPTS; attempt++) {
    const generationAtStart = constructionGeneration;
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

    if (constructionGeneration !== generationAtStart) {
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
    `The Stripe mode changed on every one of ${MAX_CONSTRUCTION_ATTEMPTS} construction attempts; ` +
      `no client is published for a mode that is no longer current.`,
    null,
  );
}

export function invalidateStripeSync() {
  // Force the next call to re-read the row rather than trust the interval: a
  // local toggle is the one moment we KNOW the mode moved.
  lastStrictModeReadAt = 0;
  // The pool of the instance being dropped here is deliberately NOT ended, and
  // the omission is easy to mistake for an oversight now that a disposal helper
  // exists a few lines up. Disposal of PREVIOUSLY CACHED instances is separate,
  // documented work (`docs/engineering/deferred-work.md:528-563`) with its own
  // hazards — an in-flight caller may still hold this object. What this
  // increment took is disposal of a build its own generation check creates and
  // then rejects: a leak this code introduces, not one it inherits.
  stripeSync = null;
  stripeSyncLiveMode = null;
  constructionGeneration++;
}
