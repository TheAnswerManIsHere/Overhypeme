/**
 * The Stripe account guard.
 *
 * **The property it delivers:** no Stripe client or sync object is handed to
 * any caller until the account behind its credential has been verified against
 * the account this environment declared for that mode. `stripeClient.ts` is the
 * only construction site in the tracked repo and both of its exported
 * constructors go through here, so boot, the mode toggle, checkout and the
 * admin mutation routes are covered by one boundary rather than by an
 * enumeration of callers that has to stay complete.
 *
 * Withholding the client is the safety mechanism. Refusing to boot is operator
 * signal for the one case where the wrong account is a *fact* — see
 * `stripeVerificationErrors.ts` for why those two things are separated.
 *
 * ## Four things here are load-bearing and easy to undo by accident
 *
 * 1. **The account is read with `stripe.accounts.retrieve()` on a raw client,
 *    never with the sync library's `getAccountId()`.** That helper returns an
 *    in-memory cached id; failing that, an id looked up from the LOCAL database
 *    by API-key hash *without contacting Stripe*; and on a miss it calls Stripe
 *    and then **upserts the account row and the key hash**
 *    (`stripe-replit-sync/dist/index.js:577-604`). A first mismatched boot
 *    therefore stores the wrong account against that key's hash and every later
 *    boot resolves it locally — a guard built on it grows quieter precisely in
 *    the case it exists to catch. `accounts.retrieve()` with no argument maps at
 *    the pinned `stripe@20.0.0` to `{ method: 'GET', fullPath: '/v1/account' }`
 *    (`node_modules/stripe/cjs/resources/Accounts.js:22-27`): non-mutating, and
 *    `/v1/account` takes no account parameter so it can only resolve to the
 *    account behind the presented key.
 *
 * 2. **The mode read propagates failure and bypasses the config cache.**
 *    `isLiveMode()` answers `"test"` for both "stored as test" and "the lookup
 *    threw", through two nested catches. And `loadAll()` has no in-flight
 *    tracking, so a read started before a toggle can complete after
 *    `bustConfigCache()` and republish pre-write rows for another ~60 seconds
 *    (`deferred-work.md:500-506`). Either one lets the guard verify mode A and
 *    hand back a client for mode B — stamped as verified, which is worse than
 *    no guard at all. So `readStripeLiveModeStrict()` selects the row directly
 *    and throws rather than defaulting.
 *
 * 3. **The memo caches successes only.** A cached rejection would pin payments
 *    off until restart and silently defeat the retry loop, turning one transient
 *    Stripe blip into a permanent outage of the payment paths
 *    (`deferred-work.md:541-546`).
 *
 * 4. **Retrieval is single-flight and interval-bound.** `getStripeSync()` runs
 *    BEFORE signature validation in `webhookHandlers.processWebhook`, on the one
 *    route exempted from the rate limiter *because* it has a signature gate
 *    (`rateLimit.ts:55`). With failures deliberately never memoised, forged
 *    requests would otherwise drive one `accounts.retrieve()` each. Both
 *    properties are needed together: single-flight alone still lets sequential
 *    forgeries through, and an interval alone is a cache of a rejection, which
 *    is what point 3 forbids. The reconciliation is that the throttle records
 *    only *when the last attempt ran*, never a verdict — every caller inside the
 *    window is refused with a **fresh, non-authoritative** error, the entry
 *    expires on its own, and the retry loop passes `force` so it is never
 *    throttled. Payments therefore still recover with no restart.
 */

import { createHash } from "node:crypto";
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { adminConfigTable } from "@workspace/db/schema";
import { logger } from "./logger";
import {
  STRIPE_MAX_NETWORK_RETRIES,
  STRIPE_REQUEST_TIMEOUT_MS,
} from "./membershipTiming.js";
import {
  StripeAccountMismatchError,
  StripeExpectedAccountMissingError,
  StripeUnverifiedError,
} from "./stripeVerificationErrors.js";

/**
 * How long after a failed attempt a *caller-driven* verification is refused
 * without calling Stripe. Bounds forged-webhook amplification to one retrieval
 * per mode+credential per window. The retry loop's interval is a multiple of
 * this, so the throttle never delays recovery.
 */
