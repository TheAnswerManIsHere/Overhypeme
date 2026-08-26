/**
 * Stripe boot orchestration: the awaited verification attempt that runs
 * **before the port is bound**, the retry loop that recovers from an indefinite
 * answer without a restart, and the remaining initialization those two decide
 * whether to run.
 *
 * ## Why the boot attempt is measured against `app.listen()`, not against a function
 *
 * The requirement is positional. `initStripe()` used to be launched detached,
 * and putting the refusal outside its `catch` — or even outside that detached
 * launch — is necessary and *not sufficient*: `app.listen(port, …)` sits at
 * `index.ts:303` and the detached launch sat at `:409`, 106 lines later. A
 * refusal hoisted to the launch site is still awaited **after the process has
 * bound its port**, so a mismatched deployment opens for traffic, passes a
 * health check, and only then exits — a crash loop serving requests in between.
 * The test that holds this asserts *the port is never bound*, not that the
 * process eventually exits, because an eventual-exit assertion passes against
 * exactly the placement this paragraph rules out.
 *
 * ## Three outcomes, and conflating any two of them is the trap
 *
 * | Situation | Outcome |
 * | --- | --- |
 * | Credentials absent or incomplete | Unchanged from before this guard: the server boots without payments. This does not make Stripe configuration mandatory |
 * | Credentials present, expected account id absent | **Fatal at boot** — deterministic misconfiguration a retry cannot fix |
 * | Credentials present, account mismatched (Stripe answered) | **Fatal at boot**, before any mutation and before the port binds |
 * | Credentials present, answer indefinite (unreachable, timeout, 5xx, key rejected, mode unreadable) | **Boots without payments.** Payment paths refuse, verification retries, payments come online on a verified retry |
 *
 * A Stripe outage never takes the site down (David, 2026-08-26). Safety comes
 * from no client existing until its account verifies; fatality is operator
 * signal for a confirmed fact.
 */

import { logger } from "./logger";
import {
  BOOT_VERIFY_TIMEOUT_MS,
  VERIFY_RETRY_INTERVAL_MS,
  markModeUnconfigured,
  readStripeLiveModeStrict,
  verifyStripeAccount,
} from "./stripeAccountGuard.js";
import {
  StripeAccountMismatchError,
  StripeExpectedAccountMissingError,
} from "./stripeVerificationErrors.js";
import { getStripeSecretKey } from "./stripeClient.js";

export type StripeBootOutcome =
  | { kind: "verified"; liveMode: boolean }
  | { kind: "unconfigured" }
  | { kind: "pending"; reason: string }
  | { kind: "fatal"; reason: string };

/**
 * The remaining initialization — Stripe schema migrations, managed-webhook
 * registration, then the full backfill, in that order.
 *
 * Guarded to run **exactly once** across boot and every later retry. Before
 * this guard existed, a recovered retry restored client availability and left
 * the managed webhook unregistered and the mirror tables empty until the next
 * restart — "payments recover automatically" was true only for clients.
 */
let initializationStarted = false;

/**
 * The three effects the remaining initialization performs, injectable so a test
 * can assert the SEQUENCE and the exactly-once property without registering a
 * webhook on a real Stripe account. Production never passes anything.
 */
export interface StripeInitDeps {
  runSyncMigrations: (opts: { databaseUrl: string }) => Promise<unknown>;
  getSync: () => Promise<{
    findOrCreateManagedWebhook: (url: string) => Promise<unknown>;
    syncBackfill: (opts: { object: "all" }) => Promise<unknown>;
  }>;
  getSiteBaseUrl: () => string;
}

const productionDeps: StripeInitDeps = {
  runSyncMigrations: async (opts) => {
    const { runMigrations } = await import("stripe-replit-sync");
    return runMigrations(opts);
  },
  getSync: async () => {
    const { getStripeSync } = await import("./stripeClient");
    return getStripeSync();
  },
  getSiteBaseUrl: () => {
    // Resolved lazily and synchronously at the call site below.
    throw new Error("getSiteBaseUrl must be resolved before use");
  },
};

