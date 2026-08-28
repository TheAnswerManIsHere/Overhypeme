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
  hasVerificationAttemptFor,
  markModeUnconfigured,
  readStripeLiveModeStrict,
  verifyStripeAccount,
} from "./stripeAccountGuard.js";
import { isDefiniteVerificationFailure } from "./stripeVerificationErrors.js";
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
/**
 * Set only once the REQUIRED setup has actually succeeded.
 *
 * The distinction between "started" and "completed" is the whole point, and
 * getting it wrong was round 2's P1: marking initialization done up front meant
 * a transient failure in migrations, sync construction or webhook registration
 * was caught, logged, and then permanent — the retry timer already stopped, the
 * state still reporting `verified`, and checkout live while the managed webhook
 * was never registered. That is precisely the outcome settled decision 9 exists
 * to prevent, reached through a transient error instead of a missing hook.
 *
 * Required means webhook registration. The backfill stays fire-and-forget, as
 * it has always been — awaiting it here would change the boot sequence's
 * timing, which *Must Not Change* item 2 pins.
 */
let initializationCompleted = false;

/**
 * The in-flight attempt, so concurrent callers join it rather than starting a
 * second one. A single boolean cannot do both jobs: as a completion flag it
 * lets a transient failure become permanent, and as a re-entrancy guard alone
 * it lets two callers run the sequence at once.
 */
let initializationInFlight: Promise<boolean> | null = null;

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

/**
 * `getSiteBaseUrl` is absent here rather than stubbed: it is resolved by an
 * `await import` at the one call site, and a placeholder that throws would look
 * like a production implementation while being unreachable — a trap for the next
 * caller, who would get a runtime throw instead of a type error.
 */
const productionDeps: Omit<StripeInitDeps, "getSiteBaseUrl"> = {
  runSyncMigrations: async (opts) => {
    const { runMigrations } = await import("stripe-replit-sync");
    return runMigrations(opts);
  },
  getSync: async () => {
    const { getStripeSync } = await import("./stripeClient");
    return getStripeSync();
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
  initializationCompleted = false;
  initializationInFlight = null;
  stopStripeVerificationRetry();
  deterministicallyRefusedModes.clear();
  verificationKickInFlight = false;
}

export function hasStripeInitializationCompleted(): boolean {
  return initializationCompleted;
}

/**
 * Run the remaining initialization — Stripe schema migrations, managed-webhook
 * registration, then the full backfill, in that order.
 *
 * Resolves `true` when the required setup completed (now or earlier), `false`
 * when it failed and is still owed. The caller keeps the retry loop armed on
 * `false`, so a transient failure is retried rather than remembered as success.
 */
export async function resumeStripeInitialization(): Promise<boolean> {
  if (initializationCompleted) return true;
  if (initializationInFlight) return initializationInFlight;

  const attempt = (async (): Promise<boolean> => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      logger.warn("DATABASE_URL not set, skipping Stripe init");
      // Not a transient failure to retry: nothing about this recovers on an
      // interval, and retrying it would log the same line forever.
      initializationCompleted = true;
      return true;
    }

    try {
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

      // Required setup is done. The backfill below is fire-and-forget exactly as
      // it has always been, so its failure logs and does not reopen this.
      initializationCompleted = true;

      void stripeSync.syncBackfill({ object: "all" })
        .then(() => logger.info("Stripe backfill complete"))
        .catch((err: unknown) => logger.error({ err }, "Stripe backfill error"));

      return true;
    } catch (err) {
      logger.error({ err }, "Stripe init failed — will retry; continuing without payments");
      return false;
    }
  })();

  initializationInFlight = attempt;
  try {
    return await attempt;
  } finally {
    initializationInFlight = null;
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
    if (isDefiniteVerificationFailure(err)) {
      return { kind: "fatal", reason: err instanceof Error ? err.message : String(err) };
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
  // Cheap skip first, on the cached mode. A mode whose refusal is deterministic
  // cannot change answer without an environment change, so re-deriving it every
  // 30 seconds for the life of the process — in every autoscale instance — buys
  // nothing, and the strict read that would tell us the mode is itself an
  // uncached query. `bustConfigCache()` runs on the toggle, so a mode change
  // still reaches this read promptly and recovery-by-toggle keeps working; that
  // is why the timer is left ARMED rather than stopped here.
  const { isLiveMode } = await import("./stripeClient.js");
  if (deterministicallyRefusedModes.has((await isLiveMode()) ? "live" : "test")) return;

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
    if (isDefiniteVerificationFailure(err)) {
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
  logger.info({ mode }, "Stripe account verified on retry — resuming Stripe initialization");
  const completed = await resumeStripeInitialization();

  // The timer stops only once the required setup has actually succeeded.
  // Stopping it on verification alone is what made a transient webhook failure
  // permanent: nothing was left to try again, and the state still said verified.
  if (completed) stopStripeVerificationRetry();
  else logger.warn({ mode }, "Stripe initialization did not complete — keeping the retry armed");
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
 * Start verification for a stored mode this process has never attempted.
 *
 * Round 5's case, and it is specific to autoscale: when ANOTHER instance
 * commits a mode toggle, this process has no state for the newly active mode —
 * and a normally successful boot has already stopped its retry timer, or never
 * armed one. Nothing here is scheduled to verify the new mode. The Billing
 * poll only reads a pure getter, so it would report `pending` with
 * "Verification has not run yet" indefinitely, and keep polling forever, while
 * claiming to be actively verifying. The status was transitional and nothing
 * was in transit.
 *
 * So detecting an unseen active mode STARTS verification rather than
 * publishing a passive state: one pass now, and the retry loop armed so a
 * failure of that pass is not the end of it. Both are idempotent — the arm is a
 * no-op while a timer exists, and the pass is skipped while one is in flight —
 * and the whole thing stops calling itself as soon as any outcome is recorded
 * for the mode, which every terminating path of a pass does.
 */
export function ensureVerificationArmedFor(liveMode: boolean | null): void {
  // A mode that cannot be read is not a mode that can be verified. That is an
  // indefinite answer the caller already renders as pending with its own
  // reason, and it recovers through the read, not through this.
  if (liveMode === null) return;
  if (hasVerificationAttemptFor(liveMode)) return;

  armStripeVerificationRetry();

  if (verificationKickInFlight) return;
  verificationKickInFlight = true;
  void runStripeVerificationRetryOnce()
    .catch((err: unknown) => logger.error({ err }, "Stripe verification pass for a newly active mode threw"))
    .finally(() => {
      verificationKickInFlight = false;
    });
}

let verificationKickInFlight = false;

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
    // Arm the loop on failure here too. A verified boot whose webhook
    // registration then fails transiently would otherwise leave the integration
    // half-initialized with nothing scheduled to finish it.
    void resumeStripeInitialization().then((completed) => {
      if (!completed) armStripeVerificationRetry();
    });
    return;
  }
  if (outcome.kind === "pending") {
    armStripeVerificationRetry();
  }
}