export const VERIFY_THROTTLE_MS = 5_000;

/** How often the background loop re-attempts while the stored mode is unverified. */
export const VERIFY_RETRY_INTERVAL_MS = 30_000;

/** Ceiling on the awaited boot attempt, so a Stripe outage delays boot by at most this. */
export const BOOT_VERIFY_TIMEOUT_MS = STRIPE_REQUEST_TIMEOUT_MS + 2_000;

export type StripeVerificationState =
  | "unconfigured"
  | "pending"
  | "verified"
  | "refused";

export interface StripeVerificationStatus {
  state: StripeVerificationState;
  /** "live" | "test", or null when the mode itself could not be read. */
  mode: "live" | "test" | null;
  /** Operator-facing reason for a non-verified state. Never carries a secret. */
  reason: string | null;
  lastAttemptAt: string | null;
  /**
   * The responding process. The deployment is `autoscale` with the server in
   * every instance (`.replit:29`, `architecture-map.md:227-230`), so this value
   * is process-local and the summary endpoint answers from whichever instance
   * the router picked. Labelling it is not decoration: an unlabelled value would
   * let one healthy instance report recovery for a fleet that has not recovered.
   */
  instanceId: string;
  /** Always "instance". A fleet aggregate needs shared state and is out of scope. */
  scope: "instance";
}

/** Per-mode state. Verification state is per mode, never one global flag. */
interface ModeState {
  state: StripeVerificationState;
  reason: string | null;
  lastAttemptAt: number | null;
}

const modeState = new Map<"live" | "test", ModeState>();

/** Successes only. Key is mode + a hash of the credential — never the credential. */
const verified = new Set<string>();

/** In-flight attempts, so concurrent callers share one retrieval. */
const inFlight = new Map<string, Promise<void>>();

/**
 * When the last attempt for a key ran — and, for the one outcome that cannot
 * change, what it was.
 *
 * `at` is a timestamp, deliberately not a verdict: an INDEFINITE outcome leaves
 * nothing here but the time, so a caller inside the window is refused with a
 * fresh non-authoritative error and the entry expires on its own. That is what
 * keeps a transient Stripe blip from pinning payments off until restart.
 *
 * `definiteMismatchReason` is the exception, and it is narrow on purpose. A
 * CONFIRMED mismatch is a fact: Stripe answered and the account is wrong. Losing
 * that inside the throttle window would report a definite wrong account as
 * "could not tell", which is the same conflation of definite and indefinite this
 * guard exists to end — just in the other direction. It is still not the
 * forbidden memo: it expires with the window, every `force` caller (the boot
 * phase, the retry loop, the mode toggle) re-asks Stripe regardless, and the
 * hazard decision 8 names — a rejection that survives until restart — cannot
 * occur. The missing-expected-id case never reaches here; it short-circuits
 * above without a Stripe call.
 */
interface AttemptRecord {
  at: number;
  definiteMismatchReason?: string;
}
const lastAttempt = new Map<string, AttemptRecord>();

function memoKey(liveMode: boolean, secretKey: string): string {
  // The credential never leaves this process in any form; the hash exists so
  // rotating a key invalidates its verification without ever storing the key.
  return `${liveMode ? "live" : "test"}:${createHash("sha256").update(secretKey).digest("hex")}`;
}

function modeName(liveMode: boolean): "live" | "test" {
  return liveMode ? "live" : "test";
}

function setModeState(liveMode: boolean, next: ModeState): void {
  modeState.set(modeName(liveMode), next);
}

/**
 * Read `stripe_live_mode` straight from the row.
 *
 * Neither `loadAll()`'s cache nor its TTL, and no default on failure — see
 * point 2 in the module header. `isLiveMode()`'s lenient behavior is untouched
 * for its other callers; this is an additional strict read, not a rewrite.
 */
/** Counts direct-row mode reads, so the hot-path amplification claim has an oracle. */
let strictModeReads = 0;
export function __strictModeReadsForTests(): number {
  return strictModeReads;
}