let deps: StripeInitDeps | null = null;

/** Test seam. Returns a restore function. */
export function __setStripeInitDepsForTests(next: StripeInitDeps): () => void {
  const previous = deps;
  deps = next;
  return () => {
    deps = previous;
  };
}

/** Test seam. */
export function __resetStripeInitForTests(): void {
  initializationStarted = false;
  stopStripeVerificationRetry();
  deterministicallyRefusedModes.clear();
}

export function hasStripeInitializationStarted(): boolean {
  return initializationStarted;
}

export async function resumeStripeInitialization(): Promise<void> {
  if (initializationStarted) return;
  initializationStarted = true;
  try {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      logger.warn("DATABASE_URL not set, skipping Stripe init");
      return;
    }

    const active = deps ?? {
      ...productionDeps,
      getSiteBaseUrl: (await import("./siteUrl")).getSiteBaseUrl,
    };

    await active.runSyncMigrations({ databaseUrl });
    logger.info("Stripe schema ready");

    const stripeSync = await active.getSync();

    const webhookUrl = `${active.getSiteBaseUrl()}/api/stripe/webhook`;
    // findOrCreateManagedWebhook registers the webhook endpoint and subscribes it to all
    // event types returned by getSupportedEventTypes() in stripe-replit-sync.  That list
    // must include every event that webhookHandlers.ts handles (currently:
    //   charge.refunded, charge.dispute.created, charge.dispute.closed,
    //   plus subscription/invoice events).
    // When adding a new handler, ensure the matching event type is also present in
    // getSupportedEventTypes() so Stripe actually delivers the event to this endpoint.
    //
    // This is the first Stripe MUTATION of the boot sequence, and the whole
    // reason verification is awaited before the port binds: it used to run
    // BEFORE the account comparison, so a live key in the test variable
    // registered a webhook on the live account and then backfilled it.
    await stripeSync.findOrCreateManagedWebhook(webhookUrl);
    logger.info({ webhookUrl }, "Stripe webhook configured");

    void stripeSync.syncBackfill({ object: "all" })
      .then(() => logger.info("Stripe backfill complete"))
      .catch((err: unknown) => logger.error({ err }, "Stripe backfill error"));
  } catch (err) {
    logger.error({ err }, "Stripe init failed — continuing without payments");
  }
}

