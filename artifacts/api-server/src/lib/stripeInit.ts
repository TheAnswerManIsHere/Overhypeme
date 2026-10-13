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
  getVerificationStatus,
  hasVerificationAttemptFor,
  markModeUnconfigured,
  readStripeLiveModeStrict,
  verifyStripeAccount,
} from "./stripeAccountGuard.js";
import { isDefiniteVerificationFailure } from "./stripeVerificationErrors.js";
import { getStripeSecretKey } from "./stripeClient.js";
import type { StripeSetupSnapshot } from "@workspace/api-zod";

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
const completedModes = new Set<"live" | "test">();

/**
 * Set when there is nothing to initialize at all (no `DATABASE_URL`). Not a
 * mode's completion: no mode was ever initialized, and nothing about that
 * recovers on an interval.
 */
let initializationNotApplicable = false;

/**
 * The in-flight attempt, so concurrent callers join it rather than starting a
 * second one. A single boolean cannot do both jobs: as a completion flag it
 * lets a transient failure become permanent, and as a re-entrancy guard alone
 * it lets two callers run the sequence at once.
 */
const initializationInFlight = new Map<"live" | "test", Promise<boolean>>();

/** The setup steps after verification, named so a failure can say which one. */
type SetupStep = "migrations" | "sync" | "webhook";

/**
 * Fixed, operator-facing sentences — never the raw error, which can carry
 * Stripe's own text. The error itself is in the log line the catch writes.
 */
const SETUP_FAILURE_REASONS: Record<SetupStep, string> = {
  migrations:
    "Stripe setup failed preparing the Stripe tables in the database; retrying automatically. Details are in the server log.",
  sync:
    "Stripe setup failed connecting to the verified Stripe account; retrying automatically. Details are in the server log.",
  webhook:
    "Stripe setup failed registering the webhook, so Stripe's events (new subscriptions, refunds) are not reaching this instance; retrying automatically. Details are in the server log.",
};

/**
 * The last setup failure per mode, cleared when setup completes for that mode.
 * Without it, a setup that kept failing was visible only in the log while the
 * Billing panel read `verified` — the observability half of #577's P1.
 */
const setupFailures = new Map<"live" | "test", { step: SetupStep; at: number }>();

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
    /** The mode this sync was verified for; `null` when it is no longer published. */
    liveMode: boolean | null;
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
    const { getStripeSync, liveModeOfPublishedStripeSync } = await import("./stripeClient");
    const sync = await getStripeSync();
    return {
      findOrCreateManagedWebhook: (url: string) => sync.findOrCreateManagedWebhook(url),
      syncBackfill: (opts: { object: "all" }) => sync.syncBackfill(opts),
      liveMode: liveModeOfPublishedStripeSync(sync),
    };
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
  completedModes.clear();
  initializationNotApplicable = false;
  initializationInFlight.clear();
  setupFailures.clear();
  stopStripeVerificationRetry();
  deterministicallyRefusedModes.clear();
  verificationKickInFlight = false;
}

/**
 * Whether the required setup has completed — for `liveMode` when given, or for
 * any mode when omitted.
 */
export function hasStripeInitializationCompleted(liveMode?: boolean): boolean {
  if (initializationNotApplicable) return true;
  if (liveMode === undefined) return completedModes.size > 0;
  return completedModes.has(liveMode ? "live" : "test");
}

/**
 * This instance's setup state for a mode, for the Billing summary. Meaningful
 * only once the mode is verified; the summary attaches it only then.
 */
