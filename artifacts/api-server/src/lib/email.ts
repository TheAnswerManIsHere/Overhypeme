/**
 * Email delivery via Resend.
 * Requires RESEND_API_KEY. RESEND_FROM_EMAIL overrides the default sender.
 * When the key is absent, emails are logged to stdout (development fallback).
 *
 * Production mode: sendEmail() enqueues a row in the shared `async_jobs`
 * table (queue "email") and returns immediately. The email queue is processed by
 * the async-jobs worker's `bulk` lane (runAsyncJobsWorker, started in index.ts),
 * whose default poll interval is 5 seconds; it claims pending rows, dispatches by
 * queue to the registered handler (this file registers `"email"` →
 * emailJobHandler), and applies the standard retry + abandon flow. The handler retains all the email-specific behaviors that
 * existed before: Resend-401 process-wide disable, abandoned-email admin
 * alert, retention exclusion for the alert thread itself.
 *
 * Never twice (Issue #1000 increment 3, plan §E): each job freezes the message
 * it will send and records its sending state on the job (`payload.delivery`),
 * and every send carries a no-duplicate key Resend honours for 24 hours. A job
 * resumed after a server stop resends with the same key, finishes without
 * sending, or, when a duplicate can no longer be ruled out, is marked failed
 * for a person (Q14: 2). See `emailJobHandler`.
 *
 * Brand: dark bg (#0d0d0e), danger orange (BRAND_ORANGE), Oswald + Inter typography.
 */
import { randomUUID } from "node:crypto";
import { BRAND_ORANGE } from "@workspace/api-zod";
import { Resend } from "resend";
import { eq, sql } from "drizzle-orm";
import { db as defaultDb } from "@workspace/db";
import { asyncJobsTable, type AsyncJobRow } from "@workspace/db/schema";
import { getConfigString, getConfigInt } from "./adminConfig";
import { getSiteBaseUrl } from "./siteUrl";
import { logger } from "./logger";
import {
  enqueueJob,
  registerJobHandler,
  terminalFailure,
  type ClaimedJobRow,
  type HandlerResult,
  type JobHandler,
} from "./asyncJobs";
import { fencedTransaction } from "./jobFence";
// NOTE: Do NOT add a static import of ./adminNotify here. adminNotify imports
// sendEmail from this file, so a static import would create a circular module
// dependency. With ESM + top-level await anywhere in the bundled graph, esbuild
// turns module init into async wrappers that deadlock on the cycle (Node exit
// code 13: "Detected unsettled top-level await"). Use a lazy dynamic import
// inside the function body instead — see notifyAdminsOfAbandonedEmail call below.
// The validate-no-cycles script (pnpm --filter @workspace/api-server run check:cycles)
// will fail CI if a static import is reintroduced.

async function getFromAddress(): Promise<string> {
  return getConfigString("email_from_address", process.env.RESEND_FROM_EMAIL ?? "legends@overhype.me");
}

async function getReplyToAddress(): Promise<string | undefined> {
  const v = await getConfigString("email_reply_to", "overhypeme+support@gmail.com");
  return v.trim() || undefined;
}

function getResendApiKey(): string | undefined {
  const isProd = process.env.NODE_ENV === "production";
  // Use || rather than ?? so that empty-string values (e.g. RESEND_API_KEY_DEV="")
  // are treated as absent and the next key in the chain is tried.
  return isProd
    ? (process.env.RESEND_API_KEY_PROD || process.env.RESEND_API_KEY || undefined)
    : (process.env.RESEND_API_KEY_DEV || process.env.RESEND_API_KEY_PROD || process.env.RESEND_API_KEY || undefined);
}

/**
 * The message the delivery layer hands to whatever sends it: the shape of
 * Resend's `emails.send` argument, which is the one real transport.
 */
export interface OutgoingEmail {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
}

/** What a transport reports back — the subset of Resend's response we read. */
export interface EmailTransportResult {
  /** Resend's id for the accepted email. */
  data?: { id?: string } | null;
  error?: { message: unknown; name?: unknown; statusCode?: unknown } | null;
}

/** Per-send options: the subset of Resend's `emails.send` options we use. */
export interface EmailSendOptions {
  /** Sent as Resend's `Idempotency-Key` header: a repeat within 24 h is not sent again. */
  idempotencyKey?: string;
}

export interface EmailTransport {
  send(message: OutgoingEmail, options?: EmailSendOptions): Promise<EmailTransportResult>;
}

/**
 * The one transport this process sends through, or null when none is
 * configured: Resend when a key was present at load, or the transport a test
 * harness installed. `isEnabled()`, the worker's `unavailableReason` and the
 * send itself all read this one value, so no path can consult the key and miss
 * the harness (or the reverse).
 *
 * The harness install happens only through `installEmailTransportForTestHarness`,
 * which only `src/testing/productionModeLauncher.ts` calls: the deployment
 * entrypoint (`index.ts`) has no path to it, and `testHarnessIsolation.test.ts`
 * fails if any other module references the installer.
 */
let transport: EmailTransport | null = getResendApiKey() ? new Resend(getResendApiKey()!).emails : null;

/**
 * Replace the email transport for this process, below the email queue: the
 * enqueue, the worker's claim and the job handler all still run, and only the
 * final send goes to `transport` instead of Resend. Refuses a second install and
 * an install after a Resend client was already built from a real key, so a
 * harness can never end up sending part of a run through the real vendor.
 */
export function installEmailTransportForTestHarness(harnessTransport: EmailTransport): void {
  if (transport) {
    throw new Error(
      "[email] refusing to install a test-harness transport: this process already has one " +
        "(a Resend API key is configured, or a harness transport was installed)",
    );
  }
  transport = harnessTransport;
}

export function isEnabled(): boolean {
  return transport !== null;
}

/**
 * Set to true once Resend returns an authentication error (HTTP 401 / invalid
 * key). Subsequent calls short-circuit so we don't spam the API or trigger
 * follow-on logger.error calls that have, in the past, killed the process via
 * a broken pino-pretty transport. The flag lives for the lifetime of the
 * process — restarting the server (e.g. after rotating RESEND_API_KEY) clears
 * it. Outbox rows return ok:false and remain pending so they retry once the
 * key is fixed.
 *
 * Exported for tests to reset between runs.
 */
let resendAuthDisabled = false;
const RESEND_DISABLED_ERROR =
  "Resend disabled this process: invalid RESEND_API_KEY (HTTP 401). Restart after rotating the key.";
export function _resetResendAuthDisabledForTests(): void {
  resendAuthDisabled = false;
}

interface MaybeResendError {
  message?: unknown;
  name?: unknown;
  statusCode?: unknown;
}

function isResendAuthError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as MaybeResendError;
  if (e.statusCode === 401) return true;
  const name = typeof e.name === "string" ? e.name.toLowerCase() : "";
  if (name.includes("auth") || name.includes("api_key") || name === "restricted_api_key") {
    return true;
  }
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (msg.includes("api key is invalid") || msg.includes("invalid api key") || msg.includes("missing api key")) {
    return true;
  }
  return false;
}