export async function readStripeLiveModeStrict(): Promise<boolean> {
  strictModeReads++;
  const rows = await db
    .select({ value: adminConfigTable.value })
    .from(adminConfigTable)
    .where(eq(adminConfigTable.key, "stripe_live_mode"))
    .limit(1);
  // An absent row is a readable answer, not a failure: the seed has never run
  // or the key was removed, and both mean "not live". A read that THREW is what
  // must not resolve to a mode, and it propagates.
  return rows[0]?.value === "true";
}

/** The account id this environment declares for a mode. */
export function expectedAccountIdFor(liveMode: boolean): string | undefined {
  return liveMode
    ? process.env.STRIPE_ACCOUNT_ID_LIVE
    : process.env.STRIPE_ACCOUNT_ID_TEST;
}

/** The env var name to name in a refusal, so an operator knows what to correct. */
export function expectedAccountVarFor(liveMode: boolean): string {
  return liveMode ? "STRIPE_ACCOUNT_ID_LIVE" : "STRIPE_ACCOUNT_ID_TEST";
}

function secretVarFor(liveMode: boolean): string {
  return liveMode ? "STRIPE_SECRET_KEY_LIVE" : "STRIPE_SECRET_KEY_TEST";
}

/**
 * Overridable so tests can assert the account read without reaching Stripe.
 * Production always uses the real implementation below.
 */
let retrieveAccountId: (secretKey: string) => Promise<string> = async (secretKey) => {
  const stripe = new Stripe(secretKey, {
    apiVersion: "2025-08-27.basil" as Stripe.LatestApiVersion,
    timeout: STRIPE_REQUEST_TIMEOUT_MS,
    maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
  });
  // No argument: GET /v1/account, which resolves to the account behind THIS
  // key. Never `getAccountId()` — see point 1 in the module header.
  const account = await stripe.accounts.retrieve();
  return account.id;
};

/** Test seam. Returns a restore function. */
export function __setAccountRetrieverForTests(
  fn: (secretKey: string) => Promise<string>,
): () => void {
  const previous = retrieveAccountId;
  retrieveAccountId = fn;
  return () => {
    retrieveAccountId = previous;
  };
}

/** Test seam: drop every memo, throttle and per-mode state. */
export function __resetVerificationStateForTests(): void {
  verified.clear();
  inFlight.clear();
  lastAttempt.clear();
  modeState.clear();
  strictModeReads = 0;
}

/**
 * Verify that `secretKey` belongs to the account declared for `liveMode`.
 *
 * Resolves on success. Rejects with exactly one of the three typed errors —
 * whether a rejection is fatal is the *caller's* decision, and only the boot
 * phase ever makes it fatal.
 */
