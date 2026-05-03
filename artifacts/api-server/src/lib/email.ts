/**
 * Email delivery via Resend.
 * Requires RESEND_API_KEY. RESEND_FROM_EMAIL overrides the default sender.
 * When the key is absent, emails are logged to stdout (development fallback).
 *
 * Production mode: sendEmail() inserts into the email_outbox table and returns
 * immediately. The outbox worker (runEmailOutboxWorker) polls every 30 seconds,
 * claims pending rows, calls Resend, and retries on failure using exponential
 * backoff (5m → 30m → 2h → 8h). After maxAttempts the row is marked abandoned.
 *
 * Brand: dark bg (#0d0d0e), danger orange (#FF3C00), Oswald + Inter typography.
 */
import { Resend } from "resend";
import { eq, and, or, lte, lt, asc, not, like, isNull } from "drizzle-orm";
import { db as defaultDb } from "@workspace/db";
import { emailOutboxTable, type EmailOutboxRow } from "@workspace/db/schema";
import { getConfigString, getConfigInt } from "./adminConfig";
import { getSiteBaseUrl } from "./siteUrl";
import { logger } from "./logger";
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

export function isEnabled(): boolean {
  return !!process.env.RESEND_API_KEY;
}

let resend: Resend | null = null;
if (isEnabled()) {
  resend = new Resend(process.env.RESEND_API_KEY!);
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

export async function sendEmail(
  payload: EmailPayload & { kind?: string },
  dbOverride?: Pick<typeof defaultDb, "insert">,
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
  const dbInstance = dbOverride ?? defaultDb;
  await dbInstance.insert(emailOutboxTable).values({
    to:      payload.to,
    subject: payload.subject,
    text:    payload.text,
    html:    payload.html ?? null,
    kind:    payload.kind ?? null,
  });
}

/**
 * Retry delay schedule (in ms). Index = attempt number after the failure.
 * Attempt 1 (first try fails) → 5 min, attempt 2 → 30 min, etc.
 * Index 0 means "immediate" — used for the very first attempt.
 */
export const RETRY_DELAYS_MS = [0, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 8 * 3_600_000];

/**
 * Actually call the Resend API for a single outbox row.
 * Never throws — returns { ok, error } instead.
 */
export async function deliverFromOutbox(
  row: Pick<EmailOutboxRow, "to" | "subject" | "text" | "html">,
): Promise<{ ok: boolean; error?: string }> {
  if (resendAuthDisabled) {
    return {
      ok: false,
      error: "Resend disabled this process: invalid RESEND_API_KEY (HTTP 401). Restart after rotating the key.",
    };
  }
  const from    = await getFromAddress();
  const replyTo = await getReplyToAddress();
  try {
    const { error } = await resend!.emails.send({
      to:      row.to,
      from,
      ...(replyTo ? { replyTo } : {}),
      subject: row.subject,
      text:    row.text,
      html:    row.html ?? row.text,
    });
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
      return { ok: false, error: String(error.message) };
    }
    return { ok: true };
  } catch (err) {
    if (isResendAuthError(err)) {
      resendAuthDisabled = true;
      console.error(
        "[email] Resend rejected RESEND_API_KEY (HTTP 401 / authentication error). " +
        "Disabling email delivery for the rest of this process. " +
        "Rotate the key in environment secrets and restart the server. " +
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

type DbWithTransaction = Pick<typeof defaultDb, "transaction" | "delete">;
type DeliverFn = (row: Pick<EmailOutboxRow, "to" | "subject" | "text" | "html">) => Promise<{ ok: boolean; error?: string }>;

/**
 * Reads the live retry schedule from admin config, falling back to RETRY_DELAYS_MS.
 * Called once per tick so config changes take effect within the next 60s cache window.
 */
async function getRetryConfig(): Promise<{ maxAttempts: number; retryDelays: number[] }> {
  const [maxAttempts, d1, d2, d3, d4] = await Promise.all([
    getConfigInt("email_max_attempts",      5),
    getConfigInt("email_retry_delay_1_ms",  RETRY_DELAYS_MS[1]!),
    getConfigInt("email_retry_delay_2_ms",  RETRY_DELAYS_MS[2]!),
    getConfigInt("email_retry_delay_3_ms",  RETRY_DELAYS_MS[3]!),
    getConfigInt("email_retry_delay_4_ms",  RETRY_DELAYS_MS[4]!),
  ]);
  return { maxAttempts, retryDelays: [0, d1, d2, d3, d4] };
}

/**
 * Delete delivered and abandoned rows older than `email_outbox_retention_days` days.
 * Returns the number of rows deleted. A retention value of 0 or less disables purging.
 * Exported for unit tests.
 */
export async function purgeTerminalEmailRows(
  dbInstance: Pick<typeof defaultDb, "delete">,
  now: Date = new Date(),
  excludeKindPrefix?: string,
): Promise<number> {
  const retentionDays = await getConfigInt("email_outbox_retention_days", 30);
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 3_600_000);
  const deleted = await dbInstance
    .delete(emailOutboxTable)
    .where(
      and(
        or(
          eq(emailOutboxTable.status, "delivered"),
          eq(emailOutboxTable.status, "abandoned"),
        ),
        lt(emailOutboxTable.createdAt, cutoff),
        excludeKindPrefix
          ? or(
              isNull(emailOutboxTable.kind),
              not(like(emailOutboxTable.kind, `${excludeKindPrefix}%`)),
            )
          : undefined,
      ),
    )
    .returning({ id: emailOutboxTable.id });
  return deleted.length;
}

/**
 * Process one tick of the email outbox worker.
 * Exported for unit tests so they can inject a fake DB and delivery function.
 */
export async function emailOutboxTick(
  dbInstance: DbWithTransaction,
  deliverFn: DeliverFn,
  now: Date = new Date(),
  excludeKindPrefix?: string,
): Promise<void> {
  const { maxAttempts, retryDelays } = await getRetryConfig();

  await dbInstance.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(emailOutboxTable)
      .where(and(
        eq(emailOutboxTable.status, "pending"),
        lte(emailOutboxTable.nextAttemptAt, now),
      ))
      .orderBy(asc(emailOutboxTable.nextAttemptAt), asc(emailOutboxTable.id))
      .limit(10)
      .for("update", { skipLocked: true });

    for (const row of rows) {
      await tx.update(emailOutboxTable)
        .set({ status: "sending", updatedAt: new Date() })
        .where(eq(emailOutboxTable.id, row.id));

      const { ok, error } = await deliverFn(row);
      const newAttempts = row.attempts + 1;

      if (ok) {
        await tx.update(emailOutboxTable)
          .set({ status: "delivered", attempts: newAttempts, updatedAt: new Date() })
          .where(eq(emailOutboxTable.id, row.id));
      } else {
        const abandoned = newAttempts >= maxAttempts;
        // If we have more retries to go but have exhausted the per-slot schedule,
        // repeat the last configured delay so extra attempts aren't silently dropped.
        const scheduledDelay = retryDelays[newAttempts];
        const delayMs = scheduledDelay ?? retryDelays[retryDelays.length - 1] ?? 0;
        await tx.update(emailOutboxTable)
          .set({
            status:        abandoned ? "abandoned" : "pending",
            attempts:      newAttempts,
            lastError:     error ?? "unknown",
            nextAttemptAt: abandoned ? new Date() : new Date(Date.now() + delayMs),
            updatedAt:     new Date(),
          })
          .where(eq(emailOutboxTable.id, row.id));

        if (abandoned) {
          logger.error(
            { outboxId: row.id, to: row.to, subject: row.subject, error },
            "Email permanently abandoned after max retries",
          );
          if (row.kind !== "admin_abandoned_email_alert") {
            // Lazy dynamic import to break the email <-> adminNotify circular
            // dependency. See the import-block comment at top of this file.
            void import("./adminNotify").then(({ notifyAdminsOfAbandonedEmail }) =>
              notifyAdminsOfAbandonedEmail({
                outboxId: row.id,
                to: row.to,
                subject: row.subject,
                lastError: error ?? "unknown",
              }),
            );
          }
        }
      }
    }
  });

  await purgeTerminalEmailRows(dbInstance, now, excludeKindPrefix);
}

/**
 * On startup: reset any rows stuck in 'sending' (crash mid-delivery) back to
 * 'pending' so they will be retried by the next worker tick.
 * Rows are only reset if they have been in 'sending' for longer than cutoffMinutes.
 */
export async function recoverStuckSendingRows(
  dbInstance: Pick<typeof defaultDb, "update">,
  cutoffMinutes = 5,
): Promise<void> {
  if (!isEnabled()) return;
  const cutoff = new Date(Date.now() - cutoffMinutes * 60_000);
  await dbInstance.update(emailOutboxTable)
    .set({ status: "pending", updatedAt: new Date() })
    .where(and(
      eq(emailOutboxTable.status, "sending"),
      lt(emailOutboxTable.updatedAt, cutoff),
    ));
}

/**
 * Start the email outbox background worker.
 * Polls every `intervalMs` milliseconds (default 30s) and delivers pending rows.
 * Should be called once on server startup.
 */
export function runEmailOutboxWorker(intervalMs = 30_000): NodeJS.Timeout {
  if (!isEnabled()) {
    logger.info("Email outbox worker skipped — RESEND_API_KEY not set");
    const noop = setInterval(() => { /* no-op */ }, intervalMs);
    noop.unref();
    return noop;
  }

  recoverStuckSendingRows(defaultDb).catch((err) => {
    logger.error({ err }, "Email outbox: startup recovery failed");
  });

  const tick = async () => {
    try {
      await emailOutboxTick(defaultDb, deliverFromOutbox);
    } catch (err) {
      logger.error({ err }, "Email outbox worker tick failed");
    }
  };

  const handle = setInterval(() => void tick(), intervalMs);
  handle.unref();
  return handle;
}

/**
 * Wraps email body content in the Overhype.me branded shell.
 *
 * Typography: Oswald (headers) + Inter (body) loaded via Google Fonts.
 * Outlook ignores web fonts and falls back to Impact / system sans-serif, which
 * still looks intentional at this weight.
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
  <!--[if !mso]><!-->
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Oswald:wght@600;700&display=swap');
  </style>
  <!--<![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#0d0d0e;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0d0d0e">
    <tr>
      <td align="center" style="padding:48px 16px 40px;">

        <!-- ═══════════════════════════════════════════
             STUB LOGO
             Replace with a hosted <img> when ready.
             ═══════════════════════════════════════════ -->
        <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
          <tr>
            <td bgcolor="#FF3C00" style="padding:8px 16px 10px;">
              <span style="font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:22px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#ffffff;mso-font-alt:'Impact';">OVERHYPE</span><span style="font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:22px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#000000;mso-font-alt:'Impact';">.ME</span>
            </td>
          </tr>
        </table>

        <!-- ═══════════════════════════════════════════
             CARD
             ═══════════════════════════════════════════ -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;" bgcolor="#161618">
          <!-- Top accent bar -->
          <tr>
            <td height="4" bgcolor="#FF3C00" style="font-size:0;line-height:0;mso-line-height-rule:exactly;">&nbsp;</td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:36px 40px 40px;border-left:1px solid #2a2a2a;border-right:1px solid #2a2a2a;border-bottom:1px solid #2a2a2a;">
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
              <p style="margin:0;font-size:11px;color:#444444;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">
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

/** Renders an orange CTA button compatible with most email clients. */
export function ctaButton(href: string, label: string): string {
  return `<table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;">
  <tr>
    <td align="center" bgcolor="#FF3C00">
      <a href="${href}" target="_blank" style="display:inline-block;padding:14px 36px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:15px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#ffffff;text-decoration:none;mso-font-alt:'Impact';">${label}</a>
    </td>
  </tr>
</table>`;
}

/** Renders the small "Or copy this link" fallback block. */
function linkFallback(url: string): string {
  return `<p style="margin:0 0 4px;font-size:11px;color:#555555;font-family:'Inter',-apple-system,sans-serif;">Or copy this link into your browser:</p>
<p style="margin:0 0 28px;font-size:11px;color:#555555;word-break:break-all;line-height:1.6;font-family:'Inter',-apple-system,sans-serif;">${url}</p>`;
}

/** Renders a hairline divider. */
export function divider(): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;"><tr><td height="1" bgcolor="#222222" style="font-size:0;line-height:0;mso-line-height-rule:exactly;">&nbsp;</td></tr></table>`;
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
<h1 style="margin:0 0 16px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">Your Legend<br/>Begins Here.</h1>
<p style="margin:0 0 10px;font-size:15px;color:#aaaaaa;line-height:1.75;">Before we add you to the database of greatness, we need to verify that you're actually you. (Or a reasonable facsimile. We're&nbsp;not&nbsp;picky.)</p>
<p style="margin:0 0 32px;font-size:15px;color:#aaaaaa;line-height:1.75;">Hit the button. This link expires in <strong style="color:#ffffff;">24&nbsp;hours</strong>&nbsp;— unlike your legend, which is&nbsp;forever.</p>
${ctaButton(verifyUrl, "Verify My Email")}
${linkFallback(verifyUrl)}
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Didn't sign up? Someone may be trying to use your email address. Just ignore this and carry&nbsp;on.</p>`;

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
<h1 style="margin:0 0 16px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">Confirm Your<br/>New Email.</h1>
<p style="margin:0 0 10px;font-size:15px;color:#aaaaaa;line-height:1.75;">You requested to change your Overhype.me email address&nbsp;to:</p>
<p style="margin:0 0 28px;font-size:16px;font-weight:600;color:#ffffff;word-break:break-all;">${pendingEmail}</p>
<p style="margin:0 0 32px;font-size:15px;color:#aaaaaa;line-height:1.75;">Click the button to lock it in. This link is valid for <strong style="color:#ffffff;">24&nbsp;hours</strong>.</p>
${ctaButton(verifyUrl, "Confirm New Email")}
${linkFallback(verifyUrl)}
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Didn't request this change? Ignore it — your current email address will remain&nbsp;unchanged.</p>`;

  const html = buildEmailShell(
    body,
    "You&#39;re receiving this because an email change was requested on your Overhype.me account.",
  );

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
<h1 style="margin:0 0 16px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">Forgot Your<br/>Password?</h1>
<p style="margin:0 0 10px;font-size:15px;color:#aaaaaa;line-height:1.75;">It happens to the best of us. Even legends have off&nbsp;days.</p>
<p style="margin:0 0 32px;font-size:15px;color:#aaaaaa;line-height:1.75;">Click the button to set a new password. This link expires in <strong style="color:#ffffff;">1&nbsp;hour</strong>, so don't sit on&nbsp;it.</p>
${ctaButton(resetUrl, "Reset My Password")}
${linkFallback(resetUrl)}
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Didn't request a password reset? Ignore this — your password will not&nbsp;change.</p>`;

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
    ? `<p style="margin:0 0 28px;font-size:13px;color:#888888;line-height:1.7;border-left:3px solid #2a2a2a;padding-left:14px;"><strong style="color:#aaaaaa;">Note from the team:</strong> ${opts.adminNote}</p>`
    : "";

  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">It&#39;s Official,<br/>${opts.username}.</h1>