export function getStripeSetupStatus(liveMode: boolean): StripeSetupSnapshot {
  if (hasStripeInitializationCompleted(liveMode)) {
    return { state: "complete", reason: null, lastFailureAt: null };
  }
  const failure = setupFailures.get(liveMode ? "live" : "test");
  if (failure) {
    return {
      state: "failing",
      reason: SETUP_FAILURE_REASONS[failure.step],
      lastFailureAt: new Date(failure.at).toISOString(),
    };
  }
  return {
    state: "in_progress",
    reason: "Stripe setup (webhook registration) has not finished on this instance yet.",
    lastFailureAt: null,
  };
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
  if (initializationNotApplicable) return true;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.warn("DATABASE_URL not set, skipping Stripe init");
    // Not a transient failure to retry: nothing about this recovers on an
    // interval, and retrying it would log the same line forever.
    initializationNotApplicable = true;
    return true;
  }

  // Completion is PER MODE. Each mode is a different Stripe account, and the
  // managed webhook is registered on the account, so a process that finished
  // setup for test mode has done nothing for live mode. One process-wide flag
  // let every switch of the active mode after the first completed (or skipped)
  // setup leave the new account with no webhook: payments read "verified" and
  // Stripe's events never arrived until a restart.
  let liveMode: boolean;
  try {
    liveMode = await readStripeLiveModeStrict();
  } catch (err) {
    logger.warn({ err }, "Stripe init: the stored mode is unreadable — will retry");
    return false;
  }
  const mode = liveMode ? "live" : "test";
  if (completedModes.has(mode)) return true;
  const joined = initializationInFlight.get(mode);
  if (joined) return joined;

  const attempt = (async (): Promise<boolean> => {
    let step: SetupStep = "migrations";
    try {
      const active = deps ?? {
        ...productionDeps,
        getSiteBaseUrl: (await import("./siteUrl")).getSiteBaseUrl,
      };

      await active.runSyncMigrations({ databaseUrl });
      logger.info("Stripe schema ready");

      step = "sync";
      const stripeSync = await active.getSync();

      // Bind the mutation below to this attempt's mode BEFORE it happens.
      // `getStripeSync()` does its own strict read, so a toggle committed since
      // this attempt read the row hands back a sync for the OTHER account — and
      // a row re-read afterwards cannot tell (test → live → test passes it after
      // registering only the live webhook). A mismatch mutates nothing and
      // returns `false`, so the caller's armed retry runs setup for whichever
      // mode is then stored.
      if (stripeSync.liveMode !== liveMode) {
        logger.warn({ mode }, "Stripe sync was built for another mode — not initializing this one now");
        return false;
      }

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
      step = "webhook";
      await stripeSync.findOrCreateManagedWebhook(webhookUrl);
      logger.info({ webhookUrl }, "Stripe webhook configured");

      // Required setup is done. The backfill below is fire-and-forget exactly as
      // it has always been, so its failure logs and does not reopen this.
      completedModes.add(mode);
      setupFailures.delete(mode);

      void stripeSync.syncBackfill({ object: "all" })
        .then(() => logger.info("Stripe backfill complete"))
        .catch((err: unknown) => logger.error({ err }, "Stripe backfill error"));

      return true;
    } catch (err) {
      setupFailures.set(mode, { step, at: Date.now() });
      logger.error({ err, step }, "Stripe init failed — will retry; continuing without payments");
      return false;
    }
  })();

  initializationInFlight.set(mode, attempt);
  try {
    return await attempt;
  } finally {
    initializationInFlight.delete(mode);
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
  // The mode is read STRICTLY, every pass, before anything is skipped. A mode
  // whose refusal is deterministic cannot change answer without an environment
  // change, so it is skipped below — but only once the stored mode is known to
  // be that mode. This pass used to skip first on the lenient cached read, to
  // save the row read: `bustConfigCache()` runs only in the process that made a
  // toggle, so after a toggle committed by ANOTHER instance this process's cache
  // still named the refused mode, and every pass returned early until the cache
  // expired (#577 harvest, deferred gap 2). One uncached row read per retry
  // interval, only while the loop is armed, is the cost of reading the truth.
  // The timer stays ARMED on a refused mode so a toggle away can still recover.
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
  if (!completed) logger.warn({ mode }, "Stripe initialization did not complete — keeping the retry armed");

  // The timer stops only once the mode stored NOW has its setup complete — not
  // the mode this pass started on. One timer serves both modes, and every arm
  // request made while it exists is a no-op, so its existence has to mean "the
  // stored mode is owed". Stopping on THIS pass's success (#653 round 2) let a
  // switch landing mid-pass — a remote toggle the detector saw, or a local one
  // whose own setup failed — be absorbed by the armed timer and then discarded
  // when the old mode finished. Stopping on verification alone, before that,
  // made a transient webhook failure permanent.
  //
  // Two checks, because the read is asynchronous: the stored mode's completion,
  // and that no arm request arrived while it was being read. An unreadable mode
  // keeps the timer, which is the safe answer.
  const signalsBefore = owedSetupSignals;
  let storedNow: boolean;
  try {
    storedNow = await readStripeLiveModeStrict();
  } catch (err) {
    logger.warn({ err }, "Stripe retry: the stored mode is unreadable — keeping the retry armed");
    return;
  }
  if (hasStripeInitializationCompleted(storedNow) && owedSetupSignals === signalsBefore) {
    stopStripeVerificationRetry();
  } else if (completed) {
    logger.info({ mode }, "Stripe setup complete for this pass's mode; another is still owed — keeping the retry armed");
  }
}