/** Bound the awaited boot attempt so a Stripe outage delays boot, never blocks it. */
async function withBootTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Stripe account verification did not answer within ${BOOT_VERIFY_TIMEOUT_MS}ms`)),
          BOOT_VERIFY_TIMEOUT_MS,
        );
        // Never hold the event loop open on account of this timer.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The awaited boot phase. Call this before `app.listen()`; the caller exits the
 * process on `kind: "fatal"` and boots on everything else.
 */
export async function runStripeBootVerification(): Promise<StripeBootOutcome> {
  let liveMode: boolean;
  try {
    liveMode = await readStripeLiveModeStrict();
  } catch (err) {
    // Indefinite: the mode is unreadable, so no credential can be trusted to
    // belong to it. Never defaulted to "test" — that is how a guard ends up
    // verifying the test account while the stored mode is live.
    const reason = `The stored Stripe mode could not be read: ${err instanceof Error ? err.message : String(err)}`;
    logger.error({ err }, "Stripe account verification deferred — the stored mode is unreadable");
    return { kind: "pending", reason };
  }

  let secretKey: string;
  try {
    secretKey = await getStripeSecretKey(liveMode);
  } catch (err) {
    // Credentials absent or incomplete. Unchanged from today: boot without
    // payments. This path starts no verification and arms no retry, so the
    // status it publishes is terminal.
    const reason = err instanceof Error ? err.message : String(err);
    markModeUnconfigured(liveMode, reason);
    logger.warn({ err }, "Stripe credentials are not configured — booting without payments");
    return { kind: "unconfigured" };
  }

  try {
    await withBootTimeout(verifyStripeAccount({ liveMode, secretKey, force: true }));
    return { kind: "verified", liveMode };
  } catch (err) {
    if (
      err instanceof StripeAccountMismatchError ||
      err instanceof StripeExpectedAccountMissingError
    ) {
      return { kind: "fatal", reason: err.message };
    }
    const reason = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Stripe account could not be verified — booting with payments refused");
    return { kind: "pending", reason };
  }
}

/**
 * Modes whose refusal is deterministic for this process: a confirmed mismatch,
 * or a missing expected id. Retrying those on an interval would hammer Stripe
 * for an answer that cannot change without an environment change, which needs a
 * restart anyway. A *toggle* to another mode still gets its own attempt.
 */
const deterministicallyRefusedModes = new Set<"live" | "test">();

let retryTimer: NodeJS.Timeout | null = null;

export function stopStripeVerificationRetry(): void {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

/**
 * One retry pass. Exported for tests so recovery can be asserted without
 * waiting on a real interval.
 */
export async function runStripeVerificationRetryOnce(): Promise<void> {
  let liveMode: boolean;
  try {
    liveMode = await readStripeLiveModeStrict();
  } catch (err) {
    logger.warn({ err }, "Stripe verification retry: the stored mode is still unreadable");
    return;
  }

  const mode = liveMode ? "live" : "test";
  if (deterministicallyRefusedModes.has(mode)) return;

  let secretKey: string;
  try {
    secretKey = await getStripeSecretKey(liveMode);
  } catch (err) {
    markModeUnconfigured(liveMode, err instanceof Error ? err.message : String(err));
    return;
  }

  try {
    await verifyStripeAccount({ liveMode, secretKey, force: true });
  } catch (err) {
    if (
      err instanceof StripeAccountMismatchError ||
      err instanceof StripeExpectedAccountMissingError
    ) {
      // Post-boot, a confirmed wrong account does NOT kill the server: the
      // process stays up and payments stay refused, loudly. Fatality is
      // boot-only — a PATCH or a retry must never terminate a healthy server.
      deterministicallyRefusedModes.add(mode);
      logger.error({ err, mode }, "STRIPE ACCOUNT REFUSED — payments stay unavailable in this mode");
      return;
    }
    logger.warn({ err, mode }, "Stripe verification retry did not succeed; will try again");
    return;
  }

  // Verified — and this verification is for the mode the server actually reads,
  // which is the condition that makes resumption safe. A verification for an
  // INACTIVE target mode (a toggle probe) never reaches here: the loop only
  // ever attempts the stored mode.
  stopStripeVerificationRetry();
  logger.info({ mode }, "Stripe account verified on retry — resuming Stripe initialization");
  await resumeStripeInitialization();
}

function armStripeVerificationRetry(): void {
  if (retryTimer) return;
  retryTimer = setInterval(() => {
    void runStripeVerificationRetryOnce().catch((err: unknown) =>
      logger.error({ err }, "Stripe verification retry pass threw"),
    );
  }, VERIFY_RETRY_INTERVAL_MS);
  retryTimer.unref?.();
}

/**
 * Called immediately after the port is bound. Runs the remaining initialization
 * on a verified boot, or arms the retry loop on an indefinite one.
 *
 * `unconfigured` does neither: it is a terminal state for an integration nobody
 * enabled, and polling or retrying it would report an intentional absence as a
 * temporary fault.
 */
export function startStripeAfterBoot(outcome: StripeBootOutcome): void {
  if (outcome.kind === "verified") {
    void resumeStripeInitialization();
    return;
  }
  if (outcome.kind === "pending") {
    armStripeVerificationRetry();
  }
}