<p style="margin:0 0 24px;font-size:15px;color:#aaaaaa;line-height:1.75;">Your submitted fact has been reviewed and approved. The database grows stronger.</p>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 28px;">
  <tr>
    <td style="border-left:4px solid #FF3C00;padding:12px 16px;background:#1c1c1e;">
      <p style="margin:0;font-size:15px;color:#dddddd;line-height:1.7;font-style:italic;">${opts.submittedText}</p>
    </td>
  </tr>
</table>
${adminNoteHtml}
${ctaButton(factUrl, "View Your Fact")}
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Keep submitting. Every legend needs&nbsp;material.</p>`;

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
    ? `<p style="margin:0 0 28px;font-size:13px;color:#888888;line-height:1.7;border-left:3px solid #2a2a2a;padding-left:14px;"><strong style="color:#aaaaaa;">Note from the team:</strong> ${opts.adminNote}</p>`
    : "";

  const body = `
<h1 style="margin:0 0 16px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">Not Every Legend<br/>Makes the Cut.</h1>
<p style="margin:0 0 24px;font-size:15px;color:#aaaaaa;line-height:1.75;">Hey <strong style="color:#ffffff;">${opts.username}</strong> — after review, we weren&#39;t able to add this one to the&nbsp;database.</p>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 28px;">
  <tr>
    <td style="border-left:4px solid #555555;padding:12px 16px;background:#1c1c1e;">
      <p style="margin:0;font-size:15px;color:#888888;line-height:1.7;font-style:italic;">${opts.submittedText}</p>
    </td>
  </tr>