export async function verifyStripeAccount(params: {
  liveMode: boolean;
  secretKey: string;
  /** The retry loop and the boot attempt set this; caller-driven paths do not. */
  force?: boolean;
}): Promise<void> {
  const { liveMode, secretKey, force = false } = params;
  const key = memoKey(liveMode, secretKey);

  if (verified.has(key)) return;

  const expected = expectedAccountIdFor(liveMode);
  if (!expected) {
    // Deterministic misconfiguration: credentials are present and the
    // environment never said which account they may touch. No Stripe call —
    // there is nothing a retrieval could tell us that changes this.
    const reason =
      `${expectedAccountVarFor(liveMode)} is not set, but ${secretVarFor(liveMode)} is. ` +
      `Set ${expectedAccountVarFor(liveMode)} to the account id these credentials belong to.`;
    setModeState(liveMode, { state: "refused", reason, lastAttemptAt: Date.now() });
    throw new StripeExpectedAccountMissingError(reason, liveMode);
  }

  const existing = inFlight.get(key);
  if (existing) {
    // Single-flight: concurrent callers — including a burst of forged webhook
    // requests — share the one retrieval already running.
    await existing;
    return;
  }

  if (!force) {
    const last = lastAttempt.get(key);
    if (last !== undefined && Date.now() - last.at < VERIFY_THROTTLE_MS) {
      // Interval-bound: one retrieval per mode+credential per window, however
      // many callers arrive. The error is minted fresh each time and the entry
      // expires without anyone clearing it.
      if (last.definiteMismatchReason !== undefined) {
        throw new StripeAccountMismatchError(last.definiteMismatchReason, liveMode);
      }
      throw new StripeUnverifiedError(
        `Stripe account verification for ${modeName(liveMode)} mode was attempted less than ` +
          `${VERIFY_THROTTLE_MS}ms ago and has not succeeded; not re-contacting Stripe yet.`,
        liveMode,
      );
    }
  }

  const attempt = (async () => {
    lastAttempt.set(key, { at: Date.now() });
    let actual: string;
    try {
      actual = await retrieveAccountId(secretKey);
    } catch (err) {
      // Indefinite, every one of them: unreachable, timeout, 5xx, rejected key.
      // A rejected key is grouped here deliberately — it cannot mutate anything
      // because every call fails, so killing the site over it would convert a
      // harmless misconfiguration into an outage.
      const reason =
        `Could not verify the Stripe account for ${modeName(liveMode)} mode: ` +
        `${err instanceof Error ? err.message : String(err)}`;
      setModeState(liveMode, { state: "pending", reason, lastAttemptAt: Date.now() });
      throw new StripeUnverifiedError(reason, liveMode);
    }

    if (actual !== expected) {
      // Definite. Stripe answered and the answer is wrong.
      const reason =
        `STRIPE ACCOUNT MISMATCH — ${secretVarFor(liveMode)} belongs to account ${actual}, ` +
        `but ${expectedAccountVarFor(liveMode)} declares ${expected}. ` +
        `Correct ${secretVarFor(liveMode)} (or ${expectedAccountVarFor(liveMode)} if the declaration is wrong).`;
      setModeState(liveMode, { state: "refused", reason, lastAttemptAt: Date.now() });
      lastAttempt.set(key, { at: Date.now(), definiteMismatchReason: reason });
      throw new StripeAccountMismatchError(reason, liveMode);
    }

    verified.add(key);
    setModeState(liveMode, { state: "verified", reason: null, lastAttemptAt: Date.now() });
    logger.info(
      { liveMode, accountId: actual },
      "Stripe account verified — credentials belong to the declared account",
    );
  })();

  inFlight.set(key, attempt);
  try {
    await attempt;
  } finally {
    inFlight.delete(key);
    // A rejection is evicted the moment the attempt settles, before it reaches
    // any caller. Nothing anywhere caches a failed verdict.
  }
}

/** True when this mode+credential has already verified. Never calls Stripe. */
export function isAccountVerified(liveMode: boolean, secretKey: string): boolean {
  return verified.has(memoKey(liveMode, secretKey));
}

/** Record the credentials-absent state, which is terminal and unpolled. */
export function markModeUnconfigured(liveMode: boolean | null, reason: string): void {
  if (liveMode === null) return;
  setModeState(liveMode, { state: "unconfigured", reason, lastAttemptAt: null });
}

/**
 * The status for the summary endpoint, for a mode.
 *
 * `liveMode === null` means the mode itself could not be read, which is an
 * indefinite answer like any other: `pending`, with the reason saying so.
 */
export function getVerificationStatus(
  liveMode: boolean | null,
  instanceId: string,
): StripeVerificationStatus {
  if (liveMode === null) {
    return {
      state: "pending",
      mode: null,
      reason: "The stored Stripe mode could not be read; verification cannot run until it can.",
      lastAttemptAt: null,
      instanceId,
      scope: "instance",
    };
  }
  const current = modeState.get(modeName(liveMode));
  if (!current) {
    return {
      state: "pending",
      mode: modeName(liveMode),
      reason: "Verification has not run yet in this process.",
      lastAttemptAt: null,
      instanceId,
      scope: "instance",
    };
  }
  return {
    state: current.state,
    mode: modeName(liveMode),
    reason: current.reason,
    lastAttemptAt: current.lastAttemptAt === null ? null : new Date(current.lastAttemptAt).toISOString(),
    instanceId,
    scope: "instance",
  };
}