export interface EmailPayload {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Internal payload shape stored in `async_jobs.payload` for queue "email".
 * Mirrors the legacy email_outbox row columns.
 */
export interface EmailJobPayload {
  to: string;
  subject: string;
  text: string;
  html?: string | null;
  kind?: string | null;
  /** The job's sending record (plan §E). Absent on a job an earlier release enqueued. */
  delivery?: EmailDelivery;
}

/**
 * Where one email job stands with Resend (plan §E). Kept on the job's payload,
 * written only through fenced updates, so the job row is its one home.
 *
 * - `unsent`: no send has been attempted by a run that records here.
 * - `possibly_sent`: a send was attempted (from `firstDispatchAt`); it may
 *   have reached Resend. Every later attempt resends the same message with the
 *   same key, which Resend delivers once while the key lives (24 h).
 * - `sent`: Resend accepted it (`providerId`).
 *
 * Written only by a release that keeps it (one that declares email's recovery
 * protocol), so an `unsent` record is trusted only when the claim before this
 * one came from such a release (`unsentIsTrustworthy`), or a person approved
 * the resend from the email queue (`resendApproved`).
 */
export interface EmailDelivery {
  v: 1;
  /** Mixed into the no-duplicate key, so job ids reused across databases never collide at Resend. */
  nonce: string;
  /** The resolved message, frozen before the first possible send. */
  message?: OutgoingEmail;
  state: "unsent" | "possibly_sent" | "sent";
  firstDispatchAt?: string;
  providerId?: string | null;
  /** Set by the email queue's Retry: a person chose to send it, whatever happened before. */
  resendApproved?: boolean;
}

/** A fresh sending record: nothing sent, a new nonce (so a new no-duplicate key). */
function newDelivery(message?: OutgoingEmail): EmailDelivery {
  return { v: 1, nonce: randomUUID(), ...(message ? { message } : {}), state: "unsent" };
}

/**
 * The email queue's Retry, as a row update (`routes/admin.ts`): the sending
 * record goes back to unsent under a fresh nonce, keeping its frozen message,
 * and is marked as a person's choice to send, so the handler sends it even
 * when it would otherwise hold it back (Q14: 2). The row goes back
 * `recovering`, requiring email's protocol, in the same update: a person
 * approved one more send by this release, never a send by an earlier release
 * that keeps no record and would leave the approval standing (PR #1026 round 1).
 */
export function emailRetryReset() {
  return {
    status: "recovering" as const,
    recoveryProtocol: EMAIL_RECOVERY_PROTOCOL,
    payload: sql`jsonb_set(
      ${asyncJobsTable.payload},
      '{delivery}',
      (COALESCE(${asyncJobsTable.payload}->'delivery', '{}'::jsonb) - 'firstDispatchAt' - 'providerId')
        || jsonb_build_object('v', 1, 'nonce', ${randomUUID()}::text, 'state', 'unsent', 'resendApproved', true)
    )`,
  };
}

/** The recovery protocol the email handler implements (plan §A). */
export const EMAIL_RECOVERY_PROTOCOL = 1;

/** How long Resend keeps an idempotency key (its documentation: "kept in the system for 24 hours"). */
export const EMAIL_IDEMPOTENCY_WINDOW_MS = 24 * 3_600_000;

/** The no-duplicate key every attempt of one job sends with: the job id and the record's nonce. */
export function emailIdempotencyKey(jobId: number, nonce: string): string {
  return `overhype-email-${jobId}-${nonce}`;
}

/** Resolve the outgoing message from a job's payload and the current sender settings. */
async function resolveOutgoingMessage(ep: Pick<EmailJobPayload, "to" | "subject" | "text" | "html">): Promise<OutgoingEmail> {
  const [from, replyTo] = await Promise.all([getFromAddress(), getReplyToAddress()]);
  return {
    to: ep.to,
    from,
    ...(replyTo ? { replyTo } : {}),
    subject: ep.subject,
    text: ep.text,
    html: ep.html ?? ep.text,
  };
}

export async function sendEmail(
  payload: EmailPayload & { kind?: string },
  dbOverride?: Pick<typeof defaultDb, "insert">,
  // Whether the outbox row is written under the test key. Defaults to "an
  // override was passed" (the original opt-in); a caller passing a
  // transaction for atomicity, not to exercise insertion, says false (#868).
  opts: { insertUnderTestKey?: boolean } = {},
): Promise<void> {
  if (!isEnabled()) {
    const from = await getFromAddress();
    const replyTo = await getReplyToAddress();
    logger.info(
      {
        to: payload.to,
        from,
        replyTo,
        subject: payload.subject,
        body: payload.text,
      },
      "[email] Resend not configured — would have sent",
    );
    return;
  }
  // If the resolved API key starts with "re_test_" this is a test run using a
  // dummy key (the test runner sets RESEND_API_KEY="re_test_dummy" while
  // clearing the real dev/prod vars).  Skip the outbox insert unless the
  // caller explicitly supplies a dbOverride — without this guard the shared
  // async_jobs would accumulate test rows that the running dev-server's
  // worker would attempt to deliver with the real API key.
  const insertUnderTestKey = opts.insertUnderTestKey ?? dbOverride !== undefined;
  if (!insertUnderTestKey && (getResendApiKey()?.startsWith("re_test_") ?? false)) {
    logger.info(
      { to: payload.to, subject: payload.subject },
      "[email] test key detected — outbox insert suppressed (pass dbOverride to exercise insertion in tests)",
    );
    return;
  }
  const base = {
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html ?? null,
  };
  const jobPayload: EmailJobPayload = {
    ...base,
    kind: payload.kind ?? null,
    // Frozen at enqueue (plan §E): a sender setting changed between attempts
    // cannot make a retry differ from the first send, which Resend would
    // refuse under the same key. The top-level fields stay for the email
    // queue page and for an earlier release still running beside this one.
    delivery: newDelivery(await resolveOutgoingMessage(base)),
  };
  await enqueueJob(
    { queue: "email", payload: jobPayload as unknown as Record<string, unknown> },
    dbOverride,
  );
}

/**
 * Actually call the Resend API for a single email payload.
 * Never throws — returns { ok, error } instead.
 */
export async function deliverFromOutbox(
  row: Pick<EmailJobPayload, "to" | "subject" | "text" | "html">,
): Promise<SendOutcome> {
  if (resendAuthDisabled) return { ok: false, error: RESEND_DISABLED_ERROR };
  return sendMessage(await resolveOutgoingMessage(row));
}

interface SendOutcome { ok: boolean; error?: string; errorName?: string; providerId?: string }

/** Send one resolved message, with a no-duplicate key when given one. Never throws. */
async function sendMessage(message: OutgoingEmail, idempotencyKey?: string): Promise<SendOutcome> {
  if (resendAuthDisabled) return { ok: false, error: RESEND_DISABLED_ERROR };
  try {
    const { data, error } = await transport!.send(message, idempotencyKey ? { idempotencyKey } : undefined);
    if (error) {
      if (isResendAuthError(error)) {
        resendAuthDisabled = true;
        // Use console.error rather than the pino logger here. The crash this
        // file is guarding against was triggered when a Resend 401 caused a
        // logger.error() write to a dead pino-pretty worker thread, so we
        // deliberately avoid the pino path on this fatal-config error.
        console.error(
          "[email] Resend rejected RESEND_API_KEY (HTTP 401 / authentication error). " +
          "Disabling email delivery for the rest of this process. " +
          "Rotate the key in environment secrets and restart the server. " +
          `Error: ${String(error.message)}`,
        );
      }
      return { ok: false, error: String(error.message), errorName: typeof error.name === "string" ? error.name : undefined };
    }
    return { ok: true, providerId: data?.id ?? undefined };
  } catch (err) {
    if (isResendAuthError(err)) {
      resendAuthDisabled = true;
      logger.error(
        { err },
        "[email] Resend rejected RESEND_API_KEY (HTTP 401 / authentication error). " +
        "Disabling email delivery for the rest of this process. " +
        "Rotate the key in environment secrets and restart the server.",
      );
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Email job handler. Registered against the shared async-jobs worker for the
 * `"email"` queue. Preserves every email-specific behavior the old dedicated
 * worker had:
 *   - Resend 401 disables delivery process-wide.
 *   - Abandoned (max-retries) emails fire an admin alert email (unless the
 *     row IS the admin alert itself).
 *   - Retention purge skips rows whose `kind` starts with
 *     "admin_abandoned_email_alert" so the alert thread isn't auto-deleted.
 */
export const emailJobHandler: JobHandler = {
  // The one answer to "can email be delivered now": a Resend key, or a
  // test-harness transport. The worker defers the row otherwise.
  unavailableReason(): string | null {
    return isEnabled() ? null : "Email delivery is not configured; leaving job pending";
  },

  async run(payload: unknown, row: ClaimedJobRow): Promise<HandlerResult> {
    const ep = payload as EmailJobPayload;
    if (!isEnabled()) {
      // The dev-fallback path: pretend success so the row terminates as done.
      logger.info({ to: ep.to, subject: ep.subject }, "[email] Resend not configured — skipping delivery");
      return { ok: true };
    }
    if (typeof row?.id !== "number") {
      // Called directly, not as a job (a harness probe): nothing to record against.
      const { ok, error } = await deliverFromOutbox(ep);
      return ok ? { ok: true } : { ok: false, error: error ?? "unknown" };
    }
    return runEmailJob(ep, row);
  },

  async onAbandon(row: AsyncJobRow): Promise<void> {
    const ep = row.payload as EmailJobPayload;
    // Don't recurse — never alert about a failed admin alert email.
    if (ep.kind === "admin_abandoned_email_alert") return;
    const alertsEnabled = await getConfigString("email_admin_abandoned_alerts_enabled", "false");
    if (alertsEnabled !== "true") return;
    // Lazy dynamic import to break the email <-> adminNotify circular
    // dependency (see import-block comment at top of file).
    void import("./adminNotify").then(({ notifyAdminsOfAbandonedEmail }) =>
      notifyAdminsOfAbandonedEmail({
        outboxId: row.id,
        to: ep.to,
        subject: ep.subject,
        lastError: row.lastError ?? "unknown",
      }),
    );
  },

  retainDuringPurge(row: AsyncJobRow): boolean {
    const ep = row.payload as EmailJobPayload | null;
    return ep?.kind?.startsWith("admin_abandoned_email_alert") === true;
  },

  async retentionDaysOverride(): Promise<number | undefined> {
    return getConfigInt("email_outbox_retention_days", 30);
  },
};

/**
 * Merge fields into the job's sending record, fenced: a run that lost its
 * claim writes nothing. `replace` drops whatever the record held first.
 */
async function writeDelivery(jobId: number, fields: Partial<EmailDelivery>, replace = false): Promise<void> {
  const base = replace ? sql`'{}'::jsonb` : sql`COALESCE(${asyncJobsTable.payload}->'delivery', '{}'::jsonb)`;
  await fencedTransaction(defaultDb, (tx) => tx
    .update(asyncJobsTable)
    .set({ payload: sql`jsonb_set(${asyncJobsTable.payload}, '{delivery}', ${base} || ${JSON.stringify(fields)}::jsonb)` })
    .where(eq(asyncJobsTable.id, jobId)));
}

/**
 * Whether an `unsent` record (or none) can be trusted to mean nothing was
 * sent. This release records a possible send before it can happen, so the
 * record is complete whenever the previous claim came from a worker that
 * declares email's recovery. Any other previous claim — an earlier release's,
 * or a worker's from before leases — may have sent it with no key; with no
 * previous claim, it is trusted only if nothing at all happened to the row.
 */
function unsentIsTrustworthy(prior: EmailDelivery | undefined, row: ClaimedJobRow): boolean {
  if (prior?.resendApproved) return true;
  const previous = row.previousClaimRecoveryProtocol ?? null;
  if (previous !== null && previous >= EMAIL_RECOVERY_PROTOCOL) return true;
  return row.attempts === 0 && row.recoveryProtocol == null;
}

/** The email job proper (plan §E), for a run that holds a claim. */
async function runEmailJob(ep: EmailJobPayload, row: ClaimedJobRow): Promise<HandlerResult> {
  const prior = ep.delivery;

  if (prior?.state === "sent") {
    // Resend accepted it before the run that sent it could finish the job.
    logger.info({ id: row.id, providerId: prior.providerId }, "[email] already sent — finishing without sending again");
    return { ok: true, result: { providerId: prior.providerId ?? null } };
  }

  if (prior?.state === "possibly_sent") {
    // A missing or unreadable time is NaN, which counts as outside the window.
    const withinKeyWindow = Date.now() - Date.parse(prior.firstDispatchAt ?? "") < EMAIL_IDEMPOTENCY_WINDOW_MS;
    if (!withinKeyWindow) {
      // Q14: 2 — the key no longer protects a resend.
      logger.warn({ id: row.id, firstDispatchAt: prior.firstDispatchAt }, "[email] possibly sent more than 24 h ago — marked failed rather than risk a duplicate");
      return terminalFailure(
        "email_duplicate_unprotected",
        "This email may already have been sent more than 24 hours ago, when duplicate protection lapsed; it was not sent again. Retry it from the email queue to send it anyway.",
      );
    }
  } else if (!unsentIsTrustworthy(prior, row)) {
    // Q14: 2 — an earlier release may have sent it with no key.
    logger.warn({ id: row.id, attempts: row.attempts }, "[email] may have been sent by an earlier release without duplicate protection — marked failed");
    return terminalFailure(
      "email_possibly_sent_without_key",
      "An earlier version of the server may already have sent this email without duplicate protection; it was not sent again. Retry it from the email queue to send it anyway.",
    );
  }

  // Nothing is sent and nothing recorded: the record stays `unsent`, and the
  // retry (this release's, as every email retry is) trusts it.
  if (resendAuthDisabled) return { ok: false, error: RESEND_DISABLED_ERROR };

  // Freeze the message and record the possible send BEFORE it can happen.
  const record: EmailDelivery = {
    ...(prior ?? newDelivery()),
    message: prior?.message ?? await resolveOutgoingMessage(ep),
    state: "possibly_sent",
    firstDispatchAt: prior?.firstDispatchAt ?? new Date().toISOString(),
    providerId: null,
    resendApproved: false,
  };
  await writeDelivery(row.id, record, true);
  if (prior?.state === "possibly_sent") {
    logger.info({ id: row.id, firstDispatchAt: prior.firstDispatchAt }, "[email] resending with the same no-duplicate key after an interrupted or failed attempt");
  }

  const sent = await sendMessage(record.message!, emailIdempotencyKey(row.id, record.nonce));
  if (sent.ok) {
    // If this write is refused (the claim moved on), the successor resends with
    // the same key and Resend answers without sending again.
    await writeDelivery(row.id, { state: "sent", providerId: sent.providerId ?? null });
    return { ok: true, result: { providerId: sent.providerId ?? null } };
  }
  if (sent.errorName === "invalid_idempotent_request") {
    // Same key, different message: cannot happen with a frozen message, and retrying cannot fix it.
    return terminalFailure("email_idempotency_conflict", sent.error ?? "Resend refused the no-duplicate key");
  }
  // It may have reached Resend; the queue's `retriesRecover` keeps the retry
  // with workers that resend under the key.
  return { ok: false, error: sent.error ?? "unknown" };
}

/**
 * Register the email handler with the shared async-jobs worker. Called once
 * from index.ts before `runAsyncJobsWorker()` starts.
 */
export function registerEmailHandler(): void {
  registerJobHandler("email", emailJobHandler, {
    // One send of seconds; 5 min ends only a wedged one (Q15). Any attempt, a
    // run ended at its limit included, may have reached Resend, so every retry
    // stays with workers that resend under the key (retriesRecover).
    executionLimitMs: 5 * 60_000,
    recoveryProtocol: EMAIL_RECOVERY_PROTOCOL,
    fastReclaim: true,
    retriesRecover: true,
  });
}

/**
 * Brand palette for transactional / notification emails. Single source of
 * truth so every template inherits the same warm amber-orange (matches the
 * site's `--primary: hsl(24 100% 50%)`) and the same surface tones for the
 * card, callout blocks, dividers and footer text.
 */
export const EMAIL_COLORS = {
  primary: BRAND_ORANGE,
  page: "#0d0d0e",
  card: "#161618",
  cardBorder: "#2a2a2a",
  callout: "#1f1f22",
  calloutAccentMuted: "#3a3a3a",
  divider: "#2a2a2a",
  body: "#aaaaaa",
  label: "#888888",
  footer: "#888888",
  heading: "#ffffff",
} as const;

/**
 * Wraps email body content in the Overhype.me branded shell.
 *
 * Typography: Oswald (headers) + Inter (body) loaded via Google Fonts.
 * Many clients (Outlook, Gmail) ignore web fonts, so the display stack falls
 * back through condensed system faces: Arial Narrow (Windows with Office, Mac),
 * Roboto Condensed (Android), then Helvetica Neue / Arial. Every font in the
 * stack has a real bold face. Never add a single-weight font such as Impact:
 * a bold request makes the client synthesise a fake bold that smears the
 * glyphs (Outlook on Windows, 2026-11-06). Guarded by
 * emailDisplayFontWeight.test.ts.
 *
 * STUB LOGO: The header currently renders the brand name as styled text.
 * Once a hosted logo image is available, replace the stub block with:
 *   <img src="https://overhype.me/images/logo.png" width="48" height="48" alt="Overhype.me" style="display:block;" />
 */
export function buildEmailShell(bodyContent: string, footerNote: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <!-- Dark-only palette: tell mail clients not to apply their own dark-mode
       transform, or they invert these already-dark colors into a light email. -->
  <meta name="color-scheme" content="dark" />
  <meta name="supported-color-schemes" content="dark" />
  <!--[if !mso]><!-->
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Oswald:wght@600;700&display=swap');
    :root { color-scheme: dark; supported-color-schemes: dark; }
  </style>
  <!--<![endif]-->
</head>
<body style="margin:0;padding:0;background-color:${EMAIL_COLORS.page};font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${EMAIL_COLORS.page}">
    <tr>
      <td align="center" style="padding:48px 16px 40px;">

        <!-- ═══════════════════════════════════════════
             STUB LOGO — single-color wordmark on rounded
             orange tile. Replace with a hosted <img> when ready.
             ═══════════════════════════════════════════ -->
        <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
          <tr>
            <td bgcolor="${EMAIL_COLORS.primary}" style="padding:10px 22px 12px;border-radius:10px;">
              <span style="font-family:'Oswald','Arial Narrow','Roboto Condensed','sans-serif-condensed','Helvetica Neue',Arial,sans-serif;font-size:22px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#ffffff;mso-font-alt:'Arial Narrow';">OVERHYPE.ME</span>
            </td>
          </tr>
        </table>

        <!-- ═══════════════════════════════════════════
             CARD
             ═══════════════════════════════════════════ -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;border-radius:16px;overflow:hidden;" bgcolor="${EMAIL_COLORS.card}">
          <!-- Top accent bar -->
          <tr>
            <td height="4" bgcolor="${EMAIL_COLORS.primary}" style="font-size:0;line-height:0;mso-line-height-rule:exactly;">&nbsp;</td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:36px 40px 40px;border-left:1px solid ${EMAIL_COLORS.cardBorder};border-right:1px solid ${EMAIL_COLORS.cardBorder};border-bottom:1px solid ${EMAIL_COLORS.cardBorder};border-bottom-left-radius:16px;border-bottom-right-radius:16px;">
              ${bodyContent}
            </td>
          </tr>
        </table>

        <!-- ═══════════════════════════════════════════
             FOOTER NOTE
             ═══════════════════════════════════════════ -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
          <tr>
            <td style="padding:20px 4px 0;" align="center">
              <p style="margin:0;font-size:12px;color:${EMAIL_COLORS.footer};line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">
                ${footerNote}
              </p>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Renders the primary orange CTA button. Designed to mirror the homepage's
 * primary button: rounded corners, generous padding, near-full-width inside
 * the email card. Uses a VML rounded-rect for Outlook (which ignores CSS
 * border-radius) and a styled anchor for every other client.
 */
export function ctaButton(href: string, label: string): string {
  return `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 28px;">
  <tr>
    <td align="center">
      <!--[if mso]>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:52px;v-text-anchor:middle;width:440px;" arcsize="22%" stroke="f" fillcolor="${EMAIL_COLORS.primary}">
        <w:anchorlock/>
        <center style="color:#ffffff;font-family:'Arial Narrow',Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${label}</center>
      </v:roundrect>
      <![endif]-->
      <!--[if !mso]><!-- -->
      <a href="${href}" target="_blank" style="display:block;width:100%;max-width:440px;background-color:${EMAIL_COLORS.primary};border-radius:12px;padding:16px 28px;font-family:'Oswald','Arial Narrow','Roboto Condensed','sans-serif-condensed','Helvetica Neue',Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#ffffff;text-decoration:none;text-align:center;box-sizing:border-box;mso-font-alt:'Arial Narrow';">${label}</a>
      <!--<![endif]-->
    </td>
  </tr>
</table>`;
}

/** Renders the small "Or copy this link" fallback block. */
function linkFallback(url: string): string {
  return `<p style="margin:0 0 4px;font-size:11px;color:${EMAIL_COLORS.label};font-family:'Inter',-apple-system,sans-serif;">Or copy this link into your browser:</p>
<p style="margin:0 0 28px;font-size:11px;color:${EMAIL_COLORS.label};word-break:break-all;line-height:1.6;font-family:'Inter',-apple-system,sans-serif;">${url}</p>`;
}

/** Renders a hairline divider. */
export function divider(): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;"><tr><td height="1" bgcolor="${EMAIL_COLORS.divider}" style="font-size:0;line-height:0;mso-line-height-rule:exactly;">&nbsp;</td></tr></table>`;
}

export function buildEmailVerificationEmail(verifyUrl: string): Pick<EmailPayload, "subject" | "text" | "html"> {
  const subject = "Verify your email — Overhype.me";

  const text = [
    "YOUR LEGEND BEGINS HERE.",
    "",
    "Before we add you to the database of greatness, we need to verify that",
    "you're actually you. (Or a reasonable facsimile. We're not picky.)",
    "",
    "Verify your email here — link valid for 24 hours:",
    verifyUrl,
    "",
    "Didn't sign up? Ignore this and carry on.",
    "",
    "— The Overhype.me Team",
  ].join("\n");

  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Arial Narrow','Roboto Condensed','sans-serif-condensed','Helvetica Neue',Arial,sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Arial Narrow';">Your Legend<br/>Begins Here.</h1>
<p style="margin:0 0 10px;font-size:15px;color:#aaaaaa;line-height:1.75;">Before we add you to the database of greatness, we need to verify that you're actually you. (Or a reasonable facsimile. We're&nbsp;not&nbsp;picky.)</p>
<p style="margin:0 0 32px;font-size:15px;color:#aaaaaa;line-height:1.75;">Hit the button. This link expires in <strong style="color:#ffffff;">24&nbsp;hours</strong>&nbsp;— unlike your legend, which is&nbsp;forever.</p>
${ctaButton(verifyUrl, "Verify My Email")}
${linkFallback(verifyUrl)}
${divider()}
<p style="margin:0;font-size:12px;color:#888888;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Didn't sign up? Someone may be trying to use your email address. Just ignore this and carry&nbsp;on.</p>`;

  const html = buildEmailShell(
    body,
    "You&#39;re receiving this because someone created an account with this email address on Overhype.me.",
  );

  return { subject, text, html };
}

export function buildEmailChangeVerificationEmail(pendingEmail: string, verifyUrl: string): Pick<EmailPayload, "subject" | "text" | "html"> {
  const subject = "Confirm your new email address — Overhype.me";

  const text = [
    "CONFIRM YOUR NEW EMAIL.",
    "",
    `You requested to change your Overhype.me email address to: ${pendingEmail}`,
    "",
    "Confirm the change here — link valid for 24 hours:",
    verifyUrl,
    "",
    "Didn't request this? Ignore it. Your current email stays put.",
    "",
    "— The Overhype.me Team",
  ].join("\n");

  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Arial Narrow','Roboto Condensed','sans-serif-condensed','Helvetica Neue',Arial,sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Arial Narrow';">Confirm Your<br/>New Email.</h1>
<p style="margin:0 0 10px;font-size:15px;color:#aaaaaa;line-height:1.75;">You requested to change your Overhype.me email address&nbsp;to:</p>
<p style="margin:0 0 28px;font-size:16px;font-weight:600;color:#ffffff;word-break:break-all;">${pendingEmail}</p>
<p style="margin:0 0 32px;font-size:15px;color:#aaaaaa;line-height:1.75;">Click the button to lock it in. This link is valid for <strong style="color:#ffffff;">24&nbsp;hours</strong>.</p>
${ctaButton(verifyUrl, "Confirm New Email")}
${linkFallback(verifyUrl)}
${divider()}
<p style="margin:0;font-size:12px;color:#888888;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Didn't request this change? Ignore it — your current email address will remain&nbsp;unchanged.</p>`;

  const html = buildEmailShell(
    body,
    "You&#39;re receiving this because an email change was requested on your Overhype.me account.",
  );

  return { subject, text, html };
}

/** The long date an account deletion email names, in UTC so it reads the same everywhere. */
function deletionDate(when: Date): string {
  return when.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/**
 * Sent when an account deletion is accepted (launch Phase 5, plan S14): what
 * happens on which date, and how to keep the account. Facts stay, credited to
 * a former member; the copy never promises that no copy remains (S15).
 */
export function buildAccountDeletionScheduledEmail(purgeAfter: Date, keepUrl: string): Pick<EmailPayload, "subject" | "text" | "html"> {
  const date = deletionDate(purgeAfter);
  const subject = "Your Overhype.me account is scheduled for deletion";
  const text = [
    "YOUR ACCOUNT IS SCHEDULED FOR DELETION.",
    "",
    `On ${date} your account, your memes, photos and images are removed from Overhype.me for good.`,
    "Facts, comments and suggestions you submitted stay on the site, credited to a former member. Your votes and hearts stay in the totals without your name.",
    "Until then you are signed out everywhere and your memes, photos and images are hidden.",
    "",
    "Changed your mind? Sign in before that date and choose Keep my account:",
    keepUrl,
    "",
    "Didn't ask for this? Sign in and keep your account, then change your password.",
    "",
    "— The Overhype.me Team",
  ].join("\n");
  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Arial Narrow','Roboto Condensed','sans-serif-condensed','Helvetica Neue',Arial,sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Arial Narrow';">Your Account Is<br/>Scheduled For Deletion</h1>
<p style="margin:0 0 10px;font-size:15px;color:#aaaaaa;line-height:1.75;">On <strong style="color:#ffffff;">${date}</strong> your account, your memes, photos and images are removed from Overhype.me for&nbsp;good. Facts, comments and suggestions you submitted stay on the site, credited to a former&nbsp;member. Your votes and hearts stay in the totals without your&nbsp;name.</p>
<p style="margin:0 0 32px;font-size:15px;color:#aaaaaa;line-height:1.75;">Until then you are signed out everywhere and your memes, photos and images are hidden. Changed your mind? Sign in before that date and keep your&nbsp;account.</p>
${ctaButton(keepUrl, "Keep My Account")}
${linkFallback(keepUrl)}
${divider()}
<p style="margin:0;font-size:12px;color:#888888;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Didn't ask for this? Sign in, keep your account, then change your&nbsp;password.</p>`;
  const html = buildEmailShell(body, "You&#39;re receiving this because deletion was requested for your Overhype.me account.");
  return { subject, text, html };
}

/** Sent when a sign-up that was never finished is scheduled for deletion (David, answer 6): why, when, and how to keep it. */
export function buildUnfinishedAccountDeletionEmail(purgeAfter: Date, keepUrl: string): Pick<EmailPayload, "subject" | "text" | "html"> {
  const date = deletionDate(purgeAfter);
  const subject = "Your unfinished Overhype.me account will be deleted";
  const text = [
    "YOU NEVER FINISHED SETTING UP YOUR ACCOUNT.",
    "",
    "You started an Overhype.me account more than 30 days ago and never finished setting it up.",
    `On ${date} we delete it.`,
    "",
    "Want to keep it? Sign in before that date, choose Keep my account, then finish setting up:",
    keepUrl,
    "",
    "Didn't sign up? Ignore this email and the account goes on its own.",
    "",
    "— The Overhype.me Team",
  ].join("\n");
  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Arial Narrow','Roboto Condensed','sans-serif-condensed','Helvetica Neue',Arial,sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Arial Narrow';">You Never Finished<br/>Setting Up</h1>
<p style="margin:0 0 10px;font-size:15px;color:#aaaaaa;line-height:1.75;">You started an Overhype.me account more than 30 days ago and never finished setting it up. On <strong style="color:#ffffff;">${date}</strong> we delete&nbsp;it.</p>
<p style="margin:0 0 32px;font-size:15px;color:#aaaaaa;line-height:1.75;">Want to keep it? Sign in before that date, keep your account, then finish setting&nbsp;up.</p>
${ctaButton(keepUrl, "Keep My Account")}
${linkFallback(keepUrl)}
${divider()}
<p style="margin:0;font-size:12px;color:#888888;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Didn't sign up? Ignore this email and the account goes on its&nbsp;own.</p>`;
  const html = buildEmailShell(body, "You&#39;re receiving this because an Overhype.me account was started with this address and never finished.");
  return { subject, text, html };
}

/** Sent when a scheduled account deletion is cancelled: the account and its content are back. */
export function buildAccountDeletionCancelledEmail(siteUrl: string, opts: { unfinished?: boolean } = {}): Pick<EmailPayload, "subject" | "text" | "html"> {
  const subject = "Your Overhype.me account is staying";
  // An unfinished sign-up has nothing to bring back; it has set-up to finish.
  const onboardUrl = `${siteUrl.replace(/\/$/, "")}/onboard`;
  const line = opts.unfinished
    ? "The deletion is cancelled. Finish setting up your account to start using it."
    : "The deletion is cancelled. Your memes, photos and images are back where they were.";
  const text = [
    "YOUR ACCOUNT IS STAYING.",
    "",
    line,
    opts.unfinished ? onboardUrl : siteUrl,
    "",
    "— The Overhype.me Team",
  ].join("\n");
  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Arial Narrow','Roboto Condensed','sans-serif-condensed','Helvetica Neue',Arial,sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Arial Narrow';">Your Account<br/>Is Staying</h1>
<p style="margin:0 0 32px;font-size:15px;color:#aaaaaa;line-height:1.75;">${line.replace(/ (\S+)\.$/, "&nbsp;$1.")}</p>
${opts.unfinished ? ctaButton(onboardUrl, "Finish Setting Up") : ctaButton(siteUrl, "Back To Overhype.me")}`;
  const html = buildEmailShell(body, "You&#39;re receiving this because a deletion of your Overhype.me account was cancelled.");
  return { subject, text, html };
}

export function buildPasswordResetEmail(resetUrl: string): Pick<EmailPayload, "subject" | "text" | "html"> {
  const subject = "Reset your password — Overhype.me";

  const text = [
    "FORGOT YOUR PASSWORD? IT HAPPENS TO THE BEST OF US.",
    "",
    "Click the link below to set a new password. This link is valid for 1 hour.",
    resetUrl,
    "",
    "Didn't request this? Ignore it. Your password won't change.",
    "",
    "— The Overhype.me Team",
  ].join("\n");

  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Arial Narrow','Roboto Condensed','sans-serif-condensed','Helvetica Neue',Arial,sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Arial Narrow';">Forgot Your<br/>Password?</h1>
<p style="margin:0 0 10px;font-size:15px;color:#aaaaaa;line-height:1.75;">It happens to the best of us. Even legends have off&nbsp;days.</p>
<p style="margin:0 0 32px;font-size:15px;color:#aaaaaa;line-height:1.75;">Click the button to set a new password. This link expires in <strong style="color:#ffffff;">1&nbsp;hour</strong>, so don't sit on&nbsp;it.</p>
${ctaButton(resetUrl, "Reset My Password")}
${linkFallback(resetUrl)}
${divider()}
<p style="margin:0;font-size:12px;color:#888888;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Didn't request a password reset? Ignore this — your password will not&nbsp;change.</p>`;

  const html = buildEmailShell(
    body,
    "You&#39;re receiving this because a password reset was requested for your Overhype.me account.",
  );

  return { subject, text, html };
}

export function buildReviewApprovedEmail(opts: {
  username: string;
  submittedText: string;
  factId: number;
  adminNote?: string | null;
}): Pick<EmailPayload, "subject" | "text" | "html"> {
  const factUrl = `${getSiteBaseUrl()}/facts/${opts.factId}`;
  const subject = "Your Overhype.me fact has been approved!";

  const text = [
    `IT'S OFFICIAL, ${opts.username.toUpperCase()}.`,
    "",
    "Your submitted fact has been reviewed and approved. The database grows stronger.",
    "",
    `"${opts.submittedText}"`,
    ...(opts.adminNote ? ["", `Admin note: ${opts.adminNote}`] : []),
    "",
    `View it here: ${factUrl}`,
    "",
    "— The Overhype.me Team",
  ].join("\n");

  const adminNoteHtml = opts.adminNote
    ? `<p style="margin:0 0 28px;font-size:13px;color:#888888;line-height:1.7;border-left:3px solid #3a3a3a;padding-left:14px;"><strong style="color:#aaaaaa;">Note from the team:</strong> ${opts.adminNote}</p>`
    : "";

  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Arial Narrow','Roboto Condensed','sans-serif-condensed','Helvetica Neue',Arial,sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Arial Narrow';">It&#39;s Official,<br/>${opts.username}.</h1>
<p style="margin:0 0 24px;font-size:15px;color:#aaaaaa;line-height:1.75;">Your submitted fact has been reviewed and approved. The database grows stronger.</p>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 28px;">
  <tr>
    <td style="border-left:4px solid ${BRAND_ORANGE};padding:12px 16px;background:#1f1f22;border-radius:10px;">
      <p style="margin:0;font-size:15px;color:#dddddd;line-height:1.7;font-style:italic;">${opts.submittedText}</p>
    </td>
  </tr>
</table>
${adminNoteHtml}
${ctaButton(factUrl, "View Your Fact")}
${divider()}
<p style="margin:0;font-size:12px;color:#888888;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Keep submitting. Every legend needs&nbsp;material.</p>`;

  const html = buildEmailShell(
    body,
    "You&#39;re receiving this because you submitted a fact on Overhype.me.",
  );

  return { subject, text, html };
}

const REJECTION_REASON_LABELS: Record<string, string> = {
  duplicate: "Duplicate — this fact is too similar to one already in the database.",
  spam: "Spam — this submission doesn't meet our community guidelines.",
  offensive: "Offensive — this fact contains content that violates our standards.",
  lame: "Lame — this fact just didn't have the energy we're looking for.",
  visual: "Couldn't make it work visually — we couldn't turn this one into a picture that does it justice.",
};

export function buildReviewRejectedEmail(opts: {
  username: string;
  submittedText: string;
  adminNote?: string | null;
  rejectionReason?: string | null;
}): Pick<EmailPayload, "subject" | "text" | "html"> {
  const subject = "Update on your submitted Overhype.me fact";
  const reasonLabel = opts.rejectionReason ? REJECTION_REASON_LABELS[opts.rejectionReason] : null;

  const text = [
    `HEY ${opts.username.toUpperCase()}, NOT EVERY LEGEND MAKES THE CUT.`,
    "",
    "After review, we weren't able to add this one to the database.",
    "",
    `"${opts.submittedText}"`,
    ...(reasonLabel ? ["", `Reason: ${reasonLabel}`] : []),
    ...(opts.adminNote ? ["", `Note from the team: ${opts.adminNote}`] : []),
    "",
    "Don't sweat it. Keep submitting — greatness takes practice.",
    "",
    "— The Overhype.me Team",
  ].join("\n");

  const reasonHtml = reasonLabel
    ? `<p style="margin:0 0 20px;font-size:13px;color:#aaaaaa;line-height:1.7;"><strong style="color:#ffffff;">Reason:</strong> ${reasonLabel}</p>`
    : "";

  const adminNoteHtml = opts.adminNote
    ? `<p style="margin:0 0 28px;font-size:13px;color:#888888;line-height:1.7;border-left:3px solid #3a3a3a;padding-left:14px;"><strong style="color:#aaaaaa;">Note from the team:</strong> ${opts.adminNote}</p>`
    : "";

  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Arial Narrow','Roboto Condensed','sans-serif-condensed','Helvetica Neue',Arial,sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Arial Narrow';">Not Every Legend<br/>Makes the Cut.</h1>
<p style="margin:0 0 24px;font-size:15px;color:#aaaaaa;line-height:1.75;">Hey <strong style="color:#ffffff;">${opts.username}</strong> — after review, we weren&#39;t able to add this one to the&nbsp;database.</p>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 28px;">
  <tr>
    <td style="border-left:4px solid #3a3a3a;padding:12px 16px;background:#1f1f22;border-radius:10px;">
      <p style="margin:0;font-size:15px;color:#888888;line-height:1.7;font-style:italic;">${opts.submittedText}</p>
    </td>
  </tr>
</table>
${reasonHtml}${adminNoteHtml}
${divider()}
<p style="margin:0;font-size:12px;color:#888888;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Don&#39;t sweat it. Greatness takes practice. Keep&nbsp;submitting.</p>`;

  const html = buildEmailShell(
    body,
    "You&#39;re receiving this because you submitted a fact on Overhype.me.",
  );

  return { subject, text, html };
}

export function buildShareInviteEmail(
  recipientName: string,
  shareUrl: string,
  senderName: string | null,
): Pick<EmailPayload, "subject" | "text" | "html"> {
  const fromPhrase = senderName ? `${senderName} thinks` : "Someone thinks";
  const subject = `${fromPhrase} you deserve to be hyped`;

  const text = [
    `${fromPhrase.toUpperCase()} YOU'RE LEGENDARY.`,
    "",
    `They've set up a personalized experience just for you at Overhype.me —`,
    `a community-driven database of epic facts about real people.`,
    "",
    `Your personalised link (${recipientName}'s edition):`,
    shareUrl,
    "",
    "— The Overhype.me Team",
  ].join("\n");

  const siteUrl = getSiteBaseUrl();

  const safeFrom = fromPhrase.replace(/'/g, "&#39;");
  const safeName = recipientName.replace(/</g, "&lt;");

  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Arial Narrow','Roboto Condensed','sans-serif-condensed','Helvetica Neue',Arial,sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Arial Narrow';">${safeFrom} You&#39;re<br/>Legendary.</h1>
<p style="margin:0 0 10px;font-size:15px;color:#aaaaaa;line-height:1.75;">They&#39;ve set up a personalised Overhype.me experience just for <strong style="color:#ffffff;">${safeName}</strong> — a community-driven database of epic facts about real people.</p>
<p style="margin:0 0 32px;font-size:15px;color:#aaaaaa;line-height:1.75;">Your link is already loaded with your name and pronouns. When you open it, you&#39;ll see the world through&nbsp;your&nbsp;lens.</p>
${ctaButton(shareUrl, "See My Facts")}
${linkFallback(shareUrl)}
${divider()}
<p style="margin:0;font-size:12px;color:#888888;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Not sure what Overhype.me is? <a href="${siteUrl}" target="_blank" style="color:${BRAND_ORANGE};text-decoration:none;">Find out here.</a> If you didn&#39;t expect this, you can safely ignore&nbsp;it.</p>`;

  const html = buildEmailShell(
    body,
    "You&#39;re receiving this because someone shared Overhype.me with you.",
  );

  return { subject, text, html };
}

function formatMoney(amountMinor: number, currency: string): string {
  const upperCurrency = currency.toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: upperCurrency,
    }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${upperCurrency}`;
  }
}

function formatDate(unixSeconds: number): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(new Date(unixSeconds * 1000));
  } catch {
    return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
  }
}

/**
 * Sent when Stripe fires `invoice.payment_action_required`. The customer's bank
 * is asking for SCA / 3DS confirmation before the renewal can settle. Failure to
 * complete will lapse Legendary access at the next billing attempt.
 */
export function buildSCAActionRequiredEmail(opts: {
  hostedInvoiceUrl: string;
  amountMinor?: number | null;
  currency?: string | null;
}): Pick<EmailPayload, "subject" | "text" | "html"> {
  const subject = "Action required: confirm your renewal — Overhype.me";
  const amountLine =
    opts.amountMinor != null && opts.currency
      ? `Amount: ${formatMoney(opts.amountMinor, opts.currency)}`
      : "";

  const text = [
    "ACTION REQUIRED — CONFIRM YOUR RENEWAL.",
    "",
    "Your bank is asking us to verify your renewal payment (SCA/3DS).",
    "Until you confirm, your Legendary access is at risk of lapsing.",
    ...(amountLine ? ["", amountLine] : []),
    "",
    "Confirm here:",
    opts.hostedInvoiceUrl,
    "",
    "— The Overhype.me Team",
  ].join("\n");

  const amountHtml =
    opts.amountMinor != null && opts.currency
      ? `<p style="margin:0 0 24px;font-size:15px;color:#aaaaaa;line-height:1.75;">Amount due: <strong style="color:#ffffff;">${formatMoney(opts.amountMinor, opts.currency)}</strong></p>`
      : "";

  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Arial Narrow','Roboto Condensed','sans-serif-condensed','Helvetica Neue',Arial,sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Arial Narrow';">Confirm Your<br/>Renewal.</h1>
<p style="margin:0 0 16px;font-size:15px;color:#aaaaaa;line-height:1.75;">Your bank is asking us to verify your renewal payment before it can settle (SCA / 3D Secure). Until you confirm, your <strong style="color:#ffffff;">Legendary</strong>&nbsp;access is at risk of&nbsp;lapsing.</p>
${amountHtml}
${ctaButton(opts.hostedInvoiceUrl, "Confirm Payment")}
${linkFallback(opts.hostedInvoiceUrl)}
${divider()}
<p style="margin:0;font-size:12px;color:#888888;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">You&#39;re receiving this because your bank requested additional verification on your Overhype.me renewal.</p>`;

  const html = buildEmailShell(
    body,
    "You&#39;re receiving this because your bank requested additional verification on your Overhype.me renewal.",
  );
  return { subject, text, html };
}

/**
 * Sent when Stripe fires `payment_method.automatically_updated` — the card
 * network handed Stripe a new expiration / number for the saved card.
 */
export function buildCardAutomaticallyUpdatedEmail(opts: {
  brand?: string | null;
  last4?: string | null;
}): Pick<EmailPayload, "subject" | "text" | "html"> {
  const subject = "Your card on file was updated — Overhype.me";
  const cardLabel = opts.brand && opts.last4
    ? `${opts.brand.toUpperCase()} ending in ${opts.last4}`
    : opts.last4
      ? `card ending in ${opts.last4}`
      : "your card on file";

  const text = [
    "YOUR CARD ON FILE WAS UPDATED.",
    "",
    `Your card network sent us refreshed details for ${cardLabel}.`,
    "No action required — your Legendary renewals will continue uninterrupted.",
    "",
    "If you didn't expect this, manage billing from your profile.",
    "",
    "— The Overhype.me Team",
  ].join("\n");

  const safeCard = cardLabel.replace(/</g, "&lt;");

  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Arial Narrow','Roboto Condensed','sans-serif-condensed','Helvetica Neue',Arial,sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Arial Narrow';">Card On File<br/>Updated.</h1>
<p style="margin:0 0 16px;font-size:15px;color:#aaaaaa;line-height:1.75;">Your card network sent us refreshed details for <strong style="color:#ffffff;">${safeCard}</strong>.</p>
<p style="margin:0 0 24px;font-size:15px;color:#aaaaaa;line-height:1.75;">No action required — your Legendary renewals will continue uninterrupted.</p>
${divider()}
<p style="margin:0;font-size:12px;color:#888888;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">If you didn&#39;t expect this update, manage billing from your Overhype.me profile.</p>`;

  const html = buildEmailShell(
    body,
    "You&#39;re receiving this because your saved Overhype.me payment method was updated by the card network.",
  );
  return { subject, text, html };
}

/**
 * Sent when Stripe fires `invoice.upcoming` (~7 days before renewal). Gives the
 * customer notice so they can update their card or cancel before the charge.
 */
export function buildRenewalReminderEmail(opts: {
  amountMinor: number;
  currency: string;
  /** Unix seconds for next charge attempt; null/undefined → omitted from copy */
  nextAttemptAt?: number | null;
  /** Plan label for the body copy (e.g. "monthly", "annual") */
  plan?: string | null;
}): Pick<EmailPayload, "subject" | "text" | "html"> {
  const formattedAmount = formatMoney(opts.amountMinor, opts.currency);
  const dateLabel = opts.nextAttemptAt ? formatDate(opts.nextAttemptAt) : null;
  const planLabel = opts.plan ? `${opts.plan} ` : "";

  const subject = dateLabel
    ? `Your Overhype.me renewal — ${formattedAmount} on ${dateLabel}`
    : `Your Overhype.me renewal — ${formattedAmount}`;

  const text = [
    "RENEWAL COMING UP.",
    "",
    `Your ${planLabel}Legendary subscription renews for ${formattedAmount}${dateLabel ? ` on ${dateLabel}` : ""}.`,
    "If your card needs updating or you want to cancel, do it before the charge.",
    "",
    "Manage billing from your Overhype.me profile.",
    "",
    "— The Overhype.me Team",
  ].join("\n");

  const dateHtml = dateLabel
    ? `<p style="margin:0 0 6px;font-size:11px;color:#777777;font-family:'Inter',-apple-system,sans-serif;text-transform:uppercase;letter-spacing:1px;">Renewal date</p>
<p style="margin:0 0 18px;font-size:16px;font-weight:600;color:#ffffff;">${dateLabel}</p>`
    : "";

  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Arial Narrow','Roboto Condensed','sans-serif-condensed','Helvetica Neue',Arial,sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Arial Narrow';">Renewal<br/>Coming Up.</h1>
<p style="margin:0 0 24px;font-size:15px;color:#aaaaaa;line-height:1.75;">Your ${planLabel}<strong style="color:#ffffff;">Legendary</strong> subscription is about to&nbsp;renew.</p>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 28px;background:#1f1f22;border-radius:10px;">
  <tr>
    <td style="padding:14px 16px;border-left:4px solid ${BRAND_ORANGE};">
      <p style="margin:0 0 6px;font-size:11px;color:#777777;font-family:'Inter',-apple-system,sans-serif;text-transform:uppercase;letter-spacing:1px;">Amount</p>
      <p style="margin:0 0 ${dateLabel ? "18" : "0"}px;font-size:18px;font-weight:700;color:#ffffff;font-family:'Oswald','Arial Narrow','Roboto Condensed','sans-serif-condensed','Helvetica Neue',Arial,sans-serif;mso-font-alt:'Arial Narrow';">${formattedAmount}</p>
      ${dateHtml}
    </td>
  </tr>
</table>
<p style="margin:0 0 24px;font-size:15px;color:#aaaaaa;line-height:1.75;">If your card needs updating or you&#39;d like to cancel, manage billing from your Overhype.me profile before the charge runs.</p>
${divider()}
<p style="margin:0;font-size:12px;color:#888888;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">You&#39;re receiving this renewal reminder because you have an active Overhype.me Legendary subscription.</p>`;

  const html = buildEmailShell(
    body,
    "You&#39;re receiving this because you have an active Overhype.me Legendary subscription.",
  );
  return { subject, text, html };
}