</table>
${reasonHtml}${adminNoteHtml}
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Don&#39;t sweat it. Greatness takes practice. Keep&nbsp;submitting.</p>`;

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
<h1 style="margin:0 0 16px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">${safeFrom} You&#39;re<br/>Legendary.</h1>
<p style="margin:0 0 10px;font-size:15px;color:#aaaaaa;line-height:1.75;">They&#39;ve set up a personalised Overhype.me experience just for <strong style="color:#ffffff;">${safeName}</strong> — a community-driven database of epic facts about real people.</p>
<p style="margin:0 0 32px;font-size:15px;color:#aaaaaa;line-height:1.75;">Your link is already loaded with your name and pronouns. When you open it, you&#39;ll see the world through&nbsp;your&nbsp;lens.</p>
${ctaButton(shareUrl, "See My Facts")}
${linkFallback(shareUrl)}
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">Not sure what Overhype.me is? <a href="${siteUrl}" target="_blank" style="color:#FF3C00;text-decoration:none;">Find out here.</a> If you didn&#39;t expect this, you can safely ignore&nbsp;it.</p>`;

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
<h1 style="margin:0 0 16px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">Confirm Your<br/>Renewal.</h1>
<p style="margin:0 0 16px;font-size:15px;color:#aaaaaa;line-height:1.75;">Your bank is asking us to verify your renewal payment before it can settle (SCA / 3D Secure). Until you confirm, your <strong style="color:#ffffff;">Legendary</strong>&nbsp;access is at risk of&nbsp;lapsing.</p>
${amountHtml}
${ctaButton(opts.hostedInvoiceUrl, "Confirm Payment")}
${linkFallback(opts.hostedInvoiceUrl)}
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">You&#39;re receiving this because your bank requested additional verification on your Overhype.me renewal.</p>`;

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
<h1 style="margin:0 0 16px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">Card On File<br/>Updated.</h1>
<p style="margin:0 0 16px;font-size:15px;color:#aaaaaa;line-height:1.75;">Your card network sent us refreshed details for <strong style="color:#ffffff;">${safeCard}</strong>.</p>
<p style="margin:0 0 24px;font-size:15px;color:#aaaaaa;line-height:1.75;">No action required — your Legendary renewals will continue uninterrupted.</p>
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">If you didn&#39;t expect this update, manage billing from your Overhype.me profile.</p>`;

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
<h1 style="margin:0 0 16px;font-family:'Oswald','Impact','Arial Narrow',sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;line-height:1.2;mso-font-alt:'Impact';">Renewal<br/>Coming Up.</h1>
<p style="margin:0 0 24px;font-size:15px;color:#aaaaaa;line-height:1.75;">Your ${planLabel}<strong style="color:#ffffff;">Legendary</strong> subscription is about to&nbsp;renew.</p>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 28px;background:#1c1c1e;">
  <tr>
    <td style="padding:14px 16px;border-left:4px solid #FF3C00;">
      <p style="margin:0 0 6px;font-size:11px;color:#777777;font-family:'Inter',-apple-system,sans-serif;text-transform:uppercase;letter-spacing:1px;">Amount</p>
      <p style="margin:0 0 ${dateLabel ? "18" : "0"}px;font-size:18px;font-weight:700;color:#ffffff;font-family:'Oswald','Impact','Arial Narrow',sans-serif;mso-font-alt:'Impact';">${formattedAmount}</p>
      ${dateHtml}
    </td>
  </tr>
</table>
<p style="margin:0 0 24px;font-size:15px;color:#aaaaaa;line-height:1.75;">If your card needs updating or you&#39;d like to cancel, manage billing from your Overhype.me profile before the charge runs.</p>
${divider()}
<p style="margin:0;font-size:12px;color:#555555;line-height:1.7;font-family:'Inter',-apple-system,sans-serif;">You&#39;re receiving this renewal reminder because you have an active Overhype.me Legendary subscription.</p>`;

  const html = buildEmailShell(
    body,
    "You&#39;re receiving this because you have an active Overhype.me Legendary subscription.",
  );
  return { subject, text, html };
}