/**
 * Bumped by every arm request, including the ones absorbed because a timer
 * already exists. The retry pass compares it across its final mode read, so a
 * request that lands during that read keeps the timer rather than being lost.
 */
let owedSetupSignals = 0;

/** Test seam: whether the retry loop is currently armed. */
export function __isStripeVerificationRetryArmedForTests(): boolean {
  return retryTimer !== null;
}

function armStripeVerificationRetry(): void {
  owedSetupSignals++;
  if (retryTimer) return;
  retryTimer = setInterval(() => {
    void runStripeVerificationRetryOnce().catch((err: unknown) =>
      logger.error({ err }, "Stripe verification retry pass threw"),
    );
  }, VERIFY_RETRY_INTERVAL_MS);
  retryTimer.unref?.();
}

/**
 * Make sure something is scheduled to finish the stored mode's verification
 * AND its required setup, when this process notices that mode is active.
 *
 * Round 5's case, and it is specific to autoscale: when ANOTHER instance
 * commits a mode toggle, this process may have nothing scheduled for the newly
 * active mode — a normally successful boot has already stopped its retry timer,
 * or never armed one. The Billing poll only reads a pure getter, so it would
 * report the mode as pending (or verified with no webhook) indefinitely while
 * nothing was in transit.
 *
 * The early return is a statement that nothing is LEFT to do, and it used to
 * be the wrong one: "verification was ever attempted for this mode". Verifying
 * and finishing setup are different facts, so two states slipped through it
 * (#653 round 1) — a mode verified whose setup failed or was interrupted, after
 * a completed setup for the other mode had stopped the shared timer; and a mode
 * a refused local toggle probe left `pending` without the row ever naming it.
 * Either one, switched back to remotely, never got its webhook until restart.
 * Now the only states that return are: setup complete for this mode, or a
 * recorded outcome a retry cannot change (`refused`, `unconfigured`).
 *
 * Everything else arms the retry loop. The immediate pass is kicked only when
 * THIS call armed the timer: the Billing poll runs every few seconds while the
 * state is unsettled, and must not become the retry cadence — an armed timer
 * already owns that. The pass itself verifies (a memo hit when already
 * verified), resumes setup, and stops the timer only once the mode then stored
 * has its setup complete.
 */
export function ensureVerificationArmedFor(liveMode: boolean | null): void {
  // A mode that cannot be read is not a mode that can be verified. That is an
  // indefinite answer the caller already renders as pending with its own
  // reason, and it recovers through the read, not through this.
  if (liveMode === null) return;
  if (hasStripeInitializationCompleted(liveMode)) return;
  if (hasVerificationAttemptFor(liveMode)) {
    const { state } = getVerificationStatus(liveMode, "");
    if (state === "refused" || state === "unconfigured") return;
  }

  const timerWasArmed = retryTimer !== null;
  armStripeVerificationRetry();
  if (timerWasArmed) return;

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
 * Run the required setup for the mode now stored, and arm the retry loop if it
 * does not complete. Used by a verified boot and by the mode toggle once its
 * write has committed — the toggle is the moment a mode this process may never
 * have initialized becomes the active one.
 *
 * The loop is armed on failure because a webhook registration that fails
 * transiently would otherwise leave the integration half-initialized with
 * nothing scheduled to finish it.
 */
export function startStripeInitializationForActiveMode(): void {
  void resumeStripeInitialization().then((completed) => {
    if (!completed) armStripeVerificationRetry();
  });
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
    startStripeInitializationForActiveMode();
    return;
  }
  if (outcome.kind === "pending") {
    armStripeVerificationRetry();
  }
}
